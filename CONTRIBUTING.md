# Contributing

Thanks for looking at `opencode-discuss`. It targets **OpenCode 2.2.5** only;
other versions are not supported yet.

## Setup

```sh
bun install
bun run build
```

Requirements: Bun 1.4+, Python 3.12, OpenCode 2.2.5.

## Before you open a pull request

```sh
bun run typecheck                                     # must exit 0
bun test tests/unit                                   # unit tests
python -m unittest discover -s tests -p "test_*.py"   # Python bridge tests
python tests/run-live.py                              # server loads in an isolated OpenCode
python tests/run-tui-smoke.py                         # TUI setup reaches `ready`
```

CI runs the first three plus the build. The two smoke tests need a local
OpenCode and are run by hand; they find `opencode` on `PATH` (set `OPENCODE_BIN`
to use another binary) and work on Windows, macOS and Linux. Use `python3`
instead of `python` where that is the command's name.

A green offline run does not prove runtime behaviour. Anything that depends on the
host (hooks, panel, permissions, streaming) should be checked in a real OpenCode
and the evidence (journal lines, log excerpts) noted in the pull request.

## Ground rules

- Starting a discussion always needs the user's explicit consent. Do not weaken
  `src/discussion/consent.ts`.
- Never write topic or interjection text to logs; lengths only.
- `scripts/model-duel.py` is the original engine and stays unchanged. Extend
  `scripts/discuss-runner.py`.
- A new field on `Run` or `Usage` must also be added to the RPC schema in
  `src/rpc.ts` (the host silently drops unlisted fields); `tests/unit/rpc.test.ts`
  checks this.
- Do not edit a user's OpenCode configuration from code or tests.
- One focused commit per change; the main branch is `master`.

## Reporting problems

Open an issue with the OpenCode version, what you ran, and the relevant lines
of `tui.jsonl` / `server.jsonl` (they hold no topic text). Please remove any
tokens or personal paths first.
