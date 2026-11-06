# Discuss Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a selectable Discuss primary agent, backed by a server-owned Python dialogue engine and a live TUI panel, with model selection and explicit handoff to Plan/Build.

**Architecture:** One package exports server, TUI and RPC parts. The server owns runs, storage and provider calls; Python owns dialogue sequencing and prompt construction. The TUI is a reconnectable view/controller, not the process owner.

**Tech Stack:** OpenCode 2.2.5 public Plugin API, TypeScript/Bun, Solid/OpenTUI, Python standard library, JSONL subprocess protocol.

**Spec:** The agreed direction in this conversation, captured in “Design baseline” below. This is a proposed implementation plan for user review; no implementation or installation is authorized by this file alone.

## Global Constraints

- Canonical project: `D:\MyProjects\opencode-discuss`.
- Target the user's installed OpenCode 2.2.5; current website documentation is not proof of availability in that release.
- No OpenCode core modifications, full Python-to-TypeScript port, or unrelated plugin/agent/config changes.
- Keep `scripts/model-duel.py` unchanged; extend `scripts/discuss-runner.py` around its existing functions.
- Use OpenCode's provider authentication; do not extract, copy, log or independently refresh OAuth credentials.
- Preserve the user's existing OpenCode proxy route. Verify proxy configuration on the actual generation-owning server process, not only on the TUI; do not assume environment changes propagate to an already-running service.
- Confirmed routing mechanism: Windows a proxy tool application rules, not assumed HTTP_PROXY settings. Observed OpenCode executable: `C:\Users\<user>\AppData\Roaming\npm\node_modules\@opencode\cli\bin\opencode.exe`. Current Discuss interpreter configured in cli.json: `<path-to-python>`. Direct-HTTP Discuss calls originate from the interpreter process, not `discuss-runner.py`; verify its actual socket-owning executable in a proxy tool during a run (interpreter launchers/venvs can spawn another executable). In the planned OpenCode-provider bridge, provider sockets should instead belong to OpenCode; confirm this rather than adding broad rules for all Python/Node processes.
- Proxying is optional deployment configuration, not a product requirement or geographic assumption. a proxy tool, the user's proxy names, Windows paths and regional routing belong only in local deployment notes/examples; never hardcode them into the plugin. Ordinary installations must work without a proxy. The supplied screenshot shows an enabled `opencode.exe` application rule and a higher-priority Localhost Direct rule; rule presence alone does not prove a provider connection used it.
- Direct Python HTTP calls, if retained, must use an explicitly verified compatible proxy configuration. No automatic direct-network fallback on proxy failure. Keep local OpenCode IPC and loopback model endpoints out of the external proxy where appropriate; verify rather than changing global routing.
- Do not start, stop or reload local model servers. Live tests use a model pair explicitly selected by the user.
- No paid generation during planning. Execution starts with offline tests; live tests require a disclosed request budget.
- Installation into the main configuration is a separate approval gate after isolated verification.
- Do not initialize Git, publish, or create commits without authorization. When a repository is available, keep task changes reviewable as separate commits.

## Design baseline

### User experience

1. Select Discuss alongside Plan and Build using the normal primary-agent selector.
2. Choose participants with `/discuss-models`: searchable model A, then searchable model B, then a confirmation showing the pair and limits. Escape at any step changes nothing.
3. Send a topic in ordinary chat. The Discuss agent invokes the discussion tool; replies stream into the panel. Slash start remains available as a deterministic alternative.
4. Stop, interject, change topic or close the panel. Closing the panel or disconnecting TUI does not stop the server-owned run.
5. Review full replies and history. Choose “Prepare for Plan” or “Prepare for Build”; preview the handoff and explicitly confirm before submitting to the target agent.

Before generation, show a compact launch review: actual A/B provider/model/variant, discussion mode, rounds, output limit, and which context will be sent. Default context is the topic plus explicitly supplied material; do not silently send the entire current chat, workspace or files to either provider. Both participants receive the chosen shared context and subsequent discussion; disclose that a cloud participant receives the other participant's replies too. Plain `/discuss-start` opens this review; the Discuss tool requires a confirmed launch specification rather than treating a model-generated claim of confirmation as user consent. Implement confirmation through a host-owned permission/form surface verified in Task 1.

First use never silently selects a hardcoded paid model pair. If no valid persisted or explicitly configured pair exists, require model selection. Restart always creates a new run and asks for confirmation; it is not resume. A failed/cancelled discussion can be inspected and handed off with its status, but automatic continuation/retry is out of scope for this release.

Discuss is an orchestrator, not a third debating participant. Its model call is additional overhead and must be visible in accounting. Discussion participants get no editing, shell or recursive discussion tools.

### Architectural choices and alternatives

- **Chosen direction:** primary agent as entry point, server plugin as owner, Python engine retained, TUI as view. This preserves live presentation and uses OpenCode providers without reimplementing authentication.
- **Agent only:** simpler, but insufficient for the existing dedicated panel, independent controls and durable run lifecycle.
- **TUI process plus CLI subprocess calls:** useful compatibility path, but does not fix ownership or multi-client persistence. Do not make this the primary architecture.

The preferred provider bridge is a correlated JSONL request from Python to the server, which performs generation through OpenCode. Whether 2.2.5 supports streaming, cancellation, message roles and output limits on a suitable public API is a mandatory first-task finding, not an assumption. If it does not, stop and present a bounded alternative before building the bridge.

### State and behavior

- Store discussions by location + sessionID + runID. A new run does not erase previous runs.
- Model identity includes providerID, modelID and optional variant, with independent side IDs `a` and `b`; display names are never lookup keys.
- Persist session settings and completed/partial history on the server. A running discussion has an immutable settings snapshot; selection changes apply to the next run.
- Initially allow one active run per plugin location, returning `busy` for another start; do not queue or silently serialize paid work. Multiple sessions still retain independent histories/settings.
- Terminal statuses are `completed`, `cancelled`, `failed`. Any missing/empty required participant reply is `failed`, even if earlier turns succeeded. Partial text remains available.
- Cancellation interrupts the current generation, not just the next turn; hard cleanup is bounded to 5 seconds. A service restart marks unfinished runs cancelled with reason `server_restart`; it never restarts paid calls automatically.
- Support `cooperative`, `critical`, `debate`; default `cooperative`. Critical mode requests concrete risks and verification rather than reflexive disagreement.
- Proposed initial settings: 2 rounds, 1200 max output tokens per turn, maximum 12 rounds, 120-second turn deadline, no automatic retries. These are product defaults, not claims that every reasoning model works within 1200 tokens.
- Round/output caps are not a total token or currency bound: input history, reasoning accounting, orchestrator calls and provider rules also matter. Display usage when returned and “unknown” otherwise. Do not offer a guaranteed monetary cap without reliable enforcement.

## Review Focus

