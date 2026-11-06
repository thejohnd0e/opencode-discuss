import { describe, expect, test } from "bun:test"
import { LineDecoder } from "../../src/discussion/line"
import { createTurnRunner, TurnRegistry, type SessionHost, type HostEvent } from "../../src/discussion/provider"
import type { ModelRef } from "../../src/discussion/types"

const model: ModelRef = { providerID: "provider", modelID: "left" }
const messages = [
  { role: "system" as const, content: "you are left" },
  { role: "user" as const, content: "topic" },
]

/** Bun 1.4.2 hangs on expect(promise).resolves/rejects, so settle explicitly. */
async function settle<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: any }> {
  try {
    return { ok: true, value: await promise }
  } catch (error) {
    return { ok: false, error }
  }
}

function fakeHost() {
  const created: string[] = []
  const removed: string[] = []
  const interrupted: string[] = []
  const prompts: Array<{ sessionID: string; text: string }> = []
  let listener: ((event: HostEvent) => void) | null = null
  let counter = 0

  const host: SessionHost = {
    async create() {
      counter += 1
      const sessionID = `ses_${counter}`
      created.push(sessionID)
      return { sessionID }
    },
    async prompt(sessionID, text) {
      prompts.push({ sessionID, text })
    },
    async interrupt(sessionID) {
      interrupted.push(sessionID)
    },
    async remove(sessionID) {
      removed.push(sessionID)
    },
    subscribe(next) {
      listener = next
      return () => {
        listener = null
      }
    },
  }

  return {
    host,
    created,
    removed,
    interrupted,
    prompts,
    emit: (event: HostEvent) => listener?.(event),
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

async function ready(fake: ReturnType<typeof fakeHost>) {
  for (let index = 0; index < 200 && fake.prompts.length === 0; index++) await tick()
  if (fake.prompts.length === 0) throw new Error("turn never prompted")
  return fake.created[0]
}

describe("turn runner", () => {
  test("streams deltas and resolves with the final text", async () => {
    const fake = fakeHost()
    const runner = createTurnRunner(fake.host, { agent: "discuss-participant", directory: "C:/temp", timeoutMs: 1000 })
    const pieces: string[] = []
    const pending = runner.run(model, messages, 100, (piece) => pieces.push(piece))
    const sessionID = await ready(fake)

    fake.emit({ type: "delta", sessionID, delta: "left " })
    fake.emit({ type: "delta", sessionID, delta: "answer" })
    fake.emit({ type: "succeeded", sessionID })

    const settled = await settle(pending)
    expect(settled.ok).toBe(true)
    if (settled.ok) expect(settled.value.text).toBe("left answer")
    expect(pieces).toEqual(["left ", "answer"])
    expect(fake.removed).toEqual([sessionID])
  })

  test("a failed session rejects and still cleans up", async () => {
    const fake = fakeHost()
    const runner = createTurnRunner(fake.host, { agent: "discuss-participant", directory: "C:/temp", timeoutMs: 1000 })
    const pending = runner.run(model, messages, 100, () => {})
    const sessionID = await ready(fake)
    fake.emit({ type: "failed", sessionID, message: "provider exploded" })

    const settled = await settle(pending)
    expect(settled.ok).toBe(false)
    if (!settled.ok) expect(String(settled.error?.message)).toContain("provider exploded")
    expect(fake.removed).toEqual([sessionID])
  })

  test("aborting interrupts the session and rejects as cancelled", async () => {
    const fake = fakeHost()
    const runner = createTurnRunner(fake.host, { agent: "discuss-participant", directory: "C:/temp", timeoutMs: 1000 })
    const controller = new AbortController()
    const pending = runner.run(model, messages, 100, () => {}, controller.signal)
    const sessionID = await ready(fake)
    fake.emit({ type: "delta", sessionID, delta: "partial" })
    controller.abort()

    const settled = await settle(pending)
    expect(settled.ok).toBe(false)
    if (!settled.ok) expect(settled.error?.kind).toBe("cancelled")
    expect(fake.interrupted).toEqual([sessionID])
    expect(fake.removed).toEqual([sessionID])
  })

  test("with requireContextHook, a reply the hook did not prepare is rejected, not counted", async () => {
    const fake = fakeHost()
    const registry = new TurnRegistry()
    const runner = createTurnRunner(fake.host, {
      agent: "discuss-participant",
      directory: "C:/temp",
      timeoutMs: 1000,
      registry,
      requireContextHook: true,
    })
    const pending = runner.run(model, messages, 100, () => {})
    const sessionID = await ready(fake)
    // The model answered, but the hook never replaced the messages (wrong location).
    fake.emit({ type: "delta", sessionID, delta: "I don't see any discussion." })
    fake.emit({ type: "succeeded", sessionID })

    const settled = await settle(pending)
    expect(settled.ok).toBe(false)
    if (!settled.ok) {
      expect(settled.error?.kind).toBe("provider")
      expect(String(settled.error?.message)).toContain("context hook did not apply")
    }
    expect(fake.removed).toEqual([sessionID])
    expect(registry.applied(sessionID)).toBe(false)
  })

  test("with requireContextHook, a reply after the hook applied resolves", async () => {
    const fake = fakeHost()
    const registry = new TurnRegistry()
    const runner = createTurnRunner(fake.host, {
      agent: "discuss-participant",
      directory: "C:/temp",
      timeoutMs: 1000,
      registry,
      requireContextHook: true,
    })
    const pending = runner.run(model, messages, 100, () => {})
    const sessionID = await ready(fake)
    expect(registry.get(sessionID)?.messages).toEqual(messages)
    registry.markApplied(sessionID)
    fake.emit({ type: "delta", sessionID, delta: "on topic" })
    fake.emit({ type: "succeeded", sessionID })

    const settled = await settle(pending)
    expect(settled.ok).toBe(true)
    if (settled.ok) expect(settled.value.text).toBe("on topic")
    // Released after the turn: a stale hook call cannot mark it again.
    registry.markApplied(sessionID)
    expect(registry.applied(sessionID)).toBe(false)
  })

  const limited = (fake: ReturnType<typeof fakeHost>, registry: TurnRegistry) =>
    createTurnRunner(fake.host, {
      agent: "discuss-participant",
      directory: "C:/temp",
      timeoutMs: 1000,
      registry,
      requireContextHook: true,
      stopOnContinuation: true,
    })

  test("a normal turn reports exactly one model request", async () => {
    const fake = fakeHost()
    const registry = new TurnRegistry()
    const pending = limited(fake, registry).run(model, messages, 100, () => {})
    const sessionID = await ready(fake)
    expect(registry.step(sessionID)).toBe(1) // what the context hook does
    registry.markApplied(sessionID)
    fake.emit({ type: "delta", sessionID, delta: "ok" })
    fake.emit({ type: "succeeded", sessionID })

    const settled = await settle(pending)
    expect(settled.ok && settled.value).toMatchObject({ text: "ok", requests: 1 })
    expect(fake.interrupted).toEqual([])
  })

  test("a host continuation after the output limit ends the turn with the text so far, marked", async () => {
    const fake = fakeHost()
    const registry = new TurnRegistry()
    const pending = limited(fake, registry).run(model, messages, 300, () => {})
    const sessionID = await ready(fake)
    registry.step(sessionID)
    registry.markApplied(sessionID)
    fake.emit({ type: "delta", sessionID, delta: "Кооперативный режим — " })
    // OpenCode starts a continuation: the hook sees a second request.
    expect(registry.step(sessionID)).toBe(2)
    registry.markTruncated(sessionID)

    const settled = await settle(pending)
    expect(settled.ok).toBe(true)
    if (settled.ok) {
      expect(settled.value.truncated).toBe(true)
      expect(settled.value.requests).toBe(2)
      expect(settled.value.text).toBe("Кооперативный режим —\n\n[truncated at the output limit]")
    }
    expect(fake.interrupted).toEqual([sessionID])
    expect(fake.removed).toEqual([sessionID])
  })

  test("a continuation before any visible text fails with an actionable output-limit error", async () => {
    const fake = fakeHost()
    const registry = new TurnRegistry()
    const pending = limited(fake, registry).run(model, messages, 300, () => {})
    const sessionID = await ready(fake)
    registry.step(sessionID)
    registry.markApplied(sessionID)
    registry.step(sessionID)
    registry.markTruncated(sessionID)

    const settled = await settle(pending)
    expect(settled.ok).toBe(false)
    if (!settled.ok) {
      expect(settled.error?.kind).toBe("output_limit")
      expect(settled.error?.requests).toBe(2)
      expect(String(settled.error?.message)).toContain("/discuss-settings tokens=1200")
    }
    expect(fake.interrupted).toEqual([sessionID])
  })

  test("the registry ignores steps and marks for turns it does not hold", () => {
    const registry = new TurnRegistry()
    expect(registry.step("ses_unknown")).toBe(0)
    registry.markTruncated("ses_unknown")
    expect(registry.truncated("ses_unknown")).toBe(false)
  })

  test("an empty answer is an error, not a completed turn", async () => {
    const fake = fakeHost()
    const runner = createTurnRunner(fake.host, { agent: "discuss-participant", directory: "C:/temp", timeoutMs: 1000 })
    const pending = runner.run(model, messages, 100, () => {})
    const sessionID = await ready(fake)
    fake.emit({ type: "succeeded", sessionID })

    const settled = await settle(pending)
    expect(settled.ok).toBe(false)
    if (!settled.ok) expect(settled.error?.kind).toBe("empty")
    expect(fake.removed).toHaveLength(1)
  })

  test("a silent session times out and cleans up", async () => {
    const fake = fakeHost()
    const runner = createTurnRunner(fake.host, { agent: "discuss-participant", directory: "C:/temp", timeoutMs: 60 })
    const pending = runner.run(model, messages, 100, () => {})
    await ready(fake)

    const settled = await settle(pending)
    expect(settled.ok).toBe(false)
    if (!settled.ok) expect(settled.error?.kind).toBe("timeout")
    expect(fake.interrupted).toHaveLength(1)
    expect(fake.removed).toHaveLength(1)
  })

  test("a prompt failure rejects without leaking a session", async () => {
    const fake = fakeHost()
    fake.host.prompt = async () => {
      throw new Error("cannot prompt")
    }
    const runner = createTurnRunner(fake.host, { agent: "discuss-participant", directory: "C:/temp", timeoutMs: 1000 })

    const settled = await settle(runner.run(model, messages, 100, () => {}))
    expect(settled.ok).toBe(false)
    if (!settled.ok) expect(String(settled.error?.message)).toContain("cannot prompt")
    expect(fake.removed).toHaveLength(1)
  })
})

describe("line decoder", () => {
  test("reassembles an event split across chunks", () => {
    const decoder = new LineDecoder()
    expect(decoder.push('{"type":"mess')).toEqual([])
    expect(decoder.push('age","text":"hi"}\n')).toEqual(['{"type":"message","text":"hi"}'])
  })

  test("keeps unicode intact across chunk boundaries", () => {
    const decoder = new LineDecoder()
    const line = JSON.stringify({ type: "message", text: "Привет 👋" }) + "\n"
    const middle = Math.floor(line.length / 2)
    expect(decoder.push(line.slice(0, middle))).toEqual([])
    expect(decoder.push(line.slice(middle))).toEqual([line.trim()])
  })

  test("ignores blank lines and keeps several events in one chunk", () => {
    const decoder = new LineDecoder()
    expect(decoder.push("a\n\nb\n")).toEqual(["a", "b"])
  })

  test("rejects an oversized line instead of buffering without bound", () => {
    const dropped: number[] = []
    const decoder = new LineDecoder(16, (length) => dropped.push(length))
    expect(decoder.push("x".repeat(20))).toEqual([])
    expect(decoder.push("yy\nok\n")).toEqual(["ok"])
    expect(dropped).toEqual([22])
  })

  test("an overlong line inside one chunk is dropped and its neighbours are kept", () => {
    const dropped: number[] = []
    const decoder = new LineDecoder(8, (length) => dropped.push(length))
    expect(decoder.push("short\n" + "z".repeat(30) + "\nafter\n")).toEqual(["short", "after"])
    expect(dropped).toEqual([30])
  })

  test("a line exactly at the limit passes, one character more does not", () => {
    const dropped: number[] = []
    const decoder = new LineDecoder(5, (length) => dropped.push(length))
    expect(decoder.push("abcde\nabcdef\n")).toEqual(["abcde"])
    expect(dropped).toEqual([6])
  })

  test("a partial line grows over the limit across chunks and is skipped to its newline", () => {
    const dropped: number[] = []
    const decoder = new LineDecoder(10, (length) => dropped.push(length))
    expect(decoder.push("aaaaaa")).toEqual([])
    expect(decoder.push("aaaaaa")).toEqual([])
    expect(decoder.push("aaa")).toEqual([])
    expect(decoder.push("a\nnext\n")).toEqual(["next"])
    expect(dropped).toEqual([16])
  })
})
