import { describe, expect, test } from "bun:test"
import { addUsage, describeUsage, stepUsage } from "../../src/discussion/usage"
import { buildHandoff } from "../../src/discussion/handoff"
import { createTurnRunner, type HostEvent, type SessionHost } from "../../src/discussion/provider"
import { DiscussionStore } from "../../src/discussion/store"
import type { Run, Storage } from "../../src/discussion/types"

describe("usage helpers", () => {
  test("stepUsage reads tokens and cost from a step event", () => {
    expect(stepUsage({ sessionID: "s", cost: 0.002, tokens: { input: 120, output: 40, reasoning: 10, cache: { read: 0, write: 0 } } })).toEqual({
      input: 120,
      output: 40,
      reasoning: 10,
      cost: 0.002,
    })
  })

  test("stepUsage returns undefined when the event carries nothing", () => {
    expect(stepUsage({ sessionID: "s" })).toBeUndefined()
    expect(stepUsage(null)).toBeUndefined()
    expect(stepUsage({ cost: Number.NaN, tokens: { input: "x" } })).toBeUndefined()
  })

  test("addUsage sums fields and keeps requests untouched", () => {
    const total = addUsage({ input: 10, output: 5, requests: 2 }, { input: 3, output: 1, cost: 0.5 })
    expect(total).toEqual({ input: 13, output: 6, cost: 0.5, requests: 2 })
  })

  test("describeUsage: unknown, tokens without a price, priced", () => {
    expect(describeUsage(undefined)).toBe("unknown")
    expect(describeUsage({ requests: 2 })).toBe("unknown")
    expect(describeUsage({ input: 1200, output: 300, cost: 0 })).toBe("in 1,200 · out 300 · cost unknown")
    expect(describeUsage({ input: 1200, output: 300, reasoning: 100, cost: 0.01234 })).toBe("in 1,200 · out 300 · reasoning 100 · $0.0123")
  })
})

describe("usage in the handoff", () => {
  const run: Run = {
    runID: "r",
    topic: "T",
    settings: { a: { providerID: "p", modelID: "a" }, b: { providerID: "p", modelID: "b" }, mode: "cooperative", rounds: 1, maxOutputTokens: 100 },
    status: "completed",
    createdAt: 1,
    messages: [],
    partial: null,
  }

  test("absent usage is reported as unknown, and the orchestrator is a separate note", () => {
    const packet = buildHandoff(run)
    expect(packet).toContain("Participant usage: unknown")
    expect(packet).toContain("not counted here")
  })

  test("recorded usage and requests are shown", () => {
    const packet = buildHandoff({ ...run, usage: { input: 50, output: 20, cost: 0.001, requests: 2 } })
    expect(packet).toContain("Participant usage: in 50 · out 20 · $0.0010")
    expect(packet).toContain("Model requests: 2")
  })
})

describe("usage in the store", () => {
  test("addUsage sums per turn and survives a reload", async () => {
    const data = new Map<string, unknown>()
    const storage: Storage = {
      async get(key: string) {
        return data.get(key)
      },
      async set(key: string, value: unknown) {
        data.set(key, structuredClone(value))
      },
      async remove(key: string) {
        data.delete(key)
      },
    } as unknown as Storage
    const store = await DiscussionStore.open(storage)
    store.setSettings("loc", "ses", { a: { providerID: "p", modelID: "a" }, b: { providerID: "p", modelID: "b" }, mode: "cooperative", rounds: 1, maxOutputTokens: 100 })
    const run = store.startRun("loc", "ses", "topic")
    store.addUsage("loc", "ses", run.runID, { input: 10, output: 4, reasoning: 1, cost: 0.1 })
    store.addUsage("loc", "ses", run.runID, { input: 7, output: 3 })
    expect(store.run("loc", "ses", run.runID)?.usage).toEqual({ input: 17, output: 7, reasoning: 1, cost: 0.1 })
    await store.flush()
  })
})