- Two clients or stale callbacks must not overwrite or complete the wrong session/run.
- Disconnects and missed events must recover without lost/duplicated text or extra paid calls.
- One failed side, empty output, a stalled socket and cancellation must never become successful completion.
- Renamed/unavailable models, equal display names and cancelled selection must preserve valid settings/history.
- Handoff and transcript text are untrusted content, not permission to edit files, execute commands or start Build automatically.

## File structure

- `src/server.ts`: server plugin setup, registrations and cleanup.
- `src/rpc.ts`: shared schemas for RPC methods/events.
- `src/discussion/types.ts`: run, participant, settings, usage and event types.
- `src/discussion/service.ts`: authoritative run state and lifecycle.
- `src/discussion/store.ts`: durable storage, migration and ordered writes.
- `src/discussion/runner.ts`: subprocess management and JSONL framing.
- `src/discussion/provider.ts`: OpenCode generation bridge and cancellation.
- `src/discussion/handoff.ts`: deterministic reviewable handoff packet.
- `src/tui.ts`: commands and RPC connection setup; remove process/disk ownership.
- `src/ui/panel.ts`, `src/ui/models.ts`: full-text panel and transactional model selection.
- `agents/discuss.md`: installable primary-agent definition and narrow permissions.
- `scripts/discuss-runner.py`: structured dialogue adapter and correlated provider requests.
- `tests/unit/*.test.ts`, `tests/test_discuss_runner.py`: offline regression tests.
- `tests/live-plugin/tui.ts`, `tests/run-live.py`: isolated E2E with hard assertions.
- `package.json`, `README.md`, `.github/workflows/build.yml`: exports, commands, installation and offline CI.

## Task 1: Prove installed API compatibility

**Files:** create `docs/compatibility-2.2.5.md`, `tests/unit/compatibility.test.ts`.

**Interfaces:** produces an exact mapping of installed SDK types to RPC, generation, events, model list, agent registration/configuration, storage and handoff APIs.

- [ ] Inspect the installed 2.2.5 plugin/client declarations and package exports; compare with the official V2 server, RPC, TUI and agent documentation. Do not inspect credential files.
- [ ] Write a compatibility test importing the intended package exports; run `bun test tests/unit/compatibility.test.ts` and record actual failures before choosing APIs.
- [ ] Document the exact callable signatures for generating text with a selected model, roles, streaming, abort and output limits. Establish whether generation needs a dedicated restricted session or can use a tool-free generation API.
- [ ] Establish how to install/add the primary agent without overwriting existing agents; current documentation's AgentEditor has no `add`, so do not assume one exists.
- [ ] Verify a host-owned launch confirmation mechanism usable from both slash commands and agent tools, bound to sessionID and the exact launch specification. Include it in the compatibility stop gate if unavailable; do not use an LLM-supplied boolean as proof of consent.
- [ ] Identify the existing proxy mechanism without exposing credentials: environment HTTP(S) proxy, SOCKS, provider-specific setting or external process routing. Map TUI, background service, Python child and optional CLI child separately; record which process actually sends provider traffic. Do not alter the working proxy configuration.
- [ ] Verify the smallest offline server RPC request/event and TUI subscription using installed APIs. Record event ordering/location behavior and cleanup.
- [ ] Gate: if any requirement lacks public 2.2.5 support, report it and propose a compatibility choice. Do not silently upgrade OpenCode or promise streaming/caps the API cannot enforce.

## Task 2: Define state, contracts and durable history

**Files:** create `src/rpc.ts`, `src/discussion/types.ts`, `src/discussion/store.ts`, `tests/unit/store.test.ts`, `tests/unit/rpc.test.ts`.

**Interfaces:** `DiscussionKey = { location: string; sessionID: string; runID: string }`; `ModelRef = { providerID: string; modelID: string; variant?: string }`; `Settings = { a: ModelRef; b: ModelRef; mode: 'cooperative' | 'critical' | 'debate'; rounds: number; maxOutputTokens: number }`.

**RPC contract:** `start({sessionID, topic, requestID})`, `snapshot({sessionID, runID?})`, `history({sessionID})`, `stop({sessionID, runID})`, `interject({sessionID, runID, text})`, `topic({sessionID, runID, text})`, `models()`, `settingsGet({sessionID})`, `settingsSet({sessionID, settings})`, `handoff({sessionID, runID, target, confirm})`. Derive location from authenticated request/plugin context; validate session ownership. Start returns runID and snapshot. Mutations return acknowledged revision or a declared error.

**Event:** `updated` carries `{sessionID, runID, revision, kind, payload}` and uses the documented RPC event location envelope. Snapshots carry their revision. Expected errors include `busy`, `invalid_settings`, `not_found`, `model_unavailable` and `stale_run`.

- [ ] Write failing tests: sessions/locations remain isolated; histories retain successive runs; interrupted runs normalize to cancelled; corrupt state does not overwrite the only original; unavailable models do not destroy selections.
- [ ] Run `bun test tests/unit/store.test.ts tests/unit/rpc.test.ts`; confirm failures.
- [ ] Implement validated schemas and a plugin-storage-backed repository with serialized writes. Persist coalesced partial text at most once per second and flush on message/control/terminal transitions; never synchronously rewrite all history on every delta.
- [ ] Implement explicit one-time migration from the existing state file: preserve original backup, import only sessions whose location can be verified, report skipped records, and make repeated migration idempotent.
- [ ] Re-run tests; assert concurrent writes preserve increasing revisions and malformed RPC input never starts a run.

## Task 3: Bridge Python turns through OpenCode providers

**Files:** create `src/discussion/provider.ts`, `src/discussion/runner.ts`, `tests/unit/provider.test.ts`, `tests/test_discuss_runner.py`; modify `scripts/discuss-runner.py`.

**Interfaces:** `generateTurn(input: {model: ModelRef; messages: TurnMessage[]; maxOutputTokens: number}, signal: AbortSignal, onDelta: (text: string) => void): Promise<TurnResult>`. Define `TurnMessage` and `TurnResult` in `types.ts` from the verified API mapping; result includes text and optional actual usage/cost.

**Python protocol:** stdout `generate {requestID, side, messages, maxOutputTokens}`; stdin `delta {requestID, text}`, `result {requestID, text, usage?}`, `generation_error {requestID, message}`, or `control {command, text?}`. Python alone constructs prompts and sequences turns; TypeScript alone calls OpenCode. Serialize stdout writes; ignore stale request responses after cancellation.

