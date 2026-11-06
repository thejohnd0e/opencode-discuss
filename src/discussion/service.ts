import type { Runner, RunnerEvent, RunnerFinished, RunnerStart } from "./runner"
import { DiscussionStore } from "./store"
import type { PreflightFailure } from "./preflight"
import type { StepUsage } from "./usage"
import { modelLabel, type Run, type Settings, type Speaker, type Usage } from "./types"

export type ServiceEvent = {
  sessionID: string
  runID: string
  revision: number
  kind: "started" | "delta" | "message" | "control" | "transcript" | "terminal" | "error" | "settings"
  payload: Record<string, unknown>
}

export type StartResult =
  | { ok: true; runID: string; revision: number }
  | { ok: false; error: "busy" | "invalid_settings" | "not_found" | "model_unavailable"; reason?: string; runID?: string; side?: "a" | "b"; modelID?: string }

export type ServiceDeps = {
  store: DiscussionStore
  location: string
  emit: (event: ServiceEvent) => void
  verifySession: (sessionID: string) => Promise<boolean>
  /** Optional check of the saved pair before a start; a failure aborts it. */
  preflight?: (settings: Settings) => Promise<PreflightFailure | null>
  createRunner: (onEvent: (event: RunnerEvent) => void) => Runner
}

type Active = {
  sessionID: string
  runID: string
  runner: Runner
  labels: { a: string; b: string }
  partial: { timer: ReturnType<typeof setTimeout> | null; pending: { speaker: Speaker; label: string; round: number; text: string } | null }
}

const PARTIAL_INTERVAL_MS = 150
/** Start request IDs remembered for idempotent retries. */
export const MAX_REMEMBERED_REQUESTS = 64

export class DiscussionService {
  #deps: ServiceDeps
  #active: Active | null = null
  #starting = false
  #requests = new Map<string, string>()

  constructor(deps: ServiceDeps) {
    this.#deps = deps
  }

