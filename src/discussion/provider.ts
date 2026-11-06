import type { ModelRef, Usage } from "./types"

export type TurnMessage = {
  role: "system" | "user" | "assistant"
  content: string
}

export type HostEvent =
  | { type: "delta"; sessionID: string; delta: string }
  | { type: "succeeded"; sessionID: string }
  | { type: "failed"; sessionID: string; message?: string }

export type SessionHost = {
  create(input: { title: string; agent: string; model: ModelRef; directory: string }): Promise<{ sessionID: string }>
  prompt(sessionID: string, text: string): Promise<void>
  interrupt(sessionID: string): Promise<void>
  remove(sessionID: string): Promise<void>
  subscribe(listener: (event: HostEvent) => void): () => void
}

export type TurnResult = {
  text: string
  usage?: Usage
  /** Model requests the host made for this turn (context hook invocations). */
  requests?: number
  /** The reply hit the output limit and was cut there. */
  truncated?: boolean
}

export type TurnErrorKind = "provider" | "timeout" | "cancelled" | "empty" | "output_limit"

export class TurnError extends Error {
  readonly kind: TurnErrorKind
  /** Model requests the host made before the turn failed. */
  requests?: number

  constructor(kind: TurnErrorKind, message: string) {
    super(message)
    this.name = "TurnError"
    this.kind = kind
  }
}

/** Appended to a reply that was cut at the output limit. */
export const TRUNCATED_MARK = "\n\n[truncated at the output limit]"

export type TurnRequest = {
  sessionID: string
  messages: TurnMessage[]
  maxOutputTokens: number
}

/**
 * The provider calls `ctx.session.prompt` on a hidden session and replaces the
 * assembled messages through the `context` hook before dispatch. Anything the
 * hook does not claim is left alone.
 */
export class TurnRegistry {
  #pending = new Map<string, TurnRequest>()
  #applied = new Set<string>()
  #steps = new Map<string, number>()
  #truncated = new Set<string>()

  claim(sessionID: string, request: TurnRequest): void {
    this.#pending.set(sessionID, request)
    this.#applied.delete(sessionID)
    this.#steps.set(sessionID, 0)
    this.#truncated.delete(sessionID)
  }