function host() {
  let listener: ((event: HostEvent) => void) | null = null
  let prompted = false
  const fake: SessionHost = {
    async create() {
      return { sessionID: "ses_1" }
    },
    async prompt() {
      prompted = true
    },
    async interrupt() {},
    async remove() {},
    subscribe(next) {
      listener = next
      return () => {
        listener = null
      }
    },
  }
  return {
    fake,
    emit: (event: HostEvent) => listener?.(event),
    prompted: async () => {
      for (let index = 0; index < 200 && !prompted; index++) await new Promise((resolve) => setTimeout(resolve, 0))
    },
  }
}

async function settle<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: any }> {
  try {
    return { ok: true, value: await promise }
  } catch (error) {
    return { ok: false, error }
  }
}

describe("usage in a turn", () => {
  test("step usage is summed into the turn result", async () => {
    const h = host()
    const runner = createTurnRunner(h.fake, { agent: "p", directory: "C:/w", timeoutMs: 1000, tickMs: 5 })
    const pending = runner.run({ providerID: "p", modelID: "a" }, [], 100, () => {})
    await h.prompted()
    h.emit({ type: "delta", sessionID: "ses_1", delta: "hi" })
    h.emit({ type: "usage", sessionID: "ses_1", usage: { input: 10, output: 2, cost: 0.01 } })
    h.emit({ type: "usage", sessionID: "ses_1", usage: { input: 1, output: 1 } })
    h.emit({ type: "succeeded", sessionID: "ses_1" })
    const result = await pending
    expect(result.usage).toEqual({ input: 11, output: 3, cost: 0.01 })
  })

  test("usage that arrives just after success is picked up within the grace period", async () => {
    const h = host()
    const runner = createTurnRunner(h.fake, { agent: "p", directory: "C:/w", timeoutMs: 1000, tickMs: 5, usageGraceMs: 200 })
    const pending = runner.run({ providerID: "p", modelID: "a" }, [], 100, () => {})
    await h.prompted()
    h.emit({ type: "delta", sessionID: "ses_1", delta: "hi" })
    h.emit({ type: "succeeded", sessionID: "ses_1" })
    await new Promise((resolve) => setTimeout(resolve, 30))
    h.emit({ type: "usage", sessionID: "ses_1", usage: { input: 5, output: 1 } })
    const result = await pending
    expect(result.usage).toEqual({ input: 5, output: 1 })
  })

  test("without usage the turn still resolves after the grace period", async () => {
    const h = host()
    const runner = createTurnRunner(h.fake, { agent: "p", directory: "C:/w", timeoutMs: 1000, tickMs: 5, usageGraceMs: 40 })
    const pending = runner.run({ providerID: "p", modelID: "a" }, [], 100, () => {})
    await h.prompted()
    h.emit({ type: "delta", sessionID: "ses_1", delta: "hi" })
    h.emit({ type: "succeeded", sessionID: "ses_1" })
    const result = await pending
    expect(result.text).toBe("hi")
    expect(result.usage).toBeUndefined()
  })

  test("a failed turn carries the usage that was already spent", async () => {
    const h = host()
    const runner = createTurnRunner(h.fake, { agent: "p", directory: "C:/w", timeoutMs: 1000, tickMs: 5 })
    const pending = settle(runner.run({ providerID: "p", modelID: "a" }, [], 100, () => {}))
    await h.prompted()
    h.emit({ type: "usage", sessionID: "ses_1", usage: { input: 9, output: 0, cost: 0.002 } })
    h.emit({ type: "failed", sessionID: "ses_1", message: "boom" })
    const settled = await pending
    expect(settled.ok).toBe(false)
    if (!settled.ok) expect(settled.error.usage).toEqual({ input: 9, output: 0, cost: 0.002 })
  })

  test("usage of another session is ignored", async () => {
    const h = host()
    const runner = createTurnRunner(h.fake, { agent: "p", directory: "C:/w", timeoutMs: 1000, tickMs: 5 })
    const pending = runner.run({ providerID: "p", modelID: "a" }, [], 100, () => {})
    await h.prompted()
    h.emit({ type: "usage", sessionID: "other", usage: { input: 99 } })
    h.emit({ type: "delta", sessionID: "ses_1", delta: "hi" })
    h.emit({ type: "succeeded", sessionID: "ses_1" })
    expect((await pending).usage).toBeUndefined()
  })
})