  active(location: string): { sessionID: string; runID: string } | null {
    if (location !== this.#deps.location || !this.#active) return null
    return { sessionID: this.#active.sessionID, runID: this.#active.runID }
  }

  async start(sessionID: string, topic: string, requestID: string): Promise<StartResult> {
    const known = this.#requests.get(requestID)
    if (known) {
      const existing = this.#deps.store.run(this.#deps.location, sessionID, known)
      if (existing) return { ok: true, runID: known, revision: this.#deps.store.revision }
    }

    if (this.#active || this.#starting) {
      return {
        ok: false,
        error: "busy",
        ...(this.#active ? { runID: this.#active.runID } : {}),
        reason: "another discussion is running in this location",
      }
    }

    const settings = this.#deps.store.session(this.#deps.location, sessionID).settings
    if (!settings) return { ok: false, error: "invalid_settings", reason: "select two models first" }
    if (!topic.trim()) return { ok: false, error: "invalid_settings", reason: "a topic is required" }

    this.#starting = true
    try {
      if (!(await this.#deps.verifySession(sessionID))) {
        return { ok: false, error: "not_found", reason: "session does not belong to this location" }
      }
      const problem = await this.#deps.preflight?.(settings)
      if (problem) return { ok: false, error: problem.error, reason: problem.reason, ...(problem.side ? { side: problem.side } : {}), ...(problem.modelID ? { modelID: problem.modelID } : {}) }
      const current = this.#deps.store.session(this.#deps.location, sessionID).settings
      if (!current || JSON.stringify(current) !== JSON.stringify(settings)) {
        return { ok: false, error: "invalid_settings", reason: "settings changed while the launch was being confirmed" }
      }
      this.#starting = false

      let started: Run
      try {
        started = this.#deps.store.startRun(this.#deps.location, sessionID, topic)
      } catch (error) {
        return { ok: false, error: "invalid_settings", reason: String((error as Error)?.message ?? error) }
      }

      const labels = labelsFor(settings)
      const runner = this.#deps.createRunner((event) => this.#onEvent(sessionID, started.runID, labels, event))
      const active: Active = {
        sessionID,
        runID: started.runID,
        runner,
        labels,
        partial: { timer: null, pending: null },
      }
      this.#active = active
      this.#requests.set(requestID, started.runID)
      // Only recent request IDs matter for a retried start; keep the map bounded.
      while (this.#requests.size > MAX_REMEMBERED_REQUESTS) {
        const oldest = this.#requests.keys().next().value
        if (oldest === undefined) break
        this.#requests.delete(oldest)
      }

      const options: RunnerStart = {
        rounds: settings.rounds,
        maxOutputTokens: settings.maxOutputTokens,
        mode: settings.mode,
        labels,
        models: { a: spec(settings.a), b: spec(settings.b) },
      }
      this.#emit(sessionID, started.runID, "started", { topic: started.topic, settings })
      runner.start(started.topic, options)

      void runner.finished
        .then((finished) => this.#terminal(active, finished))
        .catch((error: unknown) =>
          this.#terminal(active, {
            status: "failed",
            messages: 0,
            stopped: false,
            exitCode: null,
            error: String((error as Error)?.message ?? error),
          }),
        )

      return { ok: true, runID: started.runID, revision: this.#deps.store.revision }
    } finally {
      this.#starting = false
    }
  }

  stop(sessionID: string, runID: string): boolean {
    const active = this.#match(sessionID, runID)
    if (!active) return false
    active.runner.stop()
    return true
  }

  interject(sessionID: string, runID: string, text: string): boolean {
    const active = this.#match(sessionID, runID)
    if (!active || !text.trim()) return false
    active.runner.interject(text.trim())
    return true
  }

  changeTopic(sessionID: string, runID: string, text: string): boolean {
    const active = this.#match(sessionID, runID)
    if (!active || !text.trim()) return false
    active.runner.changeTopic(text.trim())
    return true
  }

  snapshot(sessionID: string, runID?: string): Run | undefined {
    if (runID) return this.#deps.store.run(this.#deps.location, sessionID, runID)
    const record = this.#deps.store.session(this.#deps.location, sessionID)
    return record.runs.at(-1)
  }

  history(sessionID: string): Run[] {
    return this.#deps.store.session(this.#deps.location, sessionID).runs
  }

  settings(sessionID: string): Settings | null {
    return this.#deps.store.session(this.#deps.location, sessionID).settings
  }

  setSettings(sessionID: string, settings: Settings): { ok: true; revision: number } | { ok: false; reason: string } {
    try {
      const revision = this.#deps.store.setSettings(this.#deps.location, sessionID, settings)
      this.#emit(sessionID, "", "settings", { settings })
      return { ok: true, revision }
    } catch (error) {
      return { ok: false, reason: String((error as Error)?.message ?? error) }
    }
  }

  /** Counts model requests made for the active run (called by the provider bridge). */
  /** Adds one turn's host-reported tokens and cost (bridge mode) to the active run. */
  recordUsage(usage: StepUsage | undefined): void {
    const active = this.#active
    if (!active || !usage) return
    try {
      this.#deps.store.addUsage(this.#deps.location, active.sessionID, active.runID, usage)
      const run = this.#deps.store.run(this.#deps.location, active.sessionID, active.runID)
      this.#emit(active.sessionID, active.runID, "control", { usage: run?.usage ?? {} })
    } catch {
      /* the run ended meanwhile */
    }
  }

  recordRequests(count: number): void {
    const active = this.#active
    if (!active || !count) return
    try {
      this.#deps.store.addRequests(this.#deps.location, active.sessionID, active.runID, count)
      const run = this.#deps.store.run(this.#deps.location, active.sessionID, active.runID)
      this.#emit(active.sessionID, active.runID, "control", { usage: run?.usage ?? {} })
    } catch {
      /* the run ended meanwhile */
    }
  }

  dispose(): void {
    if (!this.#active) return
    const active = this.#active
    const run = this.#deps.store.run(this.#deps.location, active.sessionID, active.runID)
    if (run && run.status === "running") {
      this.#deps.store.finishRun(this.#deps.location, active.sessionID, active.runID, "cancelled")
      this.#emit(active.sessionID, active.runID, "terminal", { status: "cancelled", reason: "server unloaded" })
    }
    active.runner.dispose()
    this.#active = null
  }

  #match(sessionID: string, runID: string): Active | null {
    const active = this.#active
    if (!active || active.sessionID !== sessionID || active.runID !== runID) return null
    const run = this.#deps.store.run(this.#deps.location, sessionID, runID)
    if (!run || run.status !== "running") return null
    return active
  }

  #onEvent(sessionID: string, runID: string, labels: { a: string; b: string }, event: RunnerEvent): void {
    const active = this.#active
    if (!active || active.sessionID !== sessionID || active.runID !== runID) return
    const run = this.#deps.store.run(this.#deps.location, sessionID, runID)
    if (!run || run.status !== "running") return
    const round = "round" in event && typeof event.round === "number" ? event.round : 1

    switch (event.type) {
      case "delta": {
        const speaker = this.#speaker(event.speaker, labels)
        active.partial.pending = { speaker, label: this.#labelFor(speaker, labels), round, text: event.text }
        this.#schedulePartial(active, sessionID, runID)
        this.#emit(sessionID, runID, "delta", { speaker, round, text: event.text })
        return
      }
      case "message": {
        this.#flushPartial(active, sessionID, runID)
        const speaker = this.#speaker(event.speaker, labels)
        this.#deps.store.appendMessage(this.#deps.location, sessionID, runID, {
          speaker,
          round: event.round,
          text: event.text,
          ...(event.seconds === undefined ? {} : { seconds: event.seconds }),
        })
        this.#emit(sessionID, runID, "message", { speaker, round: event.round, text: event.text })
        return
      }
      case "control": {
        if (event.command === "interject" || event.command === "topic") {
          const speaker: Speaker = event.command === "topic" ? "topic" : "human"
          this.#deps.store.appendMessage(this.#deps.location, sessionID, runID, {
            speaker,
            round,
            text: event.text ?? "",
          })
        }
        this.#emit(sessionID, runID, "control", { command: event.command, ...(event.text ? { text: event.text } : {}) })
        return
      }
      case "transcript": {
        this.#deps.store.setTranscript(this.#deps.location, sessionID, runID, event.path)
        this.#emit(sessionID, runID, "transcript", { path: event.path })
        return
      }
      case "error": {
        this.#deps.store.setError(this.#deps.location, sessionID, runID, event.message, "provider")
        this.#emit(sessionID, runID, "error", { message: event.message })
        return
      }
      case "usage": {
        const usage: Usage = {}
        if (event.input !== undefined) usage.input = event.input
        if (event.output !== undefined) usage.output = event.output
        if (event.cost !== undefined) usage.cost = event.cost
        this.#deps.store.setUsage(this.#deps.location, sessionID, runID, usage)
        return
      }
      default:
        return
    }
  }

  #schedulePartial(active: Active, sessionID: string, runID: string): void {
    if (active.partial.timer) return
    active.partial.timer = setTimeout(() => {
      active.partial.timer = null
      this.#flushPartial(active, sessionID, runID)
    }, PARTIAL_INTERVAL_MS)
  }

