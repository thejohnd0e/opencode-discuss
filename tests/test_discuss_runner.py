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
    def host(self, *extra, **kwargs):
        host = Host(*extra, **kwargs)
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

    def test_an_english_topic_gets_an_english_language_rule_on_every_turn(self):
        host = self.host("--topic", "Rewrite or refactor?", rounds=1)
        host.wait_for("started")
        first = host.wait_for("generate")
        self.assertIn("same language as the topic", first["messages"][0]["content"])
        self.assertIn("Rewrite or refactor?", first["messages"][0]["content"])
        host.reply(first, "a")
        second = host.wait_for("generate")
        self.assertIn("not in Russian", second["messages"][0]["content"])
        host.reply(second, "b")
        host.wait_for("done")
        host.finish()

    def test_a_russian_topic_gets_the_russian_rule(self):
        host = self.host("--topic", "Переписать или рефакторить?", rounds=1)
        host.wait_for("started")
        first = host.wait_for("generate")
        self.assertIn("языке, на котором сформулирована тема", first["messages"][0]["content"])
        self.assertNotIn("not in Russian", first["messages"][0]["content"])
        host.reply(first, "a")
        host.reply(host.wait_for("generate"), "b")
        host.wait_for("done")
        host.finish()

    def test_without_a_conclusion_setting_no_extra_request_is_made(self):
        host = self.host(rounds=1)
        host.wait_for("started")
        host.reply(host.wait_for("generate"), "a")
        host.reply(host.wait_for("generate"), "b")
        events = []
        while True:
            event = host.next()
            events.append(event)
            if event["type"] == "done":
                break
        self.assertFalse([event for event in events if event["type"] == "generate"])
        host.finish()

    def test_the_chosen_side_writes_a_conclusion_after_the_rounds(self):
        host = self.host("--conclusion", "b", rounds=1)
        started = host.wait_for("started")
        host.reply(host.wait_for("generate"), "left position")
        host.wait_for("message")
        host.reply(host.wait_for("generate"), "right position")
        host.wait_for("message")

        request = host.wait_for("generate")
        self.assertEqual(request["side"], "b")
        prompt = json.dumps(request["messages"], ensure_ascii=False)
        self.assertIn("left position", prompt)
        self.assertIn("right position", prompt)
        self.assertIn("Разногласия", request["messages"][0]["content"])
        self.assertIn("same language as the topic", request["messages"][0]["content"])
        host.reply(request, "Agreed: x. Disagreed: y. Next steps: 1. z", usage={"output": 9})

        host.wait_for("usage")
        conclusion = host.wait_for("message")
        self.assertTrue(conclusion["conclusion"])
        self.assertEqual(conclusion["speaker"], started["b"])
        self.assertEqual(conclusion["round"], 1)
        transcript = host.wait_for("transcript")
        self.assertIn("Next steps", Path(transcript["path"]).read_text(encoding="utf-8"))
        done = host.wait_for("done")
        self.assertEqual(done["messages"], 3)
        self.assertEqual(host.finish(), 0)

    def test_a_stopped_run_gets_no_conclusion(self):
        host = self.host("--conclusion", "a", rounds=1)
        host.wait_for("started")
        host.wait_for("generate")
        host.send(type="command", command="stop")
        events = []
        while True:
            event = host.next()
            events.append(event)
            if event["type"] == "done":
                break
        self.assertFalse([event for event in events if event["type"] == "generate"])
        self.assertTrue(events[-1]["stopped"])
        host.finish()

    def test_a_failed_conclusion_is_reported_as_an_error(self):
        host = self.host("--conclusion", "a", rounds=1)
        host.wait_for("started")
        host.reply(host.wait_for("generate"), "a")
        host.reply(host.wait_for("generate"), "b")
        request = host.wait_for("generate")
        host.send(type="generation_error", requestID=request["requestID"], message="boom")
        error = host.wait_for("error")
        self.assertIn("conclusion", error["message"])
        host.wait_for("done")
        host.finish()


def load_runner_module():
    import importlib.util
    spec = importlib.util.spec_from_file_location("discuss_runner", RUNNER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class AnswerCheckTest(unittest.TestCase):
    OPPONENT = ("Поэтапный рефакторинг обычно безопаснее: он сохраняет работающие функции, "
                "позволяет проверять каждое изменение и снижает риск сорвать сроки.")

    @classmethod
    def setUpClass(cls):
        cls.runner = load_runner_module()

    def check(self, reply):
        return self.runner.check_answer(reply, self.OPPONENT)

    def test_exact_quote_with_other_quote_marks_and_case(self):
        self.assertEqual(self.check("> «поэтапный рефакторинг, обычно безопаснее!»\nНе всегда."),
                         {"quoted": 1, "matched": 1})

    def test_quote_with_an_ellipsis_and_over_two_lines(self):
        self.assertEqual(self.check("> он сохраняет работающие функции … снижает риск\nОтвет"),
                         {"quoted": 1, "matched": 1})
        self.assertEqual(self.check("> позволяет проверять\n> каждое изменение и снижает риск\nОтвет"),
                         {"quoted": 1, "matched": 1})

    def test_a_one_word_slip_is_tolerated(self):
        self.assertEqual(self.check("> он сохраняет рабочие функции, позволяет проверять каждое изменение\nОтвет"),
                         {"quoted": 1, "matched": 1})

    def test_paraphrase_and_invented_quotes_do_not_match(self):
        self.assertEqual(self.check("> постепенный рефакторинг надёжнее и бережёт сроки\nОтвет"),
                         {"quoted": 1, "matched": 0})
        self.assertEqual(self.check("> переписывание всегда дешевле в долгосрочной перспективе\nОтвет"),
                         {"quoted": 1, "matched": 0})

    def test_no_quote_and_too_short_quotes_count_as_none(self):
        self.assertEqual(self.check("Я считаю, что переписать лучше."), {"quoted": 0, "matched": 0})
        self.assertEqual(self.check("> да\nНет."), {"quoted": 0, "matched": 0})

    def test_two_quotes_one_real(self):
        self.assertEqual(self.check("> Поэтапный рефакторинг обычно безопаснее\nДа.\n\n"
                                    "> выдуманная цитата которой нет вообще\nНет."),
                         {"quoted": 2, "matched": 1})


class DebateAnswerProtocolTest(unittest.TestCase):
    def test_debate_turns_after_the_first_must_quote_and_are_checked(self):
        host = Host("--debate", rounds=1)
        self.addCleanup(host.close)
        host.wait_for("started")
        first = host.wait_for("generate")
        self.assertNotIn("дословных цитат", first["messages"][0]["content"])
        host.reply(first, "Рефакторинг по шагам безопаснее и дешевле для команды.")
        self.assertNotIn("check", host.wait_for("message"))

        second = host.wait_for("generate")
        self.assertIn("дословных цитат", second["messages"][0]["content"])
        host.reply(second, "> рефакторинг по шагам безопаснее\nНе всегда: долги копятся.")
        message = host.wait_for("message")
        self.assertEqual(message["check"], {"quoted": 1, "matched": 1})
        host.wait_for("done")
        host.finish()

    def test_cooperative_turns_have_no_rule_and_no_check(self):
        host = Host(rounds=1)
        self.addCleanup(host.close)
        host.wait_for("started")
        host.reply(host.wait_for("generate"), "one")
        host.wait_for("message")
        second = host.wait_for("generate")
        self.assertNotIn("дословных цитат", second["messages"][0]["content"])
        host.reply(second, "two")
        self.assertNotIn("check", host.wait_for("message"))
        host.wait_for("done")
        host.finish()


if __name__ == "__main__":
    unittest.main()