- [ ] Write failing Python tests with a fake JSONL peer: two selected model identities, fragmented UTF-8, interjection/topic acknowledgement, immediate stop while awaiting a result, empty result and provider error.
- [ ] Run `python -m unittest discover -s tests -p "test_discuss_runner.py"`; confirm failures.
- [ ] Add server-bridge mode to the adapter, reusing engine prompt/transcript functions. Preserve the standalone engine and existing direct-HTTP adapter behavior as compatibility paths.
- [ ] Write failing TypeScript tests for split JSON lines, oversized/malformed messages, stderr-only output, missing Python, timeout, late result and a process that ignores stop.
- [ ] Implement provider and subprocess adapters using Task 1's verified signatures. No tools for participants, no recursive Discuss calls, no authentication reimplementation; enforce a 120-second turn deadline and cleanup within 5 seconds of cancel.
- [ ] In bridge mode Python emits generation requests over stdin/stdout only; provider traffic stays in the configured OpenCode server transport. For the optional direct-HTTP path, explicitly configure supported HTTP(S) proxy inheritance or a dedicated opener; Python urllib is not a native SOCKS client. Never pass proxy secrets in command arguments or logs, disable TLS verification, or silently bypass the proxy.
- [ ] Run `bun test tests/unit/provider.test.ts` and the Python command; assert no additional generation begins after cancellation and child resources are closed.

## Task 4: Server-owned service, RPC and tools

**Files:** create `src/server.ts`, `src/discussion/service.ts`, `tests/unit/service.test.ts`; modify `package.json`.

**Interfaces:** `DiscussionService.start(sessionID, topic, requestID)`, `stop(sessionID, runID)`, `snapshot(sessionID, runID?)`, `interject(sessionID, runID, text)`, `changeTopic(sessionID, runID, text)` implement Task 2's RPC contract and consume Tasks 2–3. Tools use the caller context's sessionID, never an arbitrary model-supplied session.

- [ ] Write failing tests for idempotent requestID, location-wide busy admission, stale callbacks, one-side failure after successful text, crash/exit without terminal event and exactly one terminal transition.
- [ ] Run `bun test tests/unit/service.test.ts`; confirm failures.
- [ ] Add failing tests for an unconfirmed tool start, a repeated confirmation/requestID, changed settings after confirmation and first use without a valid pair. Assert at most one run starts, and consent cannot be reused for a different topic/models/limits/context.
- [ ] Implement service ownership, RPC registration and tools with effective IDs `discuss_start`, `discuss_status`, `discuss_stop`, `discuss_interject`, `discuss_topic`, `discuss_result`. Tool start returns promptly with runID; result retrieval does not generate more turns.
- [ ] Implement the launch review/host confirmation before admitting any generation. Bind consent to a frozen specification; expose only explicitly selected shared context to Python/providers, never implicit full-session or workspace content.
- [ ] Surface cooperative/critical/debate through Python prompt policy without changing `model-duel.py`; add tests proving modes differ and controls affect the next turn.
- [ ] Add server/RPC/TUI package exports and build all entry points with compatible external dependencies.
- [ ] Re-run tests; assert closing a subscriber does not stop the run, unloading the server does stop work, and settings changes never modify an active run's frozen settings.

## Task 5: Reconnectable TUI and model selection

**Files:** modify `src/tui.ts`; create `src/ui/panel.ts`, `src/ui/models.ts`, `tests/unit/tui-state.test.ts`, `tests/unit/models.test.ts`.

**Interfaces:** TUI calls Task 2 RPC only. `selectModels(current: Settings, catalog: ModelRef[]): Promise<Settings | undefined>` commits both choices together. Catalog items additionally display real names, availability and variants; no hardcoded model presets.

- [ ] Write failing tests: cancel A/B/confirmation changes nothing; duplicate display names remain distinct; same model may occupy both sides; missing saved model is visible but cannot start; changes during a run apply next time.
- [ ] Write failing view-state tests for subscribe-before-snapshot races, duplicate/old revisions, revision gaps, session switch and reconnect; snapshot reconciliation must neither lose text nor restart generation.
- [ ] Run `bun test tests/unit/models.test.ts tests/unit/tui-state.test.ts`; confirm failures.
- [ ] Remove spawn, authoritative storage and status inference from TUI. Subscribe before fetching snapshots, buffer incoming events during fetch, apply newer contiguous revisions, and refetch on gaps/reconnect.
- [ ] Implement `/discuss-models` with searchable A/B selectors from the OpenCode catalog, variants and final confirmation. Do not equate model listing or `/models` HTTP success with a successful generation.
- [ ] Render scrollable full replies and partial output with side labels and model IDs; preserve scroll position during updates and provide follow-tail behavior. Keep ordinary composer typing untouched; panel-only shortcuts are focus-scoped.
- [ ] Keep `/discuss`, `/discuss-start`; add palette/slash actions for stop, interject, topic, restart and handoff. Advertise actual shortcut strings, not misleading `^X` labels for Ctrl+Shift+X.
- [ ] Make first use request a pair instead of silently falling back to MODELS. Distinguish “Restart as a new discussion” from any future resume action, and show a new-run confirmation.
- [ ] Re-run tests and build; verify a synthetic 24-reply long-text stream leaves input/session navigation usable without model calls.

## Task 6: Discuss agent and explicit Plan/Build handoff

**Files:** create `agents/discuss.md`, `src/discussion/handoff.ts`, `tests/unit/handoff.test.ts`; modify `src/server.ts`, `src/tui.ts`, `README.md`.

**Interfaces:** `buildHandoff(snapshot: DiscussionSnapshot): HandoffPacket`, with topic, model identities, status, agreements, attributed differences, open questions, transcript reference and usage. Where semantic synthesis is absent, label text as extracted positions rather than fabricated consensus. `handoff` uses the RPC contract with `target: 'plan' | 'build'` and `confirm: boolean`.

- [ ] Write failing tests for equal model display names, contradictory conclusions, failed/cancelled runs, prompt-injection text, repeated handoff and no-confirmation requests; no-confirmation must not submit a prompt or switch agents.
- [ ] Run `bun test tests/unit/handoff.test.ts`; confirm failures.
- [ ] Define the Discuss primary agent using Task 1's supported registration or installable agent file. Do not modify Plan/Build or set Discuss as the default agent. Deny editing/shell/recursive delegation and allow only the required discussion/read operations.
- [ ] Instruct the orchestrator to start one discussion per explicit request, report status without busy polling, retrieve results on request and never restart or hand off automatically. Show any orchestrator model overhead separately.
- [ ] Implement handoff preview followed by explicit user confirmation. After confirmation, use the verified session instruction/message API to attach the packet and switch the intended session agent; prompt submission is explicit and once-only. Build is never invoked just because discussion completed.
- [ ] Re-run tests; verify switching to Discuss does not unexpectedly change the session's selected model or participants, and switching away leaves history intact.

## Task 7: Enforce limits and repair verification

**Files:** create `tests/unit/limits.test.ts`; modify `tests/live-plugin/tui.ts`, `tests/run-live.py`, `README.md`, `.github/workflows/build.yml`.

**Interfaces:** settings validation enforces integer rounds 1–12 and positive maxOutputTokens within the selected model's advertised output limit when known. Before start show maximum participant calls `2 × rounds`, output settings and unknown costs; include handoff/orchestrator calls separately.

