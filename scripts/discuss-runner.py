#!/usr/bin/env python3
"""Structured event adapter over model-duel.py for the OpenCode Discuss plugin.

Two transports are supported.

Direct mode (default): the adapter calls an OpenAI-compatible endpoint itself,
exactly as before.

Bridge mode (--bridge): the adapter owns dialogue sequencing and prompt
construction, but the host performs each generation through OpenCode's provider
configuration. Requests go out on stdout, responses come in on stdin:

  stdout  {"type":"generate","requestID":…,"side":"a","messages":[…],"maxOutputTokens":n}
  stdin   {"type":"delta","requestID":…,"text":…}
          {"type":"result","requestID":…,"text":…,"usage":{…}}
          {"type":"generation_error","requestID":…,"message":…}
          {"type":"command","command":"stop"|"topic"|"interject","text":…}

Common output events stay the same in both modes: started, message, delta,
control, transcript, error, done. Control lines may arrive as the legacy plain
text (`stop`, `topic …`, `interject …`) or as JSON commands.
"""
import argparse
import importlib.util
import json
import pathlib
import queue
import sys
import threading
import time

HERE = pathlib.Path(__file__).resolve().parent

# The plugin reads this pipe as UTF-8. Without this, Windows uses the ANSI code page
# for a redirected stdout and every Cyrillic reply arrives as replacement characters.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stdin.reconfigure(encoding="utf-8", errors="replace")


