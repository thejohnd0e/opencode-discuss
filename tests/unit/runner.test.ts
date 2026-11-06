import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { createRunner, type RunnerEvent } from "../../src/discussion/runner"
import type { TurnMessage } from "../../src/discussion/provider"

function fakeChild() {
  const child = new EventEmitter() as any
  const written: string[] = []
  child.stdin = {
    write(text: string) {
      written.push(text)
      return true
    },
  }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.killed = false
  child.kill = () => {
    child.killed = true
  }
  child.written = written
  child.push = (obj: unknown) => {
    child.stdout.emit("data", JSON.stringify(obj) + "\n")
  }
  child.raw = (text: string) => child.stdout.emit("data", text)
  child.exit = (code: number) => { child.emit("exit", code); child.emit("close", code) }
  return child
}

function setup(generate: (event: any, signal: AbortSignal, onDelta: (text: string) => void) => Promise<{ text: string }>) {
  const child = fakeChild()
  const events: RunnerEvent[] = []
  const runner = createRunner({
    python: "python",
    script: "runner.py",
    cwd: "C:/work",
    turnTimeoutMs: 1000,
    outDir: "C:/out",
    spawn: () => child as never,
    generate: (request, signal, onDelta) => generate(request, signal, onDelta),
    onEvent: (event) => events.push(event),
  })
  return { child, events, runner }
}

const started = {
  type: "started",
  a: "Left",
  b: "Right",
  topic: "Topic",
  rounds: 1,
  models: ["p:left", "p:right"],
  bridge: true,
}