- [ ] Write failing tests for NaN/fractional/negative/huge limits, context overflow, unknown pricing/usage and a provider that cannot enforce the requested cap. Reject unsafe starts; do not silently claim a cap.
- [ ] Run `bun test tests/unit/limits.test.ts`; confirm failures, then implement validation, preflight and actual/unknown usage accounting without automatic retries.
- [ ] Make the live harness accept chosen model refs through explicit parameters; remove fixed endpoint/model/Python paths. Provide an explicit private storage/transcript root honored by both server and TUI test fixtures; do not rely on XDG_STATE_HOME overriding LOCALAPPDATA.
- [ ] Replace logged booleans with hard assertions: expected A/B identities and counts, streaming before terminal output, completed versus failed/cancelled, bounded stop latency, interjection/topic in subsequent request history, and full Unicode text equality.
- [ ] Test restoration by reopening the exact same session/run across two fresh processes, not by inspecting arbitrary records or creating an empty new session. Assert models, settings, messages and transcript survive.
- [ ] Add offline multi-client event-recovery tests, delayed generation UI responsiveness and 24-message full-text scrolling tests. A heartbeat alone is not proof that physical keyboard input works.
- [ ] Add privacy assertions: only the confirmed topic/context and discussion history appear in provider requests; unrelated session messages, workspace files and secrets do not. Verify untrusted transcript instructions cannot manufacture launch or handoff consent.
- [ ] Add offline proxy-routing tests with a recording local HTTP proxy/fake provider: external direct-HTTP traffic uses the configured proxy, loopback bypass works, proxy failure does not fall back to direct access, and bridge-mode Python opens no provider connection. For real OpenCode generation, verify the established proxy route using sanitized connection evidence during the approved live test, not by sending OAuth tokens to diagnostic endpoints.
- [ ] Include an ordinary no-proxy offline fixture and document optional external application routing separately from portable plugin settings. a proxy tool-specific connection verification applies to this user's Windows deployment, not all installations; never require a proxy tool or a proxy URL to start Discuss.
- [ ] Run `bun test`, `python -m unittest discover -s tests -p "test_*.py"`, `bun run build` and `python -m py_compile scripts/model-duel.py scripts/discuss-runner.py`; configure CI to run offline checks only.
- [ ] With user-approved models, perform a bounded live run: one round (two participant calls), no retries; separately approve any additional cancellation/failure probe. Report actual calls/usage and exact gaps, including physical input checks.

## Task 8: Safe installation and rollback

**Files:** modify `README.md`; create `docs/installation.md`.

- [ ] Record evidence from all preceding tasks, including installed version, model identities, failures and remaining limitations. Do not call a run green because the harness merely exited zero.
- [ ] Prepare a reviewed config diff. A combined server/TUI plugin belongs in `opencode.json(c)`; remove only its old TUI-only `cli.json` entry to avoid duplicate loading. Preserve every unrelated entry and option.
- [ ] Prepare adding only the new Discuss agent if file-based registration was selected. Back up both config files and any replaced Discuss-only definition; refuse an unexplained existing `discuss` agent collision.
- [ ] Ask for approval before applying the installation diff. Apply first in isolated configuration and verify one server registration, one TUI panel and one primary agent.
- [ ] After approval, back up files, install into the main configuration and use supported reload behavior; do not restart the background service merely to apply settings. Verify compatibility with 2.2.5 and document any restart actually demonstrated as necessary.
- [ ] Document rollback restoring the exact saved entries/files while retaining transcripts and the original migration backup. Do not overwrite config changes made after installation; show a targeted reverse diff instead.

## Completion criteria

- Discuss is selectable beside Plan/Build; normal text can start a visible two-participant discussion.
- A/B are selected from the real OpenCode catalog, with authentication handled by OpenCode, not copied tokens.
- Python still sequences the discussion; server owns execution; closing/reopening TUI preserves the run/history.
- Streaming, stop latency, errors, session isolation and restart restoration have assertions, not just log lines.
- Plan/Build receive reviewable results only after explicit user confirmation.
- Limits distinguish requests, output settings, actual usage and unknown cost; no false total-spend guarantee.
- Main installation happens only after approval, with backup and targeted rollback.

## Delivery checkpoints

1. **Compatibility report:** Task 1 only; no paid generation or main configuration changes. User reviews any unsupported API before implementation proceeds beyond the gate.
2. **Offline working integration:** Tasks 2–6 with fake providers, including agent entry, confirmation, model selection, reconnect and handoff. Demonstrate one coherent end-to-end path before adding optional conveniences.
3. **Verified candidate:** Task 7 with the user's approved pair and request budget; report failures and unknown usage honestly.
4. **Approved installation:** Task 8 only after a separate approval of the exact configuration diff.

Deferred conveniences: preset-pair management, automatic resume, concurrent runs in one location, automatic semantic synthesis, and custom proxy-management UI. None is needed for the first usable Discuss mode.

## Planning self-review

- All requested layers are covered: API compatibility (1), persistence/RPC (2), Python/provider bridge (3), server/tools (4), TUI/model selection (5), primary agent/handoff (6), budgets/tests (7), installation (8).
- Each Review Focus condition maps to named test cases in Tasks 2–7.
- Unproven 2.2.5 SDK details are isolated behind Task 1's stop gate rather than presented as established APIs.
- No implementation, dependency installation, live generation or main-configuration edits are part of preparing this plan.

---

# Phase 2 (added 2026-11-06): blockers, installation, live verification

**State at this point:** Tasks 1–6 are implemented and pass offline. Task 7 is partial, with offline tests green and no live run. Task 8 is not applied. The authoritative ledger is `.superpowers/sdd/2026-11-04-discuss-mode/progress.md`.

**Principle:** run first, then polish. Every runtime claim stays unproven until one bounded live run is recorded. Engineering follow-ups wait until that run shows which ones matter.

## Task 9: Fix pre-install blockers (found on resume review) — done 2026-11-06

**Files:** `src/discussion/runner.ts`, `src/server.ts`, new `src/paths.ts`, `src/ui/models.ts`, `src/tui.ts`; tests `tests/unit/runner.test.ts`, new `tests/unit/paths.test.ts`, `tests/unit/models.test.ts`.