def load_engine():
    path = HERE / "model-duel.py"
    spec = importlib.util.spec_from_file_location("model_duel", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def emit(**payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def normalize_url(url: str) -> str:
    """Accept both http://host:port and http://host:port/v1; the engine appends /chat/completions."""
    cleaned = url.rstrip("/")
    return cleaned if cleaned.endswith("/v1") else cleaned + "/v1"


class Dialogue:
    """Shared state for turn sequencing and human controls."""

    def __init__(self, topic):
        self.topic = topic
        self.history = []
        self.stop = threading.Event()
        self.controls = queue.Queue()

    def apply(self, command, text=""):
        if command in ("stop", "q"):
            self.stop.set()
            emit(type="control", command="stop")
        elif command == "topic" and text.strip():
            self.topic = text.strip()
            self.history.append({"speaker": "Тема", "text": f"Новая тема: {self.topic}"})
            emit(type="control", command="topic", text=self.topic)
        elif command == "interject" and text.strip():
            self.history.append({"speaker": "Человек", "text": text.strip()})
            emit(type="control", command="interject", text=text.strip())

    def drain_controls(self):
        while True:
            try:
                command, text = self.controls.get_nowait()
            except queue.Empty:
                return
            self.apply(command, text)


class Bridge:
    """Correlated JSONL request/response channel over stdin/stdout."""

    def __init__(self, dialogue, timeout):
        self.dialogue = dialogue
        self.timeout = timeout
        self.lock = threading.Lock()
        self.responses = {}
        self.streams = {}
        self.counter = 0
        threading.Thread(target=self._reader, daemon=True).start()

    def _reader(self):
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            if line.startswith("{"):
                try:
                    message = json.loads(line)
                except json.JSONDecodeError:
                    continue
                kind = message.get("type")
                if kind == "delta":
                    callback = self.streams.get(message.get("requestID"))
                    if callback:
                        callback(message.get("text") or "")
                elif kind in ("result", "generation_error"):
                    with self.lock:
                        self.responses[message.get("requestID")] = message
                elif kind == "command":
                    self.dialogue.controls.put((message.get("command", ""), message.get("text", "")))
                continue
            first, _, rest = line.partition(" ")
            self.dialogue.controls.put((first, rest))

    def request(self, side_key, messages, max_tokens, on_delta, side_label):
        with self.lock:
            self.counter += 1
            request_id = f"req-{self.counter}"
            self.streams[request_id] = on_delta
        emit(type="generate", requestID=request_id, side=side_key, model=side_label,
             messages=messages, maxOutputTokens=max_tokens)
        deadline = time.time() + self.timeout
        try:
            while True:
                self.dialogue.drain_controls()
                if self.dialogue.stop.is_set():
                    return "cancelled", "", None
                with self.lock:
                    response = self.responses.pop(request_id, None)
                if response is not None:
                    if response.get("type") == "generation_error":
                        return "error", str(response.get("message") or "generation failed"), None
                    return "ok", str(response.get("text") or ""), response.get("usage")
                if time.time() > deadline:
                    return "timeout", f"no reply within {self.timeout}s", None
                time.sleep(0.05)
        finally:
            with self.lock:
                self.streams.pop(request_id, None)
                self.responses.pop(request_id, None)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--topic", required=True)
    parser.add_argument("--rounds", type=int, default=2)
    parser.add_argument("--a", default="local:test-model")
    parser.add_argument("--b", default="deepseek:deepseek-flash")
    parser.add_argument("--max-tokens", type=int, default=1200)
    parser.add_argument("--temperature", type=float, default=0.8)
    parser.add_argument("--out-dir", default="transcripts")
    parser.add_argument("--debate", action="store_true")
    parser.add_argument("--critical", action="store_true")
    parser.add_argument("--a-url", default=None, help="override the base URL of side A")
    parser.add_argument("--b-url", default=None, help="override the base URL of side B")
    parser.add_argument("--a-name", default=None, help="display name for side A in bridge mode")
    parser.add_argument("--b-name", default=None, help="display name for side B in bridge mode")
    parser.add_argument("--stream", action="store_true", help="emit delta events while a reply is written")
    parser.add_argument("--bridge", action="store_true", help="ask the host to generate each turn")
    parser.add_argument("--turn-timeout", type=float, default=120.0)
    args = parser.parse_args()

    engine = load_engine()

    def bridge_side(spec, name):
        # The host owns provider authentication and routing; the adapter only needs
        # an identity to label turns and a display name for the prompt.
        provider, _, model = spec.partition(":")
        return {"spec": spec, "name": name or model or spec, "kind": "bridge",
                "model": spec, "provider": provider}

    if args.bridge:
        sides = [bridge_side(args.a, args.a_name), bridge_side(args.b, args.b_name)]
    else:
        sides = [engine.parse_side(args.a), engine.parse_side(args.b)]
        if args.a_url:
            sides[0]["url"] = normalize_url(args.a_url)
        if args.b_url:
            sides[1]["url"] = normalize_url(args.b_url)
    emit(type="started", a=sides[0]["name"], b=sides[1]["name"], topic=args.topic,
         rounds=args.rounds, models=[args.a, args.b], bridge=bool(args.bridge))

    dialogue = Dialogue(args.topic)

    def reader():
        for line in sys.stdin:
            first, _, rest = line.strip().partition(" ")
            dialogue.controls.put((first, rest))

    bridge = Bridge(dialogue, args.turn_timeout) if args.bridge else None
    if bridge is None:
        threading.Thread(target=reader, daemon=True).start()

    mode_kwargs = {"debate": args.debate}
    critical_context = (
        "\n\nРежим: критический разбор. Ищи конкретные риски, слабые места и условия,"
        " при которых предложение не сработает. Не спорь ради спора."
        if args.critical else ""
    )
    errors = 0
    for turn_index in range(args.rounds * 2):
        dialogue.drain_controls()
        if dialogue.stop.is_set():
            break

        side = sides[turn_index % 2]
        other = sides[(turn_index + 1) % 2]
        messages = engine.build_messages(side["name"], other["name"], dialogue.history,
                                         dialogue.topic, critical_context, **mode_kwargs)
        started = time.time()
        buffer = {"text": "", "sent": 0.0}

        def on_delta(piece, _side=side, _round=turn_index // 2 + 1, _buf=buffer):
            if not args.stream:
                return
            _buf["text"] += piece
            now = time.time()
            # ~12 updates per second is plenty for a panel and keeps the pipe cheap
            if now - _buf["sent"] < 0.08:
                return
            _buf["sent"] = now
            emit(type="delta", speaker=_side["name"], round=_round, text=_buf["text"])

        try:
            if bridge is not None:
                status, text, usage = bridge.request(
                    "a" if turn_index % 2 == 0 else "b",
                    messages,
                    args.max_tokens,
                    on_delta,
                    args.a if turn_index % 2 == 0 else args.b,
                )
                if status == "cancelled":
                    if buffer["text"].strip():
                        dialogue.history.append({"speaker": side["name"], "text": buffer["text"].strip(),
                                                 "seconds": round(time.time() - started, 1)})
                        emit(type="message", speaker=side["name"], round=turn_index // 2 + 1,
                             text=buffer["text"].strip(), seconds=round(time.time() - started, 1),
                             partial=True)
                    break
                if status != "ok":
                    errors += 1
                    emit(type="error", message=f"{side['name']}: {text}", round=turn_index // 2 + 1)
                    if errors >= 2:
                        break
                    continue
                if usage:
                    emit(type="usage", speaker=side["name"], **usage)
            else:
                if side["kind"] == "opencode":
                    sys.stderr.write("opencode-backed sides need --bridge\n")
                    raise OSError("unsupported side")
                text, _thinking = engine.stream_http(
                    side, messages, args.max_tokens, args.temperature, dialogue.stop.is_set, on_delta,
                )
            errors = 0
        except Exception as error:  # noqa: BLE001 - report to the panel, keep going once
            errors += 1
            emit(type="error", message=f"{side['name']}: {error}", round=turn_index // 2 + 1)
            if errors >= 2:
                break
            time.sleep(2)
            continue

        if not text:
            emit(type="error", message=f"{side['name']}: empty reply", round=turn_index // 2 + 1)
            continue
        dialogue.history.append({"speaker": side["name"], "text": text,
                                 "seconds": round(time.time() - started, 1)})
        emit(type="message", speaker=side["name"], round=turn_index // 2 + 1,
             text=text, seconds=round(time.time() - started, 1))

    markdown, raw = engine.write_transcript(args.out_dir, args.topic,
                                            [s["spec"] for s in sides], dialogue.history)
    emit(type="transcript", path=str(markdown), raw=str(raw))
    emit(type="done", messages=len(dialogue.history), stopped=dialogue.stop.is_set())


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        emit(type="done", messages=0, stopped=True)
