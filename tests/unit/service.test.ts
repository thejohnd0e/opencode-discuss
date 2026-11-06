import { describe, expect, test } from "bun:test"
import { DiscussionService, MAX_REMEMBERED_REQUESTS, type ServiceEvent } from "../../src/discussion/service"
import { DiscussionStore } from "../../src/discussion/store"
import type { Runner, RunnerEvent, RunnerFinished, RunnerStart } from "../../src/discussion/runner"
import type { ModelRef, Settings } from "../../src/discussion/types"

const A: ModelRef = { providerID: "provider", modelID: "left" }
const B: ModelRef = { providerID: "provider", modelID: "right" }
const settings: Settings = { a: A, b: B, mode: "cooperative", rounds: 1, maxOutputTokens: 100 }

function memory() {
  const values = new Map<string, unknown>()
  return {
    async get(key: string) {
      return values.get(key)
    },
    async set(key: string, value: unknown) {
      values.set(key, structuredClone(value))
    },
    async remove(key: string) {
      values.delete(key)
    },
  }
}

class FakeRunner implements Runner {
  readonly events: Array<(event: RunnerEvent) => void> = []
  readonly startArgs: Array<{ topic: string; options: RunnerStart }> = []
  readonly commands: string[] = []
  killed = false
  #resolve!: (value: RunnerFinished) => void
  finished: Promise<RunnerFinished> = new Promise((resolve) => {
    this.#resolve = resolve
  })

  start(topic: string, options: RunnerStart) {
    this.startArgs.push({ topic, options })
  }
  stop() {
    this.commands.push("stop")
  }
  interject(text: string) {
    this.commands.push(`interject:${text}`)
  }
  changeTopic(text: string) {
    this.commands.push(`topic:${text}`)
  }
  abort() {}
  dispose() {
    this.killed = true
  }
  emit(event: RunnerEvent) {
    for (const listener of this.events) listener(event)
  }
  finish(value: RunnerFinished) {
    this.#resolve(value)
  }
}

async function setup(verify: (sessionID: string) => Promise<boolean> = async () => true) {
  const store = await DiscussionStore.open(memory())
  store.setSettings("location-1", "session-a", settings)
  store.setSettings("location-1", "session-b", settings)
  const runner = new FakeRunner()
  const emitted: ServiceEvent[] = []
  const service = new DiscussionService({
    store,
    location: "location-1",
    verifySession: verify,
    emit: (event) => emitted.push(event),
    createRunner: (onEvent) => {
      runner.events.push(onEvent)
      return runner
    },
    python: "python",
    script: "runner.py",
    cwd: "C:/work",
  })
  return { store, runner, service, emitted }
}