- [x] **Deltas were dropped on the TypeScript hop.** `server.ts` passed `() => {}` as `onDelta`, so the panel only received full messages. `RunnerOptions.generate` is now `(request, signal, onDelta)`. The runner writes `delta {requestID, text}` to Python's stdin; empty pieces, pieces after stop and pieces for a settled request are dropped. `server.ts` forwards `onDelta` to `turns.run`.
- [x] Tests: deltas arrive in order with the request id before `result`, Cyrillic and emoji intact; no delta is sent after stop or after the request settled.
- [x] **The default runner path is package-relative.** `src/paths.ts` resolves `../scripts/discuss-runner.py` from `import.meta.url`; the bundle keeps the expression and resolves to the repository's `scripts/`. `options.runner` remains an override. Test: the path equals the package's runner and exists.
- [x] **Model selection by command** (user request 2026-11-06):
  - `/discuss-models` — selector A → selector B → confirmation (unchanged);
  - `/discuss-models <A>` — A typed, B from the selector, then confirmation;
  - `/discuss-models <A> <B>` — both typed, saved without a dialog;
  - `/discuss-model-a <A>`, `/discuss-model-b <B>` — change one side and keep the other (if no pair is saved, the other side goes through the selector and a confirmation).
  - References: `provider/model`, `provider:model`, optional `#variant`, case-insensitive, or a unique fragment of the id or display name. A fragment matching several models, or a model with variants typed without one, opens the selector narrowed to the matches. Disabled or unknown models are refused with a message, never substituted.
  - Choosing models is not consent to spend: `/discuss-start` and the `discuss_start` tool still confirm the pair, limits and topic.
  - `resolveChoice`/`splitArgs` in `src/ui/models.ts` are unit-tested (6 tests); the TUI wiring is not exercised outside a live TUI.
- [x] Verification: `bun test tests/unit` 87 pass, 0 fail; Python unittest 7 pass; `tsc` exit 0; `bun run build` ok; `python tests/run-live.py` → `{"ready": true}`, empty stderr.
- [x] `STATUS.md` corrected: streaming is implemented on both hops but unverified at runtime.

## Task 10: Install (separate approval gate, Task 8 applied) — applied 2026-11-06, reload check pending

**Files:** `~/.config/opencode/opencode.json`, `~/.config/opencode/cli.json`, `~/.config/opencode/agents/`. These are user configuration, outside the repository.

- [x] Show the exact diff and get explicit approval before changing anything (approved 2026-11-06):
  - `opencode.json` → append to the existing `"plugins"` array (keep the `usage-monitor` entry and every other key):
    ```jsonc
    {
      "package": "D:/MyProjects/opencode-discuss",
      "options": { "python": "<path-to-python>" }
    }
    ```
    `runner` is no longer needed after Task 9; the default resolves to the package's own script.
  - The old options `a`, `aUrl`, `b`, `rounds` and `maxTokens` are not carried over. There is no silent default pair, and models are chosen with `/discuss-models`.
  - `cli.json` → remove only the `D:/MyProjects/opencode-discuss` object from `"plugins"`. Keep `recent-models` and `voice-alerts`.
- [x] Back up both files with a dated suffix (`*.before-discuss-server-20261106.bak`), matching the existing backup convention in that directory.
- [x] Copy `agents/discuss.md` and `agents/discuss-participant.md`. There is no collision: only `vk-cleaner.md` and `vk-online.md` exist there now.
- [ ] Reload (`/reload`). Verify there is exactly one Discuss server registration, one panel and one `discuss` agent, and no duplicate TUI part.
- [ ] Rollback is restoring the two backups and deleting the two agent files. If the configuration changed after installation, show a targeted reverse diff instead of overwriting it.

## Task 10a: Commands work from the home screen — done 2026-11-06

**Found during the post-install check:** on the home screen there is no session, and every Discuss command returned silently (`if (!sessionID) return`).

- [x] `ensureSession()` in `src/tui.ts`: when no session is open, `/discuss`, `/discuss-models`, `/discuss-model-a`, `/discuss-model-b` and `/discuss-start` create an empty session titled “Discuss” with agent `discuss`, the prompt's selected model and the TUI location, using `context.client.session.create` (2.2.5 `SessionCreateInput`). They then navigate to it with `ui.router.navigate`. Creating a session sends no message and makes no model call.
- [x] If creation fails, a toast says so instead of a silent no-op.
- [x] `/discuss-start` asks for the topic before creating a session, so cancelling leaves nothing behind. Argument usage errors are reported before any session is created. Cancelling a model selector after creation leaves an empty session (accepted).
- [x] `/discuss` opens the panel once the router shows the new session (bounded retry, 10 × 50 ms), otherwise it shows a toast.
- [x] Run controls (stop, interject, topic, restart, handoff) stay silent without a session or run, because they are global chords and a toast on every stray keypress would be noise.
- [x] Verification: `tsc` exit 0 against the real `SessionCreateInput` type; 87 unit tests pass; build ok; `run-live.py` ready. Not unit-tested, because the TUI module needs OpenTUI; check it live in Task 11.

## Task 10b: One state per session location, settings command — done 2026-11-06

**Found during the post-install check (OpenCode DB, read only):** the pair chosen from the TUI was stored under location `C:\Users\<user>`, but the session lives in `D:/MyProjects/opencode-discuss`. OpenCode runs one server plugin instance per location. A TUI RPC without a location lands in the default instance, while the `discuss_*` tools run in the session's own location, so a chat-started discussion would answer “No models selected”. All instances also rewrote the single key `discuss/state` as a whole, so they could erase each other's writes, and a newly started instance cancelled “running” runs of other live locations.

- [x] **TUI routing:** every RPC carries `{ location: { directory } }` of its session (2.2.5 `RpcCallOptions.location`). The directory comes from `context.data.session.get`, then `client.session.get`, and is cached; a created session is cached from its `SessionInfo`. This is implemented as a proxy around the RPC client, so no call site can forget it.
- [x] **Ownership check on the server:** `belongs(sessionID)` compares the session's reported directory with the instance location (normalized: slashes, trailing slash, drive-path case). It backs `verifySession` for start, and `settingsSet` now refuses another location's session with `not_found`.
- [x] **Per-location storage key:** `discuss/state@<sha256(normalized location)[:16]>` (`src/discussion/location.ts`). An instance reads and writes only its own key, so restart recovery only touches its own runs.
- [x] **One-time adoption:** when an instance's key does not exist yet, it copies records from the legacy `discuss/state` whose session the host places in this location, whatever location the record claims. This moves the misfiled `C:\Users\<user>` record to the project. The legacy key is left untouched as a backup.
- [x] **`/discuss-settings`:**
  - without arguments it shows the pair, mode, rounds, output limit and ceiling;
  - `rounds=1..12`, `tokens=16..32000` and `mode=cooperative|critical|debate` (aliases `r`, `t`/`max`/`output`, `m`; `:` also works) change the settings and keep the models;
  - any invalid or repeated key refuses the whole change;
  - it requires a saved pair.
- [x] Tests: 13 new (store isolation and adoption ×5, locations ×4, settings parser ×4). Totals: 100 unit tests pass, 7 Python tests pass, `tsc` exit 0, build ok, `run-live.py` ready.
- [ ] Live check: after reload the project instance has its own key containing the adopted pair; `/discuss-settings` works; a chat-started `discuss_start` sees the same settings as the TUI.
- [ ] Open: `/discuss` did not visibly open the panel in the 2026-11-06 screenshot. It is unknown whether the command was run; re-check it live.

## Task 10c: Readable toasts and an always-on TUI journal — done 2026-11-06