  /**
   * Counts one model request for a claimed turn and returns the running count.
   * The first is the turn itself; any later one is a host continuation, which
   * OpenCode 2.2.5 starts on its own after a reply stops at the output limit.
   */
  step(sessionID: string): number {
    if (!this.#pending.has(sessionID)) return 0
    const next = (this.#steps.get(sessionID) ?? 0) + 1
    this.#steps.set(sessionID, next)
    return next
  }

  steps(sessionID: string): number {
    return this.#steps.get(sessionID) ?? 0
  }

  /** The host tried to continue a turn after it hit the output limit. */
  markTruncated(sessionID: string): void {
    if (this.#pending.has(sessionID)) this.#truncated.add(sessionID)
  }

  truncated(sessionID: string): boolean {
    return this.#truncated.has(sessionID)
  }

  get(sessionID: string): TurnRequest | undefined {
    return this.#pending.get(sessionID)
  }

  /** Called by the `context` hook once it has replaced the turn's messages. */
  markApplied(sessionID: string): void {
    if (this.#pending.has(sessionID)) this.#applied.add(sessionID)
  }

  applied(sessionID: string): boolean {
    return this.#applied.has(sessionID)
  }

  release(sessionID: string): void {
    this.#pending.delete(sessionID)
    this.#applied.delete(sessionID)
    this.#steps.delete(sessionID)
    this.#truncated.delete(sessionID)
  }
}

export type TurnRunnerOptions = {
  agent: string
  directory: string
  timeoutMs: number
  registry?: TurnRegistry
  /** Interval between liveness checks; kept small so an aborted turn settles quickly. */
  tickMs?: number
  /**
   * Refuse a reply unless the `context` hook replaced the messages for this
   * turn. Without the hook the model only sees the placeholder prompt, so its
   * reply is unrelated to the discussion and must not count as a turn.
   */
  requireContextHook?: boolean
  /**
   * End the turn as soon as the host starts an output-limit continuation,
   * keeping the text so far. Without this OpenCode re-runs the same dialogue up
   * to twice more (the hook restores it each time) and then fails, so one turn
   * silently costs three requests.
   */
  stopOnContinuation?: boolean
}

export type TurnRunner = {
  run(
    model: ModelRef,
    messages: TurnMessage[],
    maxOutputTokens: number,
    onDelta: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<TurnResult>
}

export function createTurnRunner(host: SessionHost, options: TurnRunnerOptions): TurnRunner {
  const registry = options.registry ?? new TurnRegistry()
  const tick = options.tickMs ?? 25

  return {
    async run(model, messages, maxOutputTokens, onDelta, signal) {
      if (signal?.aborted) throw new TurnError("cancelled", "cancelled before the turn started")

      const { sessionID } = await host.create({
        title: `discuss: ${model.providerID}/${model.modelID}`,
        agent: options.agent,
        model,
        directory: options.directory,
      })

      registry.claim(sessionID, { sessionID, messages, maxOutputTokens })
      let text = ""
      let settled: HostEvent | null = null
      let failure: string | undefined
      let unsubscribe: () => void = () => {}

      const promise = new Promise<TurnResult>((resolveTurn, rejectTurn) => {
        const resolve = (result: TurnResult) => resolveTurn({ ...result, requests: registry.steps(sessionID) })
        const reject = (error: TurnError) => {
          error.requests = registry.steps(sessionID)
          rejectTurn(error)
        }
        unsubscribe = host.subscribe((event) => {
          if (settled || event.sessionID !== sessionID) return
          if (event.type === "delta") {
            text += event.delta
            onDelta(event.delta)
            return
          }
          if (event.type === "failed") failure = event.message
          settled = event
        })

        void host.prompt(sessionID, "Continue the discussion.").catch((error: unknown) => {
          if (settled) return
          failure = String((error as Error)?.message ?? error)
          settled = { type: "failed", sessionID, message: failure }
        })

        const started = Date.now()
        let cut = false
        const poll = () => {
          if (options.stopOnContinuation && !cut && registry.truncated(sessionID)) {
            cut = true
            settled = settled ?? { type: "failed", sessionID, message: "output limit" }
            void host.interrupt(sessionID).catch(() => {})
            if (text.trim()) resolve({ text: text.trimEnd() + TRUNCATED_MARK, truncated: true })
            else {
              reject(
                new TurnError(
                  "output_limit",
                  `output limit of ${maxOutputTokens} tokens reached before any visible text (reasoning probably used it); raise it, e.g. /discuss-settings tokens=${Math.max(1000, maxOutputTokens * 4)}`,
                ),
              )
            }
            return
          }
          if (settled) {
            const event = settled as HostEvent
            if (event.type === "succeeded") {
              if (options.requireContextHook && !registry.applied(sessionID)) {
                reject(
                  new TurnError(
                    "provider",
                    "context hook did not apply: the participant did not receive the discussion (is the turn session in this plugin's location?)",
                  ),
                )
              } else if (!text.trim()) reject(new TurnError("empty", "empty reply"))
              else resolve({ text })
              return
            }
            if (signal?.aborted) reject(new TurnError("cancelled", "stopped by user"))
            else reject(new TurnError("provider", failure ?? "generation failed"))
            return
          }
          if (signal?.aborted) {
            settled = { type: "failed", sessionID, message: "stopped by user" }
            void host.interrupt(sessionID).catch(() => {})
            // give the host a short moment to settle, then report cancellation
            setTimeout(() => {
              if (settled) reject(new TurnError("cancelled", "stopped by user"))
            }, Math.min(200, tick * 4))
            return
          }
          if (Date.now() - started > options.timeoutMs) {
            settled = { type: "failed", sessionID, message: `no reply within ${options.timeoutMs}ms` }
            void host.interrupt(sessionID).catch(() => {})
            reject(new TurnError("timeout", `no reply within ${options.timeoutMs}ms`))
            return
          }
          setTimeout(poll, tick)
        }
        setTimeout(poll, 0)
      })

      try {
        return await promise
      } finally {
        unsubscribe()
        registry.release(sessionID)
        await host.remove(sessionID).catch(() => {})
      }
    },
  }
}