describe("subprocess runner", () => {
  test("forwards a generate request and returns the host's answer to Python", async () => {
    const { child, runner } = setup(async (request) => {
      expect(request.requestID).toBe("req-1")
      expect(request.side).toBe("a")
      expect(request.maxOutputTokens).toBe(100)
      expect(request.messages).toEqual([{ role: "user", content: "hi" }])
      return { text: "host answer" }
    })
    runner.start("Topic", { rounds: 1, maxOutputTokens: 100, labels: { a: "Left", b: "Right" } })

    child.push(started)
    child.push({
      type: "generate",
      requestID: "req-1",
      side: "a",
      model: "p:left",
      messages: [{ role: "user", content: "hi" }],
      maxOutputTokens: 100,
    })

    for (let index = 0; index < 100 && child.written.length === 0; index++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    const reply = JSON.parse(child.written[0])
    expect(reply).toEqual({ type: "result", requestID: "req-1", text: "host answer" })
    runner.dispose()
  })

  test("reports a generation failure back with the same request id", async () => {
    const { child, runner } = setup(async () => {
      throw new Error("provider down")
    })
    runner.start("Topic", { rounds: 1, maxOutputTokens: 100, labels: { a: "Left", b: "Right" } })
    child.push({
      type: "generate",
      requestID: "req-9",
      side: "b",
      model: "p:right",
      messages: [],
      maxOutputTokens: 100,
    })

    for (let index = 0; index < 100 && child.written.length === 0; index++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    const reply = JSON.parse(child.written[0])
    expect(reply.type).toBe("generation_error")
    expect(reply.requestID).toBe("req-9")
    expect(reply.message).toContain("provider down")
    runner.dispose()
  })

  test("sends human controls as JSON commands", () => {
    const { child, runner } = setup(async () => ({ text: "x" }))
    runner.start("Topic", { rounds: 1, maxOutputTokens: 100, labels: { a: "Left", b: "Right" } })
    runner.stop()
    runner.interject("consider the cost")
    runner.changeTopic("new topic")

    const commands = child.written.map((line: string) => JSON.parse(line))
    expect(commands.map((entry: any) => entry.command)).toEqual(["stop", "interject", "topic"])
    expect(commands[1].text).toBe("consider the cost")
    runner.dispose()
  })

  test("resolves done with the completed status and reply count", async () => {
    const { child, runner } = setup(async () => ({ text: "x" }))
    runner.start("Topic", { rounds: 1, maxOutputTokens: 100, labels: { a: "Left", b: "Right" } })
    child.push(started)
    child.push({ type: "message", speaker: "Left", round: 1, text: "hello" })
    child.push({ type: "done", messages: 1, stopped: false })
    child.exit(0)

    expect(await runner.finished).toMatchObject({ status: "completed", messages: 1, stopped: false })
  })

  test("a run without a done event or a non-zero exit is failed", async () => {
    const { child, runner } = setup(async () => ({ text: "x" }))
    runner.start("Topic", { rounds: 1, maxOutputTokens: 100, labels: { a: "Left", b: "Right" } })
    child.raw("not json\n")
    child.exit(2)

    expect(await runner.finished).toMatchObject({ status: "failed" })
  })

  test("final events that arrive after exit are still applied before settling", async () => {
    const { child, runner } = setup(async () => ({ text: "x" }))
    runner.start("Topic", { rounds: 1, maxOutputTokens: 100, labels: { a: "Left", b: "Right" } })
    child.emit("exit", 0)
    child.push({ type: "message", speaker: "Left", round: 1, text: "last reply" })
    child.push({ type: "done", messages: 1, stopped: false })
    child.emit("close", 0)

    expect(await runner.finished).toMatchObject({ status: "completed", messages: 1 })
  })

  test("utf-8 split across buffer chunks is not corrupted", async () => {
    const { child, runner, events } = setup(async () => ({ text: "x" }))
    runner.start("Topic", { rounds: 1, maxOutputTokens: 100, labels: { a: "Left", b: "Right" } })
    const payload = Buffer.from(JSON.stringify({ type: "message", speaker: "Left", round: 1, text: "Привет 👋" }) + "\n", "utf8")
    const cut = Math.floor(payload.length / 2)
    child.stdout.emit("data", payload.subarray(0, cut))
    child.stdout.emit("data", payload.subarray(cut))
    child.exit(0)

    const message = events.find((event) => event.type === "message")
    expect(message && "text" in message ? message.text : "").toBe("Привет 👋")
  })

  test("stop aborts the provider turn as well as telling Python", () => {
    const signals: AbortSignal[] = []
    const { child, runner } = setup((_request, signal) => { signals.push(signal); return new Promise(() => {}) })
    runner.start("Topic", { rounds: 1, maxOutputTokens: 100, labels: { a: "Left", b: "Right" } })
    child.push({ type: "generate", requestID: "req-1", side: "a", model: "p:left", messages: [], maxOutputTokens: 100 })
    runner.stop()
    expect(signals[0]?.aborted).toBe(true)
  })

  test("a stop followed by a clean exit is cancelled even if Python reported done", async () => {
    const { child, runner } = setup(async () => ({ text: "x" }))
    runner.start("Topic", { rounds: 1, maxOutputTokens: 100, labels: { a: "Left", b: "Right" } })
    runner.stop()
    child.push({ type: "done", messages: 0, stopped: true })
    child.exit(0)

    expect(await runner.finished).toMatchObject({ status: "cancelled" })
  })

  test("provider deltas reach Python with the request id, before the result", async () => {
    const { child, runner } = setup(async (_request, _signal, onDelta) => {
      onDelta("При")
      onDelta("вет 👋")
      onDelta("")
      return { text: "Привет 👋" }
    })
    runner.start("Topic", { rounds: 1, maxOutputTokens: 100, labels: { a: "Left", b: "Right" } })
    child.push({ type: "generate", requestID: "req-1", side: "a", model: "p:left", messages: [], maxOutputTokens: 100 })

    for (let index = 0; index < 100 && child.written.length < 3; index++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    const lines = child.written.map((line: string) => JSON.parse(line))
    expect(lines).toEqual([
      { type: "delta", requestID: "req-1", text: "При" },
      { type: "delta", requestID: "req-1", text: "вет 👋" },
      { type: "result", requestID: "req-1", text: "Привет 👋" },
    ])
  })

  test("no delta is sent after stop or after the request settled", async () => {
    let late: ((text: string) => void) | undefined
    let release: (() => void) | undefined
    const { child, runner } = setup((request, _signal, onDelta) => {
      if (request.requestID === "req-1") {
        late = onDelta
        return Promise.resolve({ text: "done" })
      }
      return new Promise((resolve) => {
        release = () => {
          onDelta("after stop")
          resolve({ text: "" })
        }
      })
    })
    runner.start("Topic", { rounds: 1, maxOutputTokens: 100, labels: { a: "Left", b: "Right" } })
    child.push({ type: "generate", requestID: "req-1", side: "a", model: "p:left", messages: [], maxOutputTokens: 100 })
    for (let index = 0; index < 100 && child.written.length < 1; index++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    late?.("stale")

    child.push({ type: "generate", requestID: "req-2", side: "b", model: "p:right", messages: [], maxOutputTokens: 100 })
    runner.stop()
    release?.()
    await new Promise((resolve) => setTimeout(resolve, 20))

    const deltas = child.written.map((line: string) => JSON.parse(line)).filter((line: any) => line.type === "delta")
    expect(deltas).toEqual([])
  })

  test("dispose kills a live child", () => {
    const { child, runner } = setup(async () => ({ text: "x" }))
    runner.start("Topic", { rounds: 1, maxOutputTokens: 100, labels: { a: "Left", b: "Right" } })
    runner.dispose()
    expect(child.killed).toBe(true)
  })

  function withKill(killAfterMs: number) {
    const child = fakeChild()
    const killed: unknown[] = []
    const runner = createRunner({
      python: "python",
      script: "runner.py",
      cwd: "C:/work",
      turnTimeoutMs: 1000,
      outDir: "C:/out",
      killAfterMs,
      terminate: (target) => {
        killed.push(target)
      },
      spawn: () => child as never,
      generate: async () => ({ text: "x" }),
      onEvent: () => {},
    })
    runner.start("Topic", { rounds: 1, maxOutputTokens: 100, labels: { a: "Left", b: "Right" } })
    return { child, killed, runner }
  }

  test("a child that ignores stop is killed after the grace period and the run settles", async () => {
    const { killed, runner } = withKill(20)
    let result: any = null
    runner.finished.then((value) => {
      result = value
    })
    runner.stop()
    expect(killed.length).toBe(0)
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(killed.length).toBe(1)
    // the pipes never closed: the run is still released shortly afterwards
    await new Promise((resolve) => setTimeout(resolve, 1100))
    expect(result?.status).toBe("cancelled")
    expect(result?.stopped).toBe(true)
  })

  test("a child that exits in time is not killed", async () => {
    const { child, killed, runner } = withKill(30)
    runner.stop()
    child.push({ type: "done", messages: 0, stopped: true })
    child.exit(0)
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(killed.length).toBe(0)
  })

  test("arguments carry the topic, limits and model identities", () => {
    let args: string[] = []
    const child = fakeChild()
    createRunner({
      python: "python",
      script: "runner.py",
      cwd: "C:/work",
      turnTimeoutMs: 1000,
      outDir: "C:/out",
      spawn: (command) => {
        args = command
        return child as never
      },
      generate: async () => ({ text: "x" }),
      onEvent: () => {},
    }).start("A topic with spaces", {
      rounds: 3,
      maxOutputTokens: 900,
      mode: "critical",
      labels: { a: "Left", b: "Right" },
      models: { a: "p:left", b: "p:right" },
    })

    expect(args).toContain("--bridge")
    expect(args).toContain("--stream")
    expect(args).toContain("--critical")
    expect(args[args.indexOf("--out-dir") + 1]).toBe("C:/out")
    expect(args[args.indexOf("--topic") + 1]).toBe("A topic with spaces")
    expect(args[args.indexOf("--rounds") + 1]).toBe("3")
    expect(args[args.indexOf("--max-tokens") + 1]).toBe("900")
    expect(args[args.indexOf("--a-name") + 1]).toBe("Left")
  })
})