**Reason:** the user could not read the toasts before they vanished, and diagnosing the TUI depended on screenshots.

- [x] Every Discuss toast goes through one helper with `duration: 10000` (previously the host default; the handoff toast had 8000).
- [x] TUI journal (`src/ui/log.ts`), on by default:
  - location: `%LOCALAPPDATA%\opencode-discuss\logs\tui.jsonl`, or `$XDG_STATE_HOME/…`;
  - `DISCUSS_LOG=<file>` overrides the location, and `DISCUSS_LOG=off` disables it;
  - one JSON line per event with an ISO timestamp, rotated at about 1 MB to a single `.1` file;
  - it never throws.
- [x] Events written to the journal:
  - `setup` with the journal path and TUI location;
  - `command` with the id, the argument shape (`text(n)`/`empty`/`none`, never the text) and the route, plus `command-failed`;
  - `rpc` with the method, sessionID, target location, ok/code/error and duration;
  - `toast` with the variant and message;
  - `panel-open` attempts and their result;
  - `panel-current` whenever the Discuss panel opens or closes;
  - `route` changes, `session-created`, `location-lookup-failed`, `refresh-failed`, `started`.
- [x] Commands are wrapped for journaling with `satisfies KeymapCommand[]`, so command shapes stay type-checked.
- [x] Tests: 5 new (`tests/unit/log.test.ts`: path and override, line format, rotation, no-throw, text shape). 105 unit tests pass, `tsc` 0, build ok, `run-live.py` ready.
- [ ] Live: after `/reload` the journal file appears, and its entries explain any panel or command problem.

## Task 11: First bounded live run (budget approval gate)

- [ ] The user picks the pair with `/discuss-models <A> <B>` and approves the budget. No pair is assumed by the plan or the code. The local `local/test-model` and `local-2/test-model-2` are test models only: usable for a free smoke run if their servers are already running (the agent does not start or stop them), never a default.
- [ ] From the home screen, `/discuss-models` creates and opens a Discuss session (Task 10a); `/discuss` opens the panel there.
- [ ] Also exercise the command forms live: an exact id, a `provider:model` form, an ambiguous fragment (narrowed selector), an unknown id (refusal), and `/discuss-model-b` keeping A.
- [ ] Settings for the run, set with `/discuss-settings rounds=1 tokens=300 mode=cooperative`: 1 round, 2 participant calls, `maxOutputTokens` 300, a short Cyrillic topic with one emoji. No retries.
- [ ] Record each of the following in `STATUS.md` with evidence, not just "harness exited 0":
  1. Discuss appears beside Plan/Build, and `/discuss-models` selection plus confirmation works.
  2. **Context hook:** the participant receives only the dialogue, with no project instructions, system prompt or tools. Check this from the transcript or a debug log of the hidden-session request.
  3. **Deltas** appear in the panel before the full message.
  4. The terminal status is `completed`, with two participant replies.
  5. The transcript is under `%LOCALAPPDATA%\opencode-discuss\transcripts`, not in the project.
  6. Cyrillic and emoji survive byte-for-byte.
  7. Hidden turn sessions do not clutter the user's session list, or the clutter is documented.
- [ ] Second probe, approved separately: start a 2-round run and press `ctrl+shift+x` mid-reply. Record stop latency, whether generation actually stops (check the local server log or token flow), status `cancelled`, and that no further generation request follows.
- [ ] Only after this, run a cloud pair (for example `deepseek` via OpenCode) to confirm that provider traffic is owned by `opencode.exe` under the existing a proxy tool rule and that Python opens no provider socket.
- [ ] Triage every finding into blocking/non-blocking items before Task 12. Answer the open questions in `docs/compatibility-2.2.5.md` from the evidence.

## Task 11a: Turn sessions in the instance's own location — done 2026-11-06 (offline)

**Found by the first live run (`3e9218a8`):** both participants answered “no discussion to continue”.
- Cause: hidden turn sessions lived in `%TEMP%\opencode-discuss\turns`, a separate location with its own plugin set. That location's Discuss instance has an empty turn registry, so its `context` hook left the messages alone and the model saw only `"Continue the discussion."` plus superpowers' skill preamble.
- The run was still `completed`.

- [x] `src/server.ts`: turn sessions are created in `ctx.location.directory`, the same instance whose hook knows the turn's messages. The hook clears `system` and `tools`, so project instructions and tools do not reach participants. Superpowers loads before Discuss, so our hook runs last.
- [x] Guard: the hook calls `registry.markApplied(sessionID)` after replacing messages, system, tools and the output cap. With `requireContextHook: true` (set by the server), a turn that succeeds without that mark is rejected: `TurnError("provider", "context hook did not apply …")`. Python then records an error, the reply is missing, and the run becomes `failed`, not `completed`. `release` clears the mark, so a late hook call cannot mark a finished turn.
- [x] Tests: 2 new in `tests/unit/provider.test.ts` (a reply without the hook is rejected; a reply after the hook resolves, and a late mark is ignored). 107 unit tests pass, 7 Python tests pass, `tsc` 0, build ok, `run-live.py` ready.
- [ ] Live re-run with the same topic and budget (2 calls × 300 tokens): replies are on topic; the journal and DB show turn sessions in `D:\MyProjects\opencode-discuss`, removed after each turn; superpowers text does not appear in replies.
- Side effect: while a turn runs, a session titled “discuss: provider/model” is briefly visible in the project's session list.

## Task 11b: One request per turn, real errors, request count — done 2026-11-06 (offline)

**Found by run `47127f3c`:** DeepSeek hit the 300-token cap. OpenCode 2.2.5 then continued twice on its own, adding a synthetic “output limit” user message each time. Our hook restored the original dialogue on each continuation, so the steps were truncated again and the session failed. That turn cost 3 requests, and the run made 4 instead of 2. The panel only said “generation failed”.

- [x] **No hidden continuations:**
  - the `context` hook counts requests per turn (`TurnRegistry.step`);
  - a second request for the same turn is a host continuation: it is marked truncated and shrunk to `Stop.` with no system, no tools and the minimum output cap, in case it is sent before the interrupt lands;
  - with `stopOnContinuation` (set by the server), the turn runner interrupts the session at once;
  - if the turn already has visible text, it is returned with `[truncated at the output limit]`;
  - if it has none, the turn fails as `output_limit`, suggesting `/discuss-settings tokens=…`.
- [x] **Real errors:** `session.execution.failed` now carries the host's `error.type: error.message`, and `session.execution.interrupted` is handled with its reason.
- [x] **Request accounting:**
  - `TurnResult.requests` and `TurnError.requests` hold the count;
  - the server calls `service.recordRequests`, and `store.addRequests` sums it into `run.usage.requests`, which is persisted and validated;
  - the panel shows “Model requests: N of M planned”, marking overruns.