describe("discussion service lifecycle", () => {
  test("refuses to start without an explicit model pair", async () => {
    const { store, service } = await setup()
    store.setSettings("location-1", "session-c", settings)
    const raw = store.session("location-1", "session-c")
    raw.settings = null

    const result = await service.start("session-c", "topic", "request-1")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe("invalid_settings")
  })

  test("the same request id returns the same run exactly once", async () => {
    const { service, runner } = await setup()
    const first = await service.start("session-a", "topic", "request-1")
    const second = await service.start("session-a", "topic", "request-1")

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (first.ok && second.ok) expect(second.runID).toBe(first.runID)
    expect(runner.startArgs).toHaveLength(1)
  })

  test("one active run per location rejects another session as busy", async () => {
    const { service } = await setup()
    const first = await service.start("session-a", "topic", "request-1")
    const second = await service.start("session-b", "topic", "request-2")

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.error).toBe("busy")
  })

  test("a session from another location is not found", async () => {
    const { service } = await setup(async () => false)
    const result = await service.start("session-a", "topic", "request-1")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe("not_found")
  })

  test("messages, partial text and the transcript reach the store", async () => {
    const { service, runner } = await setup()
    const started = await service.start("session-a", "topic", "request-1")
    expect(started.ok).toBe(true)
    if (!started.ok) return

    runner.emit({ type: "delta", speaker: "Left", round: 1, text: "par" })
    runner.emit({ type: "message", speaker: "Left", round: 1, text: "partial answer" })
    runner.emit({ type: "transcript", path: "C:/t.md" })

    const snapshot = service.snapshot("session-a", started.runID)
    expect(snapshot?.messages.map((entry) => entry.text)).toEqual(["partial answer"])
    expect(snapshot?.transcript).toBe("C:/t.md")
  })

  test("a runner failure marks the run failed even after a successful reply", async () => {
    const { service, runner } = await setup()
    const started = await service.start("session-a", "topic", "request-1")
    if (!started.ok) throw new Error("start failed")
    runner.emit({ type: "message", speaker: "Left", round: 1, text: "one good reply" })
    runner.finish({ status: "failed", messages: 1, stopped: false, exitCode: 1, error: "provider down" })

    for (let index = 0; index < 100 && service.snapshot("session-a", started.runID)?.status === "running"; index++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    const snapshot = service.snapshot("session-a", started.runID)
    expect(snapshot?.status).toBe("failed")
    expect(snapshot?.error).toContain("provider down")
  })

  test("a user stop produces cancelled, not completed", async () => {
    const { service, runner } = await setup()
    const started = await service.start("session-a", "topic", "request-1")
    if (!started.ok) throw new Error("start failed")
    service.stop("session-a", started.runID)
    runner.finish({ status: "cancelled", messages: 0, stopped: true, exitCode: 0 })

    for (let index = 0; index < 100 && service.snapshot("session-a", started.runID)?.status === "running"; index++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(service.snapshot("session-a", started.runID)?.status).toBe("cancelled")
    expect(runner.commands).toContain("stop")
  })

  test("a stale run id cannot stop or interject", async () => {
    const { service } = await setup()
    const started = await service.start("session-a", "topic", "request-1")
    if (!started.ok) throw new Error("start failed")

    expect(service.stop("session-a", "other")).toBe(false)
    expect(service.interject("session-a", "other", "hello")).toBe(false)
    expect(service.changeTopic("session-a", "other", "next")).toBe(false)
  })

  test("events emitted after the terminal transition are ignored", async () => {
    const { service, runner } = await setup()
    const started = await service.start("session-a", "topic", "request-1")
    if (!started.ok) throw new Error("start failed")
    runner.finish({ status: "completed", messages: 0, stopped: false, exitCode: 0 })
    for (let index = 0; index < 100 && service.snapshot("session-a", started.runID)?.status === "running"; index++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }

    runner.emit({ type: "message", speaker: "Left", round: 1, text: "late" })
    expect(service.snapshot("session-a", started.runID)?.messages).toHaveLength(0)
  })

  test("history keeps runs in order and a new run is allowed after the first ends", async () => {
    const { service, runner } = await setup()
    const first = await service.start("session-a", "first", "request-1")
    if (!first.ok) throw new Error("start failed")
    runner.finish({ status: "completed", messages: 0, stopped: false, exitCode: 0 })
    for (let index = 0; index < 100 && service.active("location-1"); index++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    const second = await service.start("session-a", "second", "request-2")
    expect(second.ok).toBe(true)
    expect(service.history("session-a").map((run) => run.topic)).toEqual(["first", "second"])
  })

  test("settings changes during a run do not alter its frozen settings", async () => {
    const { store, service } = await setup()
    const started = await service.start("session-a", "topic", "request-1")
    if (!started.ok) throw new Error("start failed")
    store.setSettings("location-1", "session-a", { ...settings, rounds: 4, maxOutputTokens: 2000 })

    expect(service.snapshot("session-a", started.runID)?.settings.rounds).toBe(1)
    expect(runnerStart(service)).toBeDefined()
  })

  test("two concurrent starts admit exactly one run", async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { store, service } = await setup(async () => {
      await gate
      return true
    })
    store.setSettings("location-1", "session-a", settings)

    const first = service.start("session-a", "topic a", "request-1")
    const second = service.start("session-b", "topic b", "request-2")
    await new Promise((resolve) => setTimeout(resolve, 5))
    release?.()
    const results = await Promise.all([first, second])

    expect(results.filter((result) => result.ok)).toHaveLength(1)
    expect(results.filter((result) => !result.ok && result.error === "busy")).toHaveLength(1)
    expect(service.history("session-a").length + service.history("session-b").length).toBe(1)
  })

  test("settings changing during confirmation aborts the launch", async () => {
    let service: DiscussionService | undefined
    const { store, service: created } = await setup(async () => {
      store.setSettings("location-1", "session-a", { ...settings, rounds: 3 })
      return true
    })
    service = created
    const result = await service.start("session-a", "topic", "request-1")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe("invalid_settings")
    expect(store.session("location-1", "session-a").runs).toHaveLength(0)
  })

  test("an interjection does not count as a participant reply", async () => {
    const { service, runner } = await setup()
    const started = await service.start("session-a", "topic", "request-1")
    if (!started.ok) throw new Error("start failed")
    runner.emit({ type: "message", speaker: "provider/left", round: 1, text: "one reply" })
    runner.emit({ type: "control", command: "interject", text: "human note" })
    runner.finish({ status: "completed", messages: 1, stopped: false, exitCode: 0 })

    for (let index = 0; index < 100 && service.snapshot("session-a", started.runID)?.status === "running"; index++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    const snapshot = service.snapshot("session-a", started.runID)
    expect(snapshot?.status).toBe("failed")
    expect(snapshot?.error).toContain("incomplete discussion")
  })

  test("unloading the server marks a live run cancelled", async () => {
    const { service } = await setup()
    const started = await service.start("session-a", "topic", "request-1")
    if (!started.ok) throw new Error("start failed")
    service.dispose()

    expect(service.snapshot("session-a", started.runID)?.status).toBe("cancelled")
  })

  test("identical models still get distinct participant labels", async () => {
    const { store, service, runner } = await setup()
    store.setSettings("location-1", "session-a", { ...settings, b: settings.a })
    const started = await service.start("session-a", "topic", "request-1")
    expect(started.ok).toBe(true)
    const labels = runner.startArgs[0].options.labels
    expect(labels.a).not.toBe(labels.b)

    runner.emit({ type: "message", speaker: labels.a, round: 1, text: "left" })
    runner.emit({ type: "message", speaker: labels.b, round: 1, text: "right" })
    const snapshot = service.snapshot("session-a", started.ok ? started.runID : "")
    expect(snapshot?.messages.map((message) => message.speaker)).toEqual(["a", "b"])
  })
})

function runnerStart(service: DiscussionService) {
  return service.active("location-1")
}

describe("preflight in start", () => {
  test("a failing preflight stops the start before a run is created", async () => {
    const store = await DiscussionStore.open(memory())
    store.setSettings("location-1", "session-a", settings)
    let created = 0
    const service = new DiscussionService({
      store,
      location: "location-1",
      verifySession: async () => true,
      preflight: async () => ({ error: "model_unavailable", reason: "gone", side: "b", modelID: "right" }),
      emit: () => {},
      createRunner: () => {
        created++
        return new FakeRunner()
      },
      python: "python",
      script: "runner.py",
      cwd: "C:/work",
    })
    const result = await service.start("session-a", "Topic", "req-pre")
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe("model_unavailable")
      expect(result.side).toBe("b")
    }
    expect(created).toBe(0)
    expect(service.active("location-1")).toBeNull()
  })
})

describe("request id memory", () => {
  test("only the most recent start request ids are remembered", async () => {
    const store = await DiscussionStore.open(memory())
    store.setSettings("location-1", "session-a", settings)
    const runners: FakeRunner[] = []
    const service = new DiscussionService({
      store,
      location: "location-1",
      verifySession: async () => true,
      emit: () => {},
      createRunner: (onEvent) => {
        const runner = new FakeRunner()
        runner.events.push(onEvent)
        runners.push(runner)
        return runner
      },
      python: "python",
      script: "runner.py",
      cwd: "C:/work",
    })
    const total = MAX_REMEMBERED_REQUESTS + 2
    const runIDs: string[] = []
    for (let index = 0; index < total; index++) {
      const result = await service.start("session-a", "topic", `r-${index}`)
      expect(result.ok).toBe(true)
      if (result.ok) runIDs.push(result.runID)
      runners.at(-1)!.finish({ status: "completed", messages: 0, stopped: false, exitCode: 0 })
      for (let wait = 0; wait < 50 && service.active("location-1"); wait++) await new Promise((resolve) => setTimeout(resolve, 0))
    }
    const recent = await service.start("session-a", "topic", `r-${total - 1}`)
    expect(recent.ok && recent.runID).toBe(runIDs[total - 1])
    expect(runners).toHaveLength(total)
    const forgotten = await service.start("session-a", "topic", "r-0")
    expect(forgotten.ok && forgotten.runID).not.toBe(runIDs[0])
    expect(runners).toHaveLength(total + 1)
  })
})
