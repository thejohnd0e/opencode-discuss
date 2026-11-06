"""Offline protocol tests for scripts/discuss-runner.py.

The adapter is driven over real pipes by a fake host: no network, no model call.
"""
import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path

RUNNER = Path(__file__).resolve().parent.parent / "scripts" / "discuss-runner.py"


class Host:
    def __init__(self, *extra, rounds=1, timeout=1.5):
        self.temp = tempfile.TemporaryDirectory()
        self.process = subprocess.Popen(
            [sys.executable, str(RUNNER), "--bridge", "--stream",
             "--topic", "Topic", "--rounds", str(rounds),
             "--a", "provider:left", "--b", "provider:right",
             "--out-dir", self.temp.name,
             "--turn-timeout", str(timeout), *extra],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", bufsize=1,
        )
        self.events = queue.Queue()
        self.stderr = []
        threading.Thread(target=self._read, daemon=True).start()
        threading.Thread(target=self._drain_stderr, daemon=True).start()

    def _read(self):
        for line in self.process.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                self.events.put(json.loads(line))
            except json.JSONDecodeError:
                self.events.put({"type": "broken", "raw": line})

    def _drain_stderr(self):
        for line in self.process.stderr:
            self.stderr.append(line)

    def next(self, timeout=10):
        return self.events.get(timeout=timeout)

    def wait_for(self, kind, timeout=10):
        deadline = timeout
        while deadline > 0:
            event = self.next(timeout=deadline)
            if event.get("type") == kind:
                return event
            deadline -= 0.1
        raise AssertionError(f"no {kind} event; stderr={''.join(self.stderr)[-500:]}")

    def send(self, **payload):
        self.process.stdin.write(json.dumps(payload, ensure_ascii=False) + "\n")
        self.process.stdin.flush()

    def reply(self, request, text, usage=None):
        payload = {"type": "result", "requestID": request["requestID"], "text": text}
        if usage:
            payload["usage"] = usage
        self.send(**payload)

    def finish(self):
        try:
            self.process.stdin.close()
        except Exception:
            pass
        self.process.wait(timeout=10)
        return self.process.returncode

    def close(self):
        try:
            self.process.kill()
        except Exception:
            pass
        for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
            try:
                stream.close()
            except Exception:
                pass
        self.temp.cleanup()


class BridgeProtocolTest(unittest.TestCase):
    def host(self, **kwargs):
        host = Host(**kwargs)
        self.addCleanup(host.close)
        return host

    def test_two_sides_exchange_replies_and_write_a_transcript(self):
        host = self.host(rounds=1)
        started = host.wait_for("started")
        self.assertTrue(started["bridge"])
        self.assertEqual(started["models"], ["provider:left", "provider:right"])

        first = host.wait_for("generate")
        self.assertEqual(first["side"], "a")
        self.assertEqual(first["messages"][0]["role"], "system")
        self.assertEqual(first["messages"][-1]["role"], "user")
        host.reply(first, "left answer")

        message = host.wait_for("message")
        self.assertEqual((message["speaker"], message["text"]), (started["a"], "left answer"))

        second = host.wait_for("generate")
        self.assertEqual(second["side"], "b")
        self.assertIn("left answer", json.dumps(second["messages"], ensure_ascii=False))
        host.reply(second, "правый ответ", usage={"output": 4})

        usage = host.wait_for("usage")
        self.assertEqual(usage["output"], 4)
        host.wait_for("message")
        transcript = host.wait_for("transcript")
        self.assertTrue(os.path.exists(transcript["path"]))
        done = host.wait_for("done")
        self.assertEqual(done["messages"], 2)
        self.assertFalse(done["stopped"])
        self.assertEqual(host.finish(), 0)

    def test_stop_during_generation_ends_the_run_without_another_request(self):
        host = self.host(rounds=2)
        host.wait_for("started")
        host.wait_for("generate")
        host.send(type="command", command="stop")

        done = host.wait_for("done")
        self.assertTrue(done["stopped"])
        self.assertEqual(done["messages"], 0)
        self.assertEqual(host.finish(), 0)

    def test_empty_reply_is_reported_and_the_turn_is_skipped(self):
        host = self.host(rounds=1)
        host.wait_for("started")
        first = host.wait_for("generate")
        host.reply(first, "")
        error = host.wait_for("error")
        self.assertIn("empty reply", error["message"])
        second = host.wait_for("generate")
        host.reply(second, "right")
        done = host.wait_for("done")
        self.assertEqual(done["messages"], 1)
        self.assertEqual(host.finish(), 0)

    def test_two_generation_errors_stop_the_run(self):
        host = self.host(rounds=2)
        host.wait_for("started")
        first = host.wait_for("generate")
        host.send(type="generation_error", requestID=first["requestID"], message="provider down")
        host.wait_for("error")
        second = host.wait_for("generate")
        host.send(type="generation_error", requestID=second["requestID"], message="provider down")
        host.wait_for("error")
        done = host.wait_for("done")
        self.assertEqual(done["messages"], 0)
        self.assertEqual(host.finish(), 0)

    def test_a_silent_host_times_out_instead_of_hanging(self):
        host = self.host(rounds=1, timeout=0.3)
        host.wait_for("started")
        host.wait_for("generate")
        error = host.wait_for("error", timeout=5)
        self.assertIn("no reply within", error["message"])
        self.assertEqual(host.finish(), 0)

    def test_stop_keeps_the_partial_reply(self):
        host = self.host(rounds=2)
        host.wait_for("started")
        first = host.wait_for("generate")
        host.send(type="delta", requestID=first["requestID"], text="half an answer")
        host.send(type="command", command="stop")

        partial = host.wait_for("message")
        self.assertEqual(partial["text"], "half an answer")
        self.assertTrue(partial.get("partial"))
        done = host.wait_for("done")
        self.assertTrue(done["stopped"])
        self.assertEqual(host.finish(), 0)

    def test_cyrillic_and_emoji_survive_the_pipe(self):
        host = self.host(rounds=1)
        host.wait_for("started")
        first = host.wait_for("generate")
        text = "Привет, мир 👋 — кириллица и эмодзи"
        host.reply(first, text)
        self.assertEqual(host.wait_for("message")["text"], text)
        second = host.wait_for("generate")
        host.reply(second, "ok")
        host.wait_for("done")
        host.finish()


if __name__ == "__main__":
    unittest.main()