- [x] Tests: 5 new (provider ×4: one request per normal turn, truncated text kept and marked, output-limit error without text, registry ignores unknown turns; store ×1: sums and persistence). 112 unit tests pass, 7 Python tests pass, `tsc` 0, build ok, `run-live.py` ready.
- [ ] Live re-run with `/discuss-settings tokens=1000`: 2 requests in total, both replies on topic, and the request line in the panel.
- Known limit: a continuation request may still reach the provider before the interrupt (it is shrunk to the minimum). The count in the panel includes it.

## Task 11c: Previous pair for new sessions, one TUI generation — done 2026-11-06 (offline)

**Run `dce6a216` passed** (2/2 replies on topic, 2 of 2 requests). Two problems surfaced afterwards:
- in a new session the user had to choose models from scratch;
- `/reload` left earlier TUI generations alive (duplicate events, duplicate snapshot RPCs).

- [x] **Previous pair, offered explicitly:**
  - the store keeps `last` (the settings most recently saved in the location), falling back to the newest run's settings for older state;
  - a malformed `last` is dropped, never blocking the load;
  - `settingsGet` returns `last`;
  - in a session without a pair, `/discuss-models` (no arguments) and `/discuss-start` first offer “Use previous pair: A vs B” with mode, rounds, limit and ceiling, or “Choose models…”;
  - nothing is applied unless picked;
  - after choosing, `/discuss-start` continues to its own start confirmation instead of stopping.
- [x] **One TUI generation per process:**
  - effects, the panel slot and the keymap layer are created under a `createRoot` owner;
  - a new generation disposes the previous one, registered on `globalThis` under `Symbol.for("opencode-discuss.tui.generation")`, then registers its own `dispose`, which is also returned to the host;
  - a disposed generation ignores RPC events, returns `false` from commands (so the live layer handles them) and writes nothing to the journal;
  - the journal records `setup {generation, replaced}`, `dispose` and `ready`.
  - Separate OpenCode windows are separate processes and are unaffected.
- [x] Tests: 3 new (store: `last` per location and reload, fallback to the newest run, malformed `last`). 115 unit tests pass, 7 Python tests pass, `tsc` 0, build ok, `run-live.py` ready. The generation handover is TUI-only and is not unit-tested.
- [x] Live check 1 (11:57Z) failed. `/discuss-models` was handled by a generation loaded before 11c (RPC order `models` → `settingsGet`, no offer). Every new generation logged `generation: 1, replaced: null`, so generations do **not** share `globalThis`, and route events were logged 6×.
- [x] Fix: the handover now uses `context.storage.memory("discuss.tui.generation")`, which the host documents as shared by old and new generations of one TUI. Every journal line carries `pid` and `gen`, because several OpenCode windows write to the same journal. 115 unit tests pass, `tsc` 0, build ok.
- [x] Regression found after the full restart (12:00Z): TUI setup failed with `Keymap.Provider is missing` (host log: `plugin operation failed … stage=setup`), so no Discuss commands existed. Cause: `keymap.layer` and the slot were created under our own `createRoot`. Fix: only our effects live under that root; the slot (removed via its return value) and the keymap layer stay in the host owner, and a disposed generation's commands return `false`.
- [x] New offline check `tests/run-tui-smoke.py`: a private standalone OpenCode loads only this plugin on the TUI side and waits for `ready` in a private journal, reporting host `plugin operation failed` lines. Verified both ways: it passes on the fixed build and fails on a build with an injected setup error. **Side effect of that negative check:** the user's running TUI hot-reloaded the deliberately broken `dist/tui.js` and lost Discuss for about 40 s, until the file was restored. Never inject faults into `dist/` while a user TUI watches it; use a copy of the package.
- [x] Live (user TUI pid 51496, hot reloads after builds): `dispose gen 3 → setup gen 4 → ready`, then `dispose gen 4 → setup gen 5 → ready`, each event logged once. The generation handover works.
- [x] The generation registers its `dispose` before creating anything; resources add their cleanups as they are created. A setup that throws half way can therefore still be disposed by the next generation. The 12:00Z failed generation 1 predates this and lives until the next full restart.
- [x] **Live check 2 passed (12:07Z, pid 51496, gen 5):**
  - `/discuss-models` on the home screen created session `ses_e4f3e9d6…`;
  - `settingsGet` led to the previous-pair offer, the user picked it, and `settingsSet` saved it;
  - the new session holds `deepseek-flash#low vs gpt-6-luna#medium`, 1 round, 1000 tokens;
  - the next hot reload ran `dispose gen 5 → setup gen 6 → ready`.
- Known cosmetic issue: `setup.replaced` logs `null` even when a previous generation was disposed (reading `id` from the memory-store proxy). The `dispose` lines are authoritative.
- Not a plugin defect: on one attempt the user sent ` /discuss-models` with a leading space while in the **Build** agent. It went to chat, and Build spent about 33k input tokens (~$0.007) exploring with read-only tools. It also read `~/.config/opencode/opencode.json`, which holds plaintext MCP tokens, so those tokens were sent to the provider.
- [ ] Old plan text, superseded: Live check 2 after a **full OpenCode restart**, which removes generations that predate the handover and cannot be reached by it, then `/reload` twice: the journal shows `setup … replaced: N` and `dispose` lines, each event once per pid, and a new session offers the previous pair.

## Task 11d: Run controls as commands, readable panel, dialog journal — done 2026-11-06 (offline)

**Found by the stop probe (run `ed493ecc`, 12:14Z):** the user pressed `ctrl+shift+x`, but no `discuss.stop` reached the plugin, and the run completed (4 of 4 requests, within the approved ceiling). The terminal most likely delivers `ctrl+shift+<letter>` as `ctrl+<letter>`, and `ctrl+x` is OpenCode's leader key. Stop, interject, topic, restart and handoff had no slash or palette entry, so they were unreachable. The user also reported that the panel was one colour, so speakers and model lines ran together, and that it was unclear who said what. Earlier, a cancelled topic dialog ended `/discuss-start` silently.

- [x] **Commands:**
  - `/discuss-stop`, `/discuss-interject <text>`, `/discuss-topic <text>`, `/discuss-restart` and `/discuss-handoff`, all also in the palette; the `ctrl+shift+…` binds remain as extras;
  - each control first refreshes the server snapshot, so a lagging view cannot hide a running run;
  - each says why it did nothing (no session, no running discussion, no text) and confirms what it did (“Stopping the discussion…”, “Remark sent…”).
- [x] **Panel** (`src/ui/panel-style.ts`, colours from the active OpenCode theme with fallbacks):
  - a header with a bold title, the status in its feedback colour (completed green, failed red, cancelled yellow, running blue) and `n/m replies`;
  - separate **A** and **B** model lines in two categorical colours;
  - every reply is a block with a coloured bar on the left and a bold header `A · model · round N · Ns` (or `B …`, `You …`, `Topic change`);
  - the live reply is shown with a thin bar and muted text, marked “writing…”;
  - requests (yellow on overrun), the error (red), the transcript and history are muted below;
  - the footer lists the slash commands that fit the current state.
