# Architecture

`opencode-discuss` is an ordinary OpenCode 2.2.5 plugin: a **server part**, a
**TUI part** and a typed **RPC contract** between them, plus two agent files.
The dialogue itself is driven by a small Python engine. Nothing patches OpenCode.

```
┌──────────── TUI (src/tui.ts) ────────────┐        ┌────────── server (src/server.ts) ──────────┐
│ slash commands, dialogs, live panel      │  RPC   │ runs, state, consent, provider calls       │
│ view state (src/ui/view-state.ts)        │◄──────►│ DiscussionService ── DiscussionStore       │
└──────────────────────────────────────────┘ events │        │                                   │
                                                    │        ▼ JSONL over stdin/stdout           │
                                                    │ Runner ── scripts/discuss-runner.py        │
                                                    │        ▲ "generate" requests               │
                                                    │        │                                   │
                                                    │ TurnRunner: hidden session per turn        │
                                                    │ + `context` hook replaces its messages     │
                                                    └────────────────────────────────────────────┘
```

## One turn

1. The Python engine builds a role-tagged prompt for the side whose turn it is
   and sends a `generate` request (model, messages, output cap) on stdout.
2. The server creates a **hidden, tool-less session** for that model in the
   plugin's own location, registers the turn, and prompts it.
3. The `context` hook fires before dispatch and **replaces the session's
   messages** with the discussion, clears `system` and `tools`, and sets
   `maxTokens`. The model sees only the dialogue.
4. Text deltas stream back to Python (which throttles them into `delta`
   events) and to the panel. `session.step.ended` events carry tokens and cost.
5. The turn ends on success, failure, timeout, stop, or when OpenCode starts an
   automatic continuation after `finish=length` (the plugin cuts that, so one
   turn is one request). The hidden session is removed.

## Modules

| Path | Role |
| --- | --- |
| `src/server.ts` | Plugin entry: RPC handlers, `discuss_*` tools, `context` hook, consent hook, journal. |
| `src/rpc.ts` | RPC contract. Schemas are strict, and the host drops unlisted fields: add new `Run`/`Usage` fields here too. |
| `src/discussion/service.ts` | Run lifecycle: start, stop, interject, topic change, terminal states. |
| `src/discussion/store.ts` | Durable state in plugin storage, one key per location, revisions, recovery of interrupted runs. |
| `src/discussion/provider.ts` | Hidden-session turns: deltas, usage, timeouts, continuation cut. |
| `src/discussion/runner.ts` | Python subprocess, JSONL framing, 5-second hard kill. |
| `src/discussion/preflight.ts` | Saved pair and output cap checked against the model list. |
| `src/discussion/consent.ts` | Start is always confirmed; a configured `allow` is turned into `ask`. |
| `src/discussion/handoff.ts`, `usage.ts` | Result packet for Plan/Build; token and cost accounting. |
| `src/tui.ts`, `src/ui/*` | Commands, panel, dialogs, colours, journal, pure helpers. |
| `scripts/discuss-runner.py` | Bridge protocol and dialogue loop. `scripts/model-duel.py` is the unchanged engine it imports. |
| `agents/` | `discuss` (primary agent, green) and `discuss-participant` (tool-less). |

## Key decisions

- **One plugin instance per location.** OpenCode runs a server plugin per
  location, all sharing plugin storage. State is keyed per location and every TUI
  call carries the session's location. Turn sessions live in the instance's own
  location, because only that instance's `context` hook knows the turn.
- **Consent is a hook, not only a rule.** `permission.assert` prompts only if the
  rules say `ask`; the plugin forces `ask` for `discuss.start`, so a rule or a
  saved `allow` cannot start a paid run silently.
- **Stop is a boundary stop plus an interrupt.** Stop aborts the current turn
  (interrupting its hidden session), sends `stop` to Python and arms a 5-second
  timer that kills the process tree if it does not exit.
- **The panel is a view.** It holds no authority: closing it does not stop a run,
  and it refetches snapshots by revision, dropping stale ones.
- **No secrets, no topic text in logs.** Journals record lengths, never content.

## State and files

| What | Where |
| --- | --- |
| Run state | OpenCode plugin storage, key `discuss/state@<hash of location>` |
| Journals | `%LOCALAPPDATA%\opencode-discuss\logs\{tui,server}.jsonl` (or `$XDG_STATE_HOME/opencode-discuss/logs/`) |
| Transcripts | `…\opencode-discuss\transcripts\` |
| Handoff packets | `…\opencode-discuss\handoffs\` |

See [compatibility-2.2.5.md](compatibility-2.2.5.md) for the verified OpenCode
API surface and its limits.
