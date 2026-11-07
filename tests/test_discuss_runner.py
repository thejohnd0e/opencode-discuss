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

    def collect_until_done(self, host):
        events = []
        while True:
            event = host.next()
            events.append(event)
            if event["type"] == "done":
                return events

    def test_an_empty_reply_ends_the_run_without_another_request(self):
        host = self.host(rounds=2)
        host.wait_for("started")
        host.reply(host.wait_for("generate"), "")
        events = self.collect_until_done(host)
        self.assertIn("empty reply", [e for e in events if e["type"] == "error"][0]["message"])
        self.assertFalse([e for e in events if e["type"] == "generate"])
        self.assertEqual(events[-1]["messages"], 0)
        self.assertEqual(host.finish(), 0)

    def test_a_generation_error_ends_the_run_without_another_request(self):
        host = self.host(rounds=2)
        host.wait_for("started")
        host.reply(host.wait_for("generate"), "left")
        second = host.wait_for("generate")
        host.send(type="generation_error", requestID=second["requestID"], message="provider down")
        events = self.collect_until_done(host)
        self.assertIn("provider down", [e for e in events if e["type"] == "error"][0]["message"])
        self.assertFalse([e for e in events if e["type"] == "generate"])
        self.assertEqual(events[-1]["messages"], 1)
        self.assertEqual(host.finish(), 0)

    def test_a_failed_turn_gets_no_conclusion(self):
        host = self.host("--conclusion", "b", rounds=1)
        host.wait_for("started")
        host.reply(host.wait_for("generate"), "left")
        second = host.wait_for("generate")
        host.send(type="generation_error", requestID=second["requestID"], message="limit")
        events = self.collect_until_done(host)
        self.assertFalse([e for e in events if e["type"] == "generate"])

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
                         {"quoted": 1, "matched": 1, "recycled": 0})

    def test_quote_with_an_ellipsis_and_over_two_lines(self):
        self.assertEqual(self.check("> он сохраняет работающие функции … снижает риск\nОтвет"),
                         {"quoted": 1, "matched": 1, "recycled": 0})
        self.assertEqual(self.check("> позволяет проверять каждое\n> изменение и снижает риск\nОтвет"),
                         {"quoted": 2, "matched": 2, "recycled": 0})

    def test_two_quotes_on_adjacent_lines_are_two_quotes(self):
        self.assertEqual(self.check("> «Поэтапный рефакторинг обычно безопаснее»\n"
                                    "> «снижает риск сорвать сроки»\nОтвет"),
                         {"quoted": 2, "matched": 2, "recycled": 0})

    def test_a_one_word_slip_is_tolerated(self):
        self.assertEqual(self.check("> он сохраняет рабочие функции, позволяет проверять каждое изменение\nОтвет"),
                         {"quoted": 1, "matched": 1, "recycled": 0})

    def test_paraphrase_and_invented_quotes_do_not_match(self):
        self.assertEqual(self.check("> постепенный рефакторинг надёжнее и бережёт сроки\nОтвет"),
                         {"quoted": 1, "matched": 0, "recycled": 0})
        self.assertEqual(self.check("> переписывание всегда дешевле в долгосрочной перспективе\nОтвет"),
                         {"quoted": 1, "matched": 0, "recycled": 0})

    def test_no_quote_and_too_short_quotes_count_as_none(self):
        self.assertEqual(self.check("Я считаю, что переписать лучше."), {"quoted": 0, "matched": 0, "recycled": 0})
        self.assertEqual(self.check("> да\nНет."), {"quoted": 0, "matched": 0, "recycled": 0})

    def test_quoting_back_your_own_words_from_the_opponents_quotes_does_not_count(self):
        # Regression, live 2026-11-07 run 3860835f: A quoted its own round-1
        # sentences that B had quoted, and the check counted them as answers.
        own_words = "У Трампа такого ядра нет — есть стиль."
        opponent = (f"> «{own_words}»\n"
                    "Это не доказывает бессмысленность метафоры: она меняет рамку прочтения.")
        reply = f"> «{own_words}»\nПринимаю поправку."
        self.assertEqual(self.runner.check_answer(reply, opponent), {"quoted": 1, "matched": 0, "recycled": 1})
        honest = "> «она меняет рамку прочтения»\nПринимаю."
        self.assertEqual(self.runner.check_answer(honest, opponent), {"quoted": 1, "matched": 1, "recycled": 0})

    MY_EARLIER = ("Смех тут не реакция на отмороженный нос, а эффект жанра: частушечная "
                  "строфа требует развязки, и смех её даёт.")

    def test_nested_quote_of_my_own_words_is_recycled(self):
        opponent = ("> > «Смех тут не реакция на отмороженный нос, а эффект жанра»\n"
                    "> Ты так считаешь.\nА я думаю, что жанр не объясняет причину.")
        reply = "> «Смех тут не реакция на отмороженный нос, а эффект жанра»\nДа."
        self.assertEqual(self.runner.check_answer(reply, opponent, self.MY_EARLIER),
                         {"quoted": 1, "matched": 0, "recycled": 1})

    def test_my_phrase_repeated_inside_the_opponents_sentence_is_recycled(self):
        opponent = ("Ты пишешь, что «смех тут не реакция на отмороженный нос, а эффект жанра», "
                    "но жанр не отменяет сюжета.")
        reply = "> «смех тут не реакция на отмороженный нос, а эффект жанра»\nИменно."
        self.assertEqual(self.runner.check_answer(reply, opponent, self.MY_EARLIER),
                         {"quoted": 1, "matched": 0, "recycled": 1})
        # without the history the same quote would have passed: the history is what catches it
        self.assertEqual(self.runner.check_answer(reply, opponent),
                         {"quoted": 1, "matched": 1, "recycled": 0})

    def test_my_old_phrase_plus_a_few_new_words_is_recycled(self):
        opponent = ("Смех тут не реакция на отмороженный нос, а эффект жанра: частушечная строфа "
                    "требует развязки, но это лишь твоя гипотеза.")
        reply = ("> Смех тут не реакция на отмороженный нос, а эффект жанра: частушечная строфа "
                 "требует развязки, но это\nОтвет")
        self.assertEqual(self.runner.check_answer(reply, opponent, self.MY_EARLIER),
                         {"quoted": 1, "matched": 0, "recycled": 1})

    def test_half_mine_half_theirs_counts_but_is_marked_mixed(self):
        opponent = ("Согласен, что это эффект жанра: частушечная строфа требует развязки, однако "
                    "товарищи смеются над самим вождём, над его внезапной телесной слабостью и ни над чем больше.")
        reply = ("> эффект жанра: частушечная строфа требует развязки, однако товарищи смеются над самим "
                 "вождём, над его внезапной телесной слабостью\nОтвет")
        self.assertEqual(self.runner.check_answer(reply, opponent, self.MY_EARLIER),
                         {"quoted": 1, "matched": 1, "recycled": 0, "mixed": 1})

    def test_an_honest_quote_sharing_a_few_of_my_words_is_clean(self):
        opponent = ("Отмороженный нос здесь важен сюжетно: без него нет повода для смеха, "
                    "и строфа рассыпается.")
        reply = "> без него нет повода для смеха, и строфа рассыпается\nНе согласен."
        self.assertEqual(self.runner.check_answer(reply, opponent, self.MY_EARLIER),
                         {"quoted": 1, "matched": 1, "recycled": 0})

    def test_two_quotes_one_real(self):
        self.assertEqual(self.check("> Поэтапный рефакторинг обычно безопаснее\nДа.\n\n"
                                    "> выдуманная цитата которой нет вообще\nНет."),
                         {"quoted": 2, "matched": 1, "recycled": 0})


class LedgerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.runner = load_runner_module()

    def test_claims_get_runner_numbers_and_the_block_is_cut_from_the_text(self):
        ledger = self.runner.Ledger()
        shown, record = ledger.apply("A", "Opening.\n\n[ledger]\n+ A1: one\n+ A7: two\n[/ledger]", 1)
        self.assertEqual(shown, "Opening.")
        self.assertEqual(record, {"claims": [{"id": "A1", "text": "one"}, {"id": "A2", "text": "two"}],
                                  "answers": [], "parsed": True})

    def test_verdicts_close_only_open_claims_of_the_opponent(self):
        ledger = self.runner.Ledger()
        ledger.apply("A", "x\n[ledger]\n+ A1: one\n+ A2: two\n[/ledger]", 1)
        shown, record = ledger.apply(
            "B", "Reply.\n```\n[ledger]\n+ **B1**: tests first\n**A2**: accepted\n- A1 — Rebutted\nA9: accepted\n"
                 "B1: accepted\n[/ledger]\n```", 1)
        self.assertEqual(shown, "Reply.")
        self.assertEqual(record["answers"], [{"id": "A2", "verdict": "accepted"}, {"id": "A1", "verdict": "rebutted"}])
        self.assertEqual([c["status"] for c in ledger.open_claims("B")], ["open"])
        self.assertEqual(ledger.open_claims("A"), [])
        # a closed claim cannot be closed again
        _shown, again = ledger.apply("B", "y\n[ledger]\nA1: accepted\n[/ledger]", 2)
        self.assertEqual(again["answers"], [])

    def test_a_block_without_the_opening_tag_is_still_read(self):
        ledger = self.runner.Ledger()
        ledger.apply("A", "x\n[ledger]\n+ A1: one\n+ A2: two\n[/ledger]", 1)
        shown, record = ledger.apply("B", "My reply ends here.\n\n+ B1: tests first\nA1: rebutted\n[/ledger]", 1)
        self.assertEqual(shown, "My reply ends here.")
        self.assertTrue(record["parsed"])
        self.assertEqual(record["claims"], [{"id": "B1", "text": "tests first"}])
        self.assertEqual(record["answers"], [{"id": "A1", "verdict": "rebutted"}])

    def test_trailing_service_lines_without_any_tag_are_read(self):
        ledger = self.runner.Ledger()
        ledger.apply("A", "x\n[ledger]\n+ A1: one\n[/ledger]", 1)
        shown, record = ledger.apply("B", "Text.\n\n+ B1: tests first\nA1: accepted", 1)
        self.assertEqual(shown, "Text.")
        self.assertEqual(record["answers"], [{"id": "A1", "verdict": "accepted"}])

    def test_a_reply_without_a_block_is_kept_and_marked(self):
        ledger = self.runner.Ledger()
        self.assertEqual(ledger.apply("A", "Plain reply.", 1), ("Plain reply.", {"claims": [], "answers": [], "parsed": False}))

    def test_the_rule_lists_the_opponents_open_claims_and_the_next_number(self):
        ledger = self.runner.Ledger()
        ledger.apply("A", "x\n[ledger]\n+ A1: hidden rules get lost\n[/ledger]", 1)
        rule = ledger.rule("B", "A")
        self.assertIn("B1, B2", rule)
        self.assertIn("A1: hidden rules get lost", rule)
        self.assertIn("Открытых тезисов оппонента сейчас нет", ledger.rule("A", "B"))

    def test_summary_groups_claims_by_state(self):
        ledger = self.runner.Ledger()
        ledger.apply("A", "x\n[ledger]\n+ A1: one\n+ A2: two\n[/ledger]", 1)
        ledger.apply("B", "y\n[ledger]\nA1: rebutted\n[/ledger]", 1)
        self.assertEqual(ledger.summary({"A": "Left", "B": "Right"}), [
            "Опровергнут оппонентом:", "- A1 (Left): one",
            "Оппонент пропустил, хотя у него был ход:", "- A2 (Left): two",
        ])

    def test_a_claim_made_in_the_last_reply_is_ended_not_skipped(self):
        # Regression, reviewer 2026-11-07: B3 came in the very last reply and
        # was listed as an unanswered disagreement.
        ledger = self.runner.Ledger()
        ledger.apply("A", "x\n[ledger]\n+ A1: one\n[/ledger]", 1)
        ledger.apply("B", "y\n[ledger]\n+ B1: two\nA1: accepted\n[/ledger]", 1)
        ledger.apply("A", "z\n[ledger]\n+ A2: three\n[/ledger]", 2)  # skips B1
        ledger.apply("B", "w\n[ledger]\n+ B2: four\nA2: rebutted\n[/ledger]", 2)
        states = {cid: ledger.state(claim) for cid, claim in ledger.claims.items()}
        self.assertEqual(states, {"A1": "accepted", "B1": "skipped", "A2": "rebutted", "B2": "ended"})
        summary = ledger.summary({"A": "Left", "B": "Right"})
        self.assertIn("Остался открытым: спор закончился, ответить было некому:", summary)
        self.assertEqual(summary[-1], "- B2 (Right): four")

    def test_a_reply_without_a_block_still_counts_as_the_opponents_turn(self):
        ledger = self.runner.Ledger()
        ledger.apply("A", "x\n[ledger]\n+ A1: one\n[/ledger]", 1)
        ledger.apply("B", "no block at all", 1)
        self.assertEqual(ledger.state(ledger.claims["A1"]), "skipped")


