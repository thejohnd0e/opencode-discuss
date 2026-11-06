# OpenCode 2.2.5 plugin API compatibility

**Status:** verified against the installed packages on 2026-11-04. Nothing here was
checked against a live server or a model provider yet; that is Task 7.

**Method:** inspect the shipped `.d.ts` files in `node_modules`, compile the
public-API probe in `tests/unit/compatibility-probe.ts` with
`node node_modules/typescript/bin/tsc -p tsconfig.json`, and run
`bun test tests/unit/compatibility.test.ts`. No credential file was read.

## Installed contract

| Package | Version |
| --- | --- |
| `@opencode/plugin` | 2.2.5 |
| `@opencode/client` | 2.2.5 |
| `@opencode/schema` | 2.2.5 |

Package entry points that exist in 2.2.5: `.` (server), `./rpc`, `./tui`, `./effect`,
`./host`, `./runtime`, `./gui*`. A combined server + TUI package is loaded by
`opencode.json(c)`; a TUI-only package is loaded by `cli.json`.

## Capability matrix

| Need | 2.2.5 API | Verdict |
| --- | --- | --- |
| Server plugin | `Plugin.define({ id, setup })` | Available |
| Typed RPC + events | `Rpc.define`, `ctx.rpc.register(def, handlers)`, `registration.events.emit`, `ctx.rpc(def)` | Available; event payload must be an object |
| Tools | `ctx.tool.transform(editor => editor.add(...))` | Available; `ToolContext` has `sessionID`, `agent`, `signal`, `progress` |
| Durable state | `ctx.storage.get/set/remove/scan` | Available |
| List models | `ctx.model.list()`, `ctx.provider.list()` | Available |
| Register a new agent | `AgentEditor` has `list/get/default/update/remove` only | **Not available** — install the Discuss agent as an agent file/config entry |
| Host confirmation | `ctx.permission.assert({ sessionID, action, resources, metadata, source })` | Available; omit `save` so no permanent allow is stored |
| Stateless generation | `ctx.experimental.generate.text({ prompt, model? })` | Available but see limits |
| Per-call output cap | `ctx.session.hook("context", e => { e.options.maxTokens = n }, { providerID })` | Available; hook scoping is by provider only |
| Streaming | `ctx.session.prompt` + `ctx.event.subscribe({ types: ["session.text.delta", ...] })` | Available |
| Cancellation | `ctx.session.interrupt({ sessionID })` | Available |
| Session model/agent | `session.create({ model, agent, location })`, `switchModel`, `switchAgent` | Available |
| Session cleanup | `session.remove({ sessionID })` | Available |

## Constraints that change the bridge design

1. **`experimental.generate.text` cannot carry a conversation.** Its input is
   `{ prompt: string; model?: { providerID, id, variant? } }`. There is no
   `messages` array, no abort signal, no output-token limit, and it returns one
   final string. It is unsuitable for a live two-model turn.

2. **`session.generate` is also one prompt, one final string.** It takes
   `{ sessionID, prompt }` and has no streaming or abort parameter.

3. **Streaming requires a real (hidden) session.** The supported path is:
   create a session with the participant agent and model, call
   `session.prompt({ sessionID, text })`, subscribe to `session.text.delta`
   filtered by `sessionID`, wait for `session.execution.succeeded` or
   `session.execution.failed`, and call `session.interrupt` to stop. Partial
   text, cancellation and usage accounting therefore come from the session
   event stream, not from a generate call.

4. **The output cap is a hook, not a request field.** `session.hook("context")`
   can set `event.options.maxTokens`. The hook cannot be scoped to an agent, only
   to a provider, so it must check `event.agent` itself. This is a request
   override; it is not proof that a provider honoured it.

5. **The plugin cannot register a primary agent.** `AgentEditor` has no `add`.
   The Discuss agent must ship as `agents/discuss.md` (or a config entry) and is
   installed separately. The plugin can still update an existing agent, which we
   will not do implicitly.

6. **Confirmation is a permission assertion.** `ctx.permission.assert` prompts in
   the host UI and rejects on denial. Omitting `save` prevents "always allow"
   from being stored. This is the only host-owned confirmation primitive found;
   an LLM-supplied boolean is not proof of consent.

7. **RPC event data must be an object.** Scalars, arrays, `null` and `undefined`
   are invalid. Subscribers see only live events, so the TUI must fetch a
   snapshot and reconcile by revision rather than assume it saw every event.

## Consequences for the plan

- Task 3's bridge is **not** "Python asks the server to call
  `generate.text` with messages". Python sends the turn request; the server
  creates a hidden participant session, sends the prompt text, and installs a
  `context` hook for that session that replaces `event.messages` with the
  engine's role-tagged messages and applies `maxTokens`. Streaming deltas come
  from `session.text.delta`; `session.interrupt` cancels the turn.
  The hook-replacement route keeps `model-duel.py` untouched while preserving
  user/assistant roles, which a flattened single-prompt call would lose.
- Prompt construction stays in Python (`model-duel.py` is unchanged); the server
  treats the assembled messages as opaque data and never edits the dialogue
  logic.
- The participant agent must deny editing, shell and recursive discussion tools,
  because the dialogue now runs as an agent step rather than a raw completion.
- Hidden sessions must be created in a directory that does not inject the user's
  project instructions, and must be removed after the turn. Whether a temp
  directory is enough is an open question for Task 3.

## Open questions (not blocking Task 2)

- Does a hidden-session prompt emit `session.text.delta` at a usable rate, and
  does `session.interrupt` settle within the 5-second cleanup budget?
- Does `session.create({ location: { directory } })` accept an arbitrary temp
  directory, and does that suppress project instruction discovery?
  **Answered 2026-11-06 (live):** it accepts it, but the directory becomes a
  separate location with its own plugin instances, so the creating instance's
  `context` hook never sees that session. Turn sessions must live in the
  plugin instance's own location; the hook clears `system` instead.
- Does a variant of a model survive `switchModel` and session creation?
- Are provider/model identifiers from `ctx.model.list()` stable enough to
  persist across restarts, including renamed or removed models?
