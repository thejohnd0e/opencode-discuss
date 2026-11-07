import { Plugin } from "@opencode/plugin"
import { Message } from "@opencode/ai/effect"
import { mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DiscussRpc } from "./rpc"
import { buildHandoff } from "./discussion/handoff"
import { appendFileSync } from "node:fs"
import { createTurnRunner, TurnRegistry, type HostEvent, type SessionHost, type TurnMessage } from "./discussion/provider"
import { createRunner } from "./discussion/runner"
import { DEFAULT_RUNNER } from "./paths"
import { errorShape, explainRefusal, requireConsent, START_ACTION } from "./discussion/consent"
import { outputLimits, preflight, type CatalogModel } from "./discussion/preflight"
import { stepUsage, type StepUsage } from "./discussion/usage"
import { createLog, logPath } from "./ui/log"
import { sameLocation, sessionDirectory } from "./discussion/location"
import { DiscussionService, type ServiceEvent } from "./discussion/service"
import { DiscussionStore } from "./discussion/store"
import { dialogueReplies, isDialogueReply, MIN_OUTPUT_TOKENS, type ModelRef, type Run, type Settings, type Storage } from "./discussion/types"

const PARTICIPANT_AGENT = "discuss-participant"
const TURN_TIMEOUT_MS = 120_000

function modelRef(spec: string): ModelRef {
  const [providerID, rest] = spec.split(":")
  const [modelID, variant] = (rest ?? "").split("#")
  return { providerID, modelID, ...(variant ? { variant } : {}) }
}

function stateDir(): string {
  const base = process.env.LOCALAPPDATA ?? process.env.XDG_STATE_HOME ?? tmpdir()
  return join(base, "opencode-discuss")
}