class DebateAnswerProtocolTest(unittest.TestCase):
    def test_a_debate_keeps_a_claim_ledger_and_the_conclusion_sees_it(self):
        host = Host("--debate", "--conclusion", "a", rounds=1)
        self.addCleanup(host.close)
        host.wait_for("started")
        first = host.wait_for("generate")
        self.assertIn("[ledger]", first["messages"][0]["content"])
        host.reply(first, "Refactor wins.\n[ledger]\n+ A1: refactor is safer\n[/ledger]")
        message = host.wait_for("message")
        self.assertEqual(message["text"], "Refactor wins.")
        self.assertEqual(message["ledger"]["claims"], [{"id": "A1", "text": "refactor is safer"}])

        second = host.wait_for("generate")
        self.assertIn("A1: refactor is safer", second["messages"][0]["content"])
        self.assertNotIn("[ledger]", json.dumps(second["messages"][1:], ensure_ascii=False))
        host.reply(second, "> Refactor wins\nNot always.\n[ledger]\n+ B1: tests come first\nA1: rebutted\n[/ledger]")
        message = host.wait_for("message")
        self.assertEqual(message["ledger"]["answers"], [{"id": "A1", "verdict": "rebutted"}])

        conclusion = host.wait_for("generate")
        prompt = conclusion["messages"][1]["content"]
        self.assertIn("Опровергнут оппонентом:\n- A1", prompt)
        # B1 came in the last reply: open because the debate ended, not a disagreement
        self.assertIn("спор закончился, ответить было некому:\n- B1", prompt)
        self.assertIn("Осталось открытым к концу спора", conclusion["messages"][0]["content"])
        host.reply(conclusion, "Agreed: none.")
        host.wait_for("done")
        host.finish()

    def test_the_other_side_reviews_the_conclusion(self):
        host = Host("--debate", "--conclusion", "a", "--review", rounds=1)
        self.addCleanup(host.close)
        started = host.wait_for("started")
        host.reply(host.wait_for("generate"), "Refactor wins.\n[ledger]\n+ A1: refactor is safer\n[/ledger]")
        host.reply(host.wait_for("generate"), "> Refactor wins\nNot always.\n[ledger]\nA1: rebutted\n[/ledger]")
        conclusion = host.wait_for("generate")
        self.assertEqual(conclusion["side"], "a")
        host.reply(conclusion, "## Agreed\nNothing.")
        self.assertTrue(host.wait_for("message").get("conclusion"))

        review = host.wait_for("generate")
        self.assertEqual(review["side"], "b")
        system, user = review["messages"][0]["content"], review["messages"][1]["content"]
        self.assertIn("Возражений нет", system)
        # the reviewer knows the section rules, so a rebutted claim under
        # disagreements is not reported as a mistake (live 2026-11-07)
        self.assertIn("отдельного раздела «Опровергнуто» нет", system)
        self.assertIn("## Agreed\nNothing.", user)
        self.assertIn("Опровергнут оппонентом:\n- A1", user)
        host.reply(review, "1. A1 is listed as agreed, but it was rebutted.")
        messages = []
        while True:
            event = host.next()
            if event["type"] == "message":
                messages.append(event)
            if event["type"] == "done":
                break
        self.assertTrue(messages[-1]["review"])
        self.assertEqual(messages[-1]["speaker"], started["b"])
        self.assertEqual(event["messages"], 4)
        host.finish()

    def test_no_review_without_the_flag_or_when_the_conclusion_failed(self):
        host = Host("--debate", "--conclusion", "a", "--review", rounds=1)
        self.addCleanup(host.close)
        host.wait_for("started")
        host.reply(host.wait_for("generate"), "a")
        host.reply(host.wait_for("generate"), "b")
        conclusion = host.wait_for("generate")
        host.send(type="generation_error", requestID=conclusion["requestID"], message="boom")
        events = []
        while True:
            event = host.next()
            events.append(event)
            if event["type"] == "done":
                break
        self.assertFalse([e for e in events if e["type"] == "generate"])
        host.finish()

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
        self.assertEqual(message["check"], {"quoted": 1, "matched": 1, "recycled": 0})
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