  #flushPartial(active: Active, sessionID: string, runID: string): void {
    if (active.partial.timer) {
      clearTimeout(active.partial.timer)
      active.partial.timer = null
    }
    const pending = active.partial.pending
    active.partial.pending = null
    if (!pending) return
    const run = this.#deps.store.run(this.#deps.location, sessionID, runID)
    if (!run || run.status !== "running") return
    this.#deps.store.setPartial(this.#deps.location, sessionID, runID, pending)
  }

  #terminal(active: Active, finished: RunnerFinished): void {
    this.#flushPartial(active, active.sessionID, active.runID)
    const run = this.#deps.store.run(this.#deps.location, active.sessionID, active.runID)
    if (!run || run.status !== "running") {
      if (this.#active === active) this.#active = null
      return
    }

    let status = finished.status
    let error: string | undefined
    if (status === "completed") {
      const expected = run.settings.rounds * 2
      const replies = run.messages.filter((message) => message.speaker === "a" || message.speaker === "b").length
      if (replies === 0) {
        status = "failed"
        error = "no replies were produced"
      } else if (replies < expected) {
        status = "failed"
        error = run.error ?? `incomplete discussion: ${replies} of ${expected} replies`
      }
    }

    if (status === "failed") this.#deps.store.failRun(this.#deps.location, active.sessionID, active.runID, error ?? finished.error ?? "discussion failed", "provider")
    else this.#deps.store.finishRun(this.#deps.location, active.sessionID, active.runID, status)

    this.#emit(active.sessionID, active.runID, "terminal", { status, ...(error ? { error } : {}) })
    if (this.#active === active) this.#active = null
  }

  #emit(sessionID: string, runID: string, kind: ServiceEvent["kind"], payload: Record<string, unknown>): void {
    this.#deps.emit({
      sessionID,
      runID,
      revision: this.#deps.store.revision,
      kind,
      payload,
    })
  }

  #speaker(name: string, labels: { a: string; b: string }): Speaker {
    if (name === labels.a) return "a"
    if (name === labels.b) return "b"
    if (name === "Тема" || name === "topic") return "topic"
    return "human"
  }

  #labelFor(speaker: Speaker, labels: { a: string; b: string }): string {
    return speaker === "a" ? labels.a : speaker === "b" ? labels.b : speaker
  }
}

function spec(model: Settings["a"]): string {
  return `${model.providerID}:${model.modelID}${model.variant ? `#${model.variant}` : ""}`
}

function labelsFor(settings: Settings): { a: string; b: string } {
  const a = modelLabel(settings.a)
  const b = modelLabel(settings.b)
  return a === b ? { a: `${a} (A)`, b: `${b} (B)` } : { a, b }
}