- [x] **Dialog journal:** `dialog-open` and `dialog-close` with the kind, the title and the result shape (never text). A start without a topic or a declined confirmation now shows “Not started…”.
- [x] Bold is the inlined constant `1 << 0` (`TextAttributes.BOLD`), so the bundle imports no extra host module.
- [x] Tests: 5 new (`tests/unit/panel-style.test.ts`). 120 unit tests pass, `tsc` 0, build ok, `run-tui-smoke.py` ready. The user's TUI hot-reloaded to gen 7 with no host failure.
- [ ] Live: the panel is readable; the stop probe via `/discuss-stop` (budget up to 4 requests, expected 1–2) gives `cancelled` with no further turn.
- Panel rendering is not covered by the TUI smoke test, because no panel is opened there.

## Task 11e: Mandatory start consent, verbatim topic, closing the panel — done 2026-11-06 (offline)

**Found by the chat-started run `e5b7bb05` (12:32Z):** the run completed (2/2 replies, 2 participant requests, 3 orchestrator requests ≈ $0.0006). Three problems:
- **No consent prompt was shown** (the user confirmed this). `permission.assert` prompts only when the rules say “ask”; the agent had no rule for `discuss.start`, so OpenCode allowed the paid start silently. This violates the core consent rule.
- The orchestrator rewrote the topic, adding “разработчиков”, “(монорепо)” and “3–5 тезисов с рекомендацией”.
- The panel could not be closed.

- [x] **Consent:**
  - `src/discussion/consent.ts` `requireConsent` turns any non-deny evaluation of `discuss.start` into `ask` (a deny stays a deny); the server registers it as a `permission.hook("evaluate")` and disposes it on unload;
  - `agents/discuss.md` adds the rule `discuss.start: ask`;
  - the installed copy in `~/.config/opencode/agents/` was updated, with a backup `discuss.md.before-consent-20261106.bak`.
- [x] **Verbatim topic:** an agent rule to pass the user's topic as written, in their language, without added formats or lengths, and to ask when the request is ambiguous.
- [x] **Panel:** `/discuss` now toggles the panel, `/discuss-close` closes it (also in the palette), and the footer says “/discuss closes this panel”.
- [x] **Server journal** on by default, at `%LOCALAPPDATA%\opencode-discuss\logs\server.jsonl` (`DISCUSS_LOG` override or `off`). Each line carries pid and location. It records `consent-evaluate {before, after}`, `consent-requested`, `consent-granted`, `consent-refused`, `tool-start` and `server-ready`.
- [x] Tests: 3 new (`tests/unit/consent.test.ts`). 123 unit tests pass, `tsc` 0, build ok, `run-live.py` ready (the hook registers), `run-tui-smoke.py` ready. The user's OpenCode reloaded the server in all 4 locations.
- [x] Live (13:03Z and 13:05Z, runs `ccd6a742` and `37851603`):
  - the permission prompt was shown both times (server journal `consent-evaluate before=ask after=ask`; the agent rule applies), and the user allowed after 5 s and 2 s;
  - each run completed with 2 requests;
  - both topics went through verbatim;
  - `/discuss` closed the panel (`panel-close via=toggle`).
- [x] Refusal (13:09Z):
  - `consent-requested`, `consent-evaluate ask`, then `consent-refused` 3.3 s later;
  - no `tool-start`, no new run, no participant request;
  - the agent did not retry and did not claim consent.
  - **Wording gap:** the host's rejection error has an empty message, so the agent reported “Запуск не удался… Tool.Error без деталей” and guessed at causes, instead of saying the user declined.
- [x] Refusal wording fix (offline):
  - `explainRefusal` fills an empty `message`, or `reason`, on the host's rejection error with `DECLINED_MESSAGE`, and the same object is rethrown as the host requires;
  - the journal now records the error's name and keys (`errorShape`);
  - an agent rule says that a failure right after the confirmation means the user declined: say so, do not guess, do not retry;
  - the installed agent copy was updated;
  - 4 new tests; 127 unit tests pass, build ok, both smoke tests ready.
- [x] Live (13:15Z): rejected again. The tool result carried the declined text and the agent answered “Запуск отклонён… ничего не начато, ни один модельный вызов не потрачен”, without retrying. The error is `Permission.DeclinedError` with only `_tag`; no new run.
- [ ] Not yet exercised live: the hook turning a configured `allow` into `ask` (unit-tested; live the agent rule already produced `ask`).

## Task 12: Hardening, ordered by risk

Do these after Task 11, highest priority first, and reorder them if live findings say otherwise.

1. [ ] **Hard kill within 5 seconds of stop.** Sequence: stop command, then abort, then a 5-second timer, then kill. On Windows use `taskkill /PID <pid> /T /F` so that child processes die too. Test with a fake child that ignores stop.
2. [ ] **Preflight before start:** the saved model still exists in `ctx.model.list()`, it is chat-capable, and `maxOutputTokens` ≤ the model's advertised output limit when that limit is known. Return `model_unavailable` or `invalid_settings` on start rather than failing mid-round.
3. [ ] **`tests/unit/tui-state.test.ts`:** cover subscribe-before-snapshot, duplicate and old revisions, revision gaps that trigger a refetch, and session switching. Extract the reducer from `src/tui.ts` if needed so it is testable without OpenTUI.
4. [ ] **Delete `tests/live-plugin/`.** The harness is obsolete and imports a missing `activate`. Update the README and the plan's file list accordingly.
5. [ ] **Usage in bridge mode:** forward provider usage events from the turn session into `result.usage`, and show it in the panel and handoff, or "unknown" when absent. Keep orchestrator overhead in a separate line labelled as not attributed.
6. [ ] **Handoff live check:** the preview blocks while running, confirmation is required, it submits exactly once, and it switches the agent without changing the session model. Do this only after items 1–3.
7. [ ] Lower priority: the exact `LineDecoder` byte cap when a chunk contains a newline, and pruning of the idempotency map.

## Task 13: Project hygiene (needs authorization where noted)

- [ ] Add a short `AGENTS.md` (and a `CLAUDE.md` pointing to it) with:
  - the verification commands;
  - "never edit `~/.config/opencode` without approval";
  - "`model-duel.py` is frozen";
  - pointers to `STATUS.md` and the progress ledger.
- [ ] With authorization, initialize a local Git repository on branch `master` before the Task 12 changes so that each task is a reviewable commit. Do not publish.
- [ ] Keep `STATUS.md`, `TODO.md` and the ledger updated after each task.

## Phase 2 delivery checkpoints

1. **Blockers fixed:** Task 9, offline green, no configuration touched. — done 2026-11-06
2. **Installed:** Task 10, after diff approval.
3. **Live-verified candidate:** Task 11, after budget approval; findings recorded honestly.
4. **Hardened:** Task 12 items 1–4 done; handoff verified live.