export default Plugin.define({
  id: "discuss",
  async setup(ctx) {
    // Server journal, on by default next to the TUI journal (logs/server.jsonl).
    // DISCUSS_LOG=<file> overrides it (the isolated smoke test relies on that),
    // DISCUSS_LOG=off disables it. Several location instances share the file,
    // so every line names its process and location.
    const journal = process.env.DISCUSS_LOG?.trim() ? logPath() : join(stateDir(), "logs", "server.jsonl")
    const write = createLog(journal)
    const log = (stage: string, details: Record<string, unknown> = {}) =>
      write(stage, { pid: process.pid, location: ctx.location.directory, ...details })
    // A session belongs to this plugin instance only when OpenCode reports it in
    // this instance's location. Everything else (another project, the home
    // directory instance) must not read or write its state.
    const belongs = async (sessionID: string): Promise<boolean> => {
      try {
        const info = await ctx.session.get({ sessionID } as never)
        return sameLocation(sessionDirectory(info), ctx.location.directory)
      } catch {
        return false
      }
    }
    const store = await DiscussionStore.open(ctx.storage as unknown as Storage, {
      location: ctx.location.directory,
      belongs,
    })
    // Hidden turn sessions live in this instance's own location. OpenCode runs a
    // separate plugin set per location, and only this instance's `context` hook
    // knows the turn's messages; a session elsewhere (as the earlier temp
    // directory was) gets another instance's hook and the participant sees no
    // dialogue. Project instructions do not leak in: the hook clears `system`.
    const directory = ctx.location.directory

    const registry = new TurnRegistry()
    const host: SessionHost = {
      async create(input) {
        const created = await ctx.session.create({
          title: input.title,
          agent: input.agent,
          model: { providerID: input.model.providerID, id: input.model.modelID, ...(input.model.variant ? { variant: input.model.variant } : {}) },
          location: { directory: input.directory },
        })
        return { sessionID: created.id }
      },
      async prompt(sessionID, text) {
        await ctx.session.prompt({ sessionID, text })
      },
      async interrupt(sessionID) {
        await ctx.session.interrupt({ sessionID })
      },
      async remove(sessionID) {
        await ctx.session.remove({ sessionID })
      },
      subscribe(listener) {
        const controller = new AbortController()
        void (async () => {
          for await (const event of ctx.event.subscribe({
            types: [
              "session.text.delta",
              "session.step.ended",
              "session.step.failed",
              "session.execution.succeeded",
              "session.execution.failed",
              "session.execution.interrupted",
            ],
            signal: controller.signal,
          })) {
            if (event.type === "session.text.delta") {
              listener({ type: "delta", sessionID: event.data.sessionID, delta: event.data.delta })
            } else if (event.type === "session.step.ended" || event.type === "session.step.failed") {
              const usage = stepUsage(event.data)
              if (usage) listener({ type: "usage", sessionID: event.data.sessionID, usage })
            } else if (event.type === "session.execution.succeeded") {
              listener({ type: "succeeded", sessionID: event.data.sessionID })
            } else if (event.type === "session.execution.interrupted") {
              listener({ type: "failed", sessionID: event.data.sessionID, message: `interrupted (${String((event.data as { reason?: unknown }).reason ?? "unknown")})` })
            } else {
              // Keep the host's own explanation, e.g. a provider error or an output-limit failure.
              const error = (event.data as { error?: { type?: unknown; message?: unknown } }).error
              const detail = [error?.type, error?.message].filter((part) => typeof part === "string" && part).join(": ")
              listener({ type: "failed", sessionID: event.data.sessionID, message: detail || "generation failed" })
            }
          }
        })()
        return () => controller.abort()
      },
    }

    // Starting a discussion spends money on two providers, so it always needs
    // the user's explicit approval. `permission.assert` only prompts when the
    // rules say "ask"; with no rule (live finding 2026-11-06, run e5b7bb05) or a
    // saved "allow", OpenCode allowed it silently. This hook turns any non-deny
    // outcome for `discuss.start` into "ask". A deny stays a deny.
    const consentHook = await ctx.permission.hook("evaluate", (event) => {
      if (event.action !== START_ACTION) return
      const before = event.effect
      requireConsent(event)
      log("consent-evaluate", { sessionID: event.sessionID, before, after: event.effect })
    })

    const contextHook = await ctx.session.hook("context", (event) => {
      const request = registry.get(event.sessionID)
      if (!request) return
      if (registry.step(event.sessionID) > 1) {
        // A second request for the same turn is OpenCode continuing after the
        // output limit. Mark it so the turn ends with the text so far, and make
        // this request as small as possible in case it is sent before the
        // interrupt lands.
        registry.markTruncated(event.sessionID)
        event.messages = [Message.user("Stop.")]
        event.system = []
        event.tools = {}
        event.options.maxTokens = MIN_OUTPUT_TOKENS
        return
      }
      event.messages = request.messages.map((message) =>
        message.role === "system"
          ? Message.system(message.content)
          : message.role === "assistant"
            ? Message.assistant(message.content)
            : Message.user(message.content),
      )
      // Participants get only the dialogue: no host instructions and no tools.
      event.system = []
      event.tools = {}
      event.options.maxTokens = request.maxOutputTokens
      registry.markApplied(event.sessionID)
    })

    const turns = createTurnRunner(host, {
      agent: PARTICIPANT_AGENT,
      directory,
      timeoutMs: TURN_TIMEOUT_MS,
      registry,
      requireContextHook: true,
      stopOnContinuation: true,
      usageGraceMs: 500,
    })

    let registration: any
    let service: DiscussionService | undefined

    const emit = (event: ServiceEvent) => {
      void registration?.events.emit("updated", {
        sessionID: event.sessionID,
        runID: event.runID,
        revision: event.revision,
        kind: event.kind,
        payload: event.payload as Record<string, unknown>,
      })
    }

    const runPreflight = async (settings: Settings) => {
      let catalog: CatalogModel[]
      try {
        catalog = ((await ctx.model.list()) as unknown as { data: CatalogModel[] }).data
      } catch (error) {
        // A failed lookup must not block a start; the turn itself will still report a bad model.
        log("preflight-skipped", { error: String((error as Error)?.message ?? error) })
        return null
      }
      const failure = preflight(catalog, settings)
      if (failure) log("preflight-failed", { error: failure.error, side: failure.side })
      return failure ?? { limits: outputLimits(catalog, settings) }
    }

    service = new DiscussionService({
      store,
      location: ctx.location.directory,
      emit,
      verifySession: belongs,
      preflight: runPreflight,
      createRunner: (onEvent) =>
        createRunner({
          python: String(ctx.options.python ?? "python"),
          script: String(ctx.options.runner ?? DEFAULT_RUNNER),
          cwd: ctx.location.directory,
          turnTimeoutMs: TURN_TIMEOUT_MS,
          outDir: join(stateDir(), "transcripts"),
          onEvent,
          generate: async (request, signal, onDelta) => {
            let result
            try {
              result = await turns.run(
                modelRef(request.model),
                request.messages as TurnMessage[],
                request.maxOutputTokens,
                onDelta,
                signal,
              )
            } catch (error) {
              service?.recordRequests((error as { requests?: number })?.requests ?? 0)
              service?.recordUsage((error as { usage?: StepUsage })?.usage)
              throw error
            }
            service?.recordRequests(result.requests ?? 0)
            service?.recordUsage(result.usage)
            // Usage is recorded here on the server and not sent to Python, so it is never counted twice.
            return { text: result.text }
          },
        }),
    })

    await ctx.tool.transform((editor) => {
      editor.namespace({ name: "discuss", description: "Two-model discussion about a topic" })

      editor.add({
        name: "start",
        description: "Start a two-model discussion. Requires the user to confirm the pair, limits and topic.",
        input: {
          type: "object",
          properties: { topic: { type: "string" } },
          required: ["topic"],
          additionalProperties: false,
        },
        execute: async (input, context) => {
          const sessionID = context.sessionID
          const topic = String((input as { topic?: unknown }).topic ?? "").trim()
          const settings = store.session(ctx.location.directory, sessionID).settings
          if (!settings) return { content: "No models selected. Ask the user to run /discuss-models first." }
          if (!topic) return { content: "A topic is required." }

          // Fail before asking the user to approve something that cannot start.
          const problem = await runPreflight(settings)
          if (problem && "error" in problem) return { content: `Could not start: ${problem.reason}` }
          log("consent-requested", { sessionID, agent: context.agent ?? null, rounds: settings.rounds, maxOutputTokens: settings.maxOutputTokens })
          try {
            await ctx.permission.assert({
            sessionID,
            agent: context.agent,
            action: START_ACTION,
            resources: [
              `${settings.a.providerID}/${settings.a.modelID}`,
              `${settings.b.providerID}/${settings.b.modelID}`,
            ],
            metadata: { topic, mode: settings.mode, rounds: settings.rounds, maxOutputTokens: settings.maxOutputTokens },
            source: { type: "tool", messageID: context.messageID, id: context.id },
            })
          } catch (error) {
            log("consent-refused", { sessionID, error: String((error as Error)?.message ?? error), ...errorShape(error) })
            throw explainRefusal(error)
          }
          log("consent-granted", { sessionID })

          const result = await service.start(sessionID, topic, `tool-${context.id}`)
          log("tool-start", { sessionID, ok: result.ok, runID: result.ok ? result.runID : null, error: result.ok ? null : result.error })
          if (!result.ok) return { content: `Could not start: ${result.reason ?? result.error}` }
          return { content: `Discussion started (run ${result.runID}).`, metadata: { runID: result.runID } }
        },
      })

      editor.add({
        name: "status",
        description: "Show the current or latest discussion status without starting new work.",
        input: { type: "object", properties: {}, additionalProperties: false },
        execute: async (_input, context) => {
          const run = service.snapshot(context.sessionID)
          if (!run) return { content: "No discussion has been started in this session." }
          return {
            content: [
              `Status: ${run.status}`,
              `Topic: ${run.topic}`,
              `Replies: ${run.messages.filter(isDialogueReply).length} of ${dialogueReplies(run.settings)}`,
              run.messages.some((message) => message.kind === "conclusion") ? "Conclusion: written" : "",
              run.error ? `Error: ${run.error}` : "",
            ]
              .filter(Boolean)
              .join("\n"),
            metadata: { runID: run.runID, status: run.status },
          }
        },
      })

      editor.add({
        name: "result",
        description: "Return the latest discussion transcript text. Does not start or continue anything.",
        input: { type: "object", properties: {}, additionalProperties: false },
        execute: async (_input, context) => {
          const run = service.snapshot(context.sessionID)
          if (!run) return { content: "No discussion to hand off." }
          return { content: buildHandoff(run), metadata: { runID: run.runID, status: run.status } }
        },
      })

      const control = (name: "stop" | "interject" | "topic") => {
        editor.add({
          name,
          description:
            name === "stop"
              ? "Stop the active discussion."
              : name === "interject"
                ? "Add a human remark both participants will see."
                : "Change the topic of the active discussion.",
          input:
            name === "stop"
              ? { type: "object", properties: {}, additionalProperties: false }
              : { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
          execute: async (input, context) => {
            const run = service.snapshot(context.sessionID)
            if (!run || run.status !== "running") return { content: "No active discussion." }
            const text = String((input as { text?: unknown }).text ?? "").trim()
            const ok =
              name === "stop"
                ? service.stop(context.sessionID, run.runID)
                : name === "interject"
                  ? service.interject(context.sessionID, run.runID, text)
                  : service.changeTopic(context.sessionID, run.runID, text)
            return { content: ok ? `${name} accepted.` : `Could not apply ${name}.` }
          },
        })
      }
      control("stop")
      control("interject")
      control("topic")
    })

    registration = await ctx.rpc.register(DiscussRpc, {
      start: async (input, call) => {
        const { sessionID, topic, requestID } = input as { sessionID: string; topic: string; requestID: string }
        const result = await service.start(sessionID, topic, requestID)
        if (result.ok) return { runID: result.runID, revision: result.revision }
        if (result.error === "busy") return call.error("busy", "a discussion is already running", { runID: result.runID ?? "" })
        if (result.error === "not_found") return call.error("not_found", "session not found", { sessionID })
        if (result.error === "model_unavailable") {
          return call.error("model_unavailable", result.reason ?? "model unavailable", { side: result.side ?? "a", modelID: result.modelID ?? "" })
        }
        return call.error("invalid_settings", result.reason ?? "invalid settings", { reason: result.reason ?? "invalid settings" })
      },
      snapshot: async (input) => {
        const { sessionID, runID } = input as { sessionID: string; runID?: string }
        const run = service.snapshot(sessionID, runID)
        const record = store.session(ctx.location.directory, sessionID)
        return {
          sessionID,
          revision: store.revision,
          settings: record.settings,
          ...(run ? { run } : {}),
          runs: record.runs.map((entry) => ({ runID: entry.runID, topic: entry.topic, status: entry.status, createdAt: entry.createdAt })),
        }
      },
      history: async (input) => {
        const { sessionID } = input as { sessionID: string }
        return { sessionID, runs: store.session(ctx.location.directory, sessionID).runs }
      },
      stop: async (input, call) => {
        const { sessionID, runID } = input as { sessionID: string; runID: string }
        const stopped = service.stop(sessionID, runID)
        if (!stopped) return call.error("stale_run", "run is not active", { runID })
        return { stopped, revision: store.revision }
      },
      interject: async (input, call) => {
        const { sessionID, runID, text } = input as { sessionID: string; runID: string; text: string }
        const accepted = service.interject(sessionID, runID, text)
        if (!accepted) return call.error("stale_run", "run is not active", { runID })
        return { accepted, revision: store.revision }
      },
      topic: async (input, call) => {
        const { sessionID, runID, text } = input as { sessionID: string; runID: string; text: string }
        const accepted = service.changeTopic(sessionID, runID, text)
        if (!accepted) return call.error("stale_run", "run is not active", { runID })
        return { accepted, revision: store.revision }
      },
      models: async () => {
        const listed = await ctx.model.list()
        return {
          models: (listed as unknown as { data: Array<{ providerID: string; id: string; name: string; enabled?: boolean; type?: string; variants?: Array<{ id: string }> }> }).data.map((entry) => ({
            providerID: entry.providerID,
            modelID: entry.id,
            name: entry.name,
            variants: (entry.variants ?? []).map((variant) => variant.id),
            available: entry.enabled !== false && (entry.type === undefined || entry.type === "chat"),
          })),
        }
      },
      settingsGet: async (input) => {
        const { sessionID } = input as { sessionID: string }
        return { sessionID, settings: store.session(ctx.location.directory, sessionID).settings, last: store.lastSettings() }
      },
      settingsSet: async (input, call) => {
        const { sessionID, settings } = input as { sessionID: string; settings: Settings }
        if (!(await belongs(sessionID))) {
          return call.error("not_found", "session does not belong to this location", { sessionID })
        }
        const result = service.setSettings(sessionID, settings)
        if (!result.ok) return call.error("invalid_settings", result.reason, { reason: result.reason })
        return { sessionID, revision: result.revision }
      },
      handoff: async (input, call) => {
        const { sessionID, runID, target, confirm } = input as {
          sessionID: string
          runID: string
          target: "plan" | "build"
          confirm: boolean
        }
        const run = store.run(ctx.location.directory, sessionID, runID)
        if (!run) return call.error("not_found", "run not found", { runID })
        if (run.status === "running") {
          return call.error("not_confirmed", "stop or finish the discussion before handing it off", {
            packet: buildHandoff(run),
          })
        }
        const text = buildHandoff(run)
        const directory = join(stateDir(), "handoffs")
        const path = join(directory, `discuss-${runID}.md`)
        try {
          mkdirSync(directory, { recursive: true })
          writeFileSync(path, text + "\n", "utf8")
        } catch {
          /* reported through not_confirmed below only when confirmation is blocked */
        }
        if (!confirm) return call.error("not_confirmed", "handoff requires explicit confirmation", { packet: text })
        // The claim is stored with the run, so a second Send, another TUI or a
        // restarted server never submits the same result twice.
        if (!store.claimHandoff(ctx.location.directory, sessionID, runID, target)) {
          log("handoff-repeat", { sessionID, runID, target, previous: run.handoff?.target ?? null })
          return { packet: text, path, submitted: false }
        }
        try {
          await ctx.session.switchAgent({ sessionID, agent: target })
          await ctx.session.prompt({ sessionID, text })
        } catch (error) {
          store.releaseHandoff(ctx.location.directory, sessionID, runID)
          log("handoff-failed", { sessionID, runID, target, error: String((error as Error)?.message ?? error) })
          throw error
        }
        log("handoff-sent", { sessionID, runID, target, length: text.length })
        return { packet: text, path, submitted: true }
      },
    })

    log("server-ready", {
      recoveredRuns: store.recoveredRuns,
      corrupt: store.corrupt,
    })

    return async () => {
      service?.dispose()
      await store.flush()
      await contextHook.dispose()
      await consentHook.dispose()
      await registration?.dispose()
    }
  },
})

