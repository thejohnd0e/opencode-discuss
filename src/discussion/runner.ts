import { spawn as nodeSpawn, spawnSync } from "node:child_process"
import { StringDecoder } from "node:string_decoder"
import type { Readable } from "node:stream"
import { LineDecoder } from "./line"
import type { TurnMessage } from "./provider"
import type { Mode, Status } from "./types"

export type RunnerEvent =
  | { type: "started"; a: string; b: string; topic: string; rounds: number; models: string[]; bridge?: boolean }
  | {
      type: "message"
      speaker: string
      round: number
      text: string
      seconds?: number
      conclusion?: boolean
      check?: { quoted: number; matched: number; recycled?: number }
      ledger?: unknown
    }
  | { type: "delta"; speaker: string; round: number; text: string; conclusion?: boolean }
  | { type: "control"; command: string; text?: string }
  | { type: "transcript"; path: string; raw?: string }
  | { type: "error"; message: string; round?: number }
  | { type: "usage"; speaker?: string; input?: number; output?: number; cost?: number }
  | { type: "generate"; requestID: string; side: "a" | "b"; model: string; messages: TurnMessage[]; maxOutputTokens: number }
  | { type: "done"; messages: number; stopped: boolean }

export type RunnerFinished = {
  status: Exclude<Status, "idle" | "running">
  messages: number
  stopped: boolean
  exitCode: number | null
  error?: string
}

export type RunnerStart = {
  rounds: number
  maxOutputTokens: number
  mode?: Mode
  labels: { a: string; b: string }
  models?: { a: string; b: string }
  /** Side that writes the joint conclusion after the rounds. */
  conclusion?: "a" | "b"
}

type Child = {
  pid?: number
  stdin: ({ write(text: string): boolean; on?(event: "error", listener: (error: Error) => void): unknown } | null)
  stdout: Readable | null
  stderr: Readable | null
  kill(signal?: string): void
  on(event: "exit", listener: (code: number | null) => void): unknown
  on(event: "close", listener: (code: number | null) => void): unknown
  on(event: "error", listener: (error: Error) => void): unknown
}

export type RunnerOptions = {
  python: string
  script: string
  cwd: string
  turnTimeoutMs: number
  onEvent: (event: RunnerEvent) => void
  generate: (request: {
    requestID: string
    side: "a" | "b"
    model: string
    messages: TurnMessage[]
    maxOutputTokens: number
  }, signal: AbortSignal, onDelta: (text: string) => void) => Promise<{ text: string; usage?: { input?: number; output?: number; cost?: number } }>
  spawn?: (command: string[], options: Record<string, unknown>) => Child
  env?: Record<string, string | undefined>
  outDir: string
  /** How long a stopped child may keep running before it is killed. Default 5000. */
  killAfterMs?: number
  /** Kills the child and its descendants. Replaceable for tests. */
  terminate?: (child: Child) => void
}

/** Kill the child together with anything it started (Windows has no process groups by default). */
function terminateTree(child: Child) {
  try {
    if (process.platform === "win32" && child.pid) {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 3000 })
      return
    }
    child.kill("SIGKILL")
  } catch {
    try {
      child.kill()
    } catch {
      /* already gone */
    }
  }
}

export type Runner = {
  start(topic: string, options: RunnerStart): void
  stop(): void
  abort(): void
  interject(text: string): void
  changeTopic(text: string): void
  dispose(): void
  readonly finished: Promise<RunnerFinished>
}

export function createRunner(options: RunnerOptions): Runner {
  const spawn = options.spawn ?? ((command, spawnOptions) => nodeSpawn(command[0], command.slice(1), spawnOptions) as unknown as Child)
  const controller = new AbortController()
  const pending = new Set<string>()
  let child: Child | null = null
  let stopRequested = false
  let doneEvent: { messages: number; stopped: boolean } | null = null
  let exitCode: number | null = null
  let exited = false
  let stderrTail = ""
  let killTimer: ReturnType<typeof setTimeout> | null = null
  let settleTimer: ReturnType<typeof setTimeout> | null = null
  const terminate = options.terminate ?? terminateTree
  const killAfterMs = options.killAfterMs ?? 5000
  let resolveFinished: ((value: RunnerFinished) => void) | null = null
  let finished = new Promise<RunnerFinished>((resolve) => {
    resolveFinished = resolve
  })

  const clearTimers = () => {
    if (killTimer) clearTimeout(killTimer)
    if (settleTimer) clearTimeout(settleTimer)
    killTimer = null
    settleTimer = null
  }

  /** After a stop the child gets `killAfterMs` to finish; then it is killed. */
  const armKill = () => {
    if (killTimer || !child) return
    const target = child
    killTimer = setTimeout(() => {
      killTimer = null
      if (exited || child !== target) return
      stderrTail += "\nrunner did not exit after stop; it was killed"
      terminate(target)
      // If the pipes never close, do not leave the run hanging.
      settleTimer = setTimeout(() => {
        settleTimer = null
        if (exited) return
        exited = true
        child = null
        settle()
      }, 1000)
      settleTimer.unref?.()
    }, killAfterMs)
    killTimer.unref?.()
  }

  const settle = () => {
    if (!exited) return
    clearTimers()
    const status = stopRequested || doneEvent?.stopped ? "cancelled" : exitCode === 0 && doneEvent ? "completed" : "failed"
    resolveFinished?.({
      status,
      messages: doneEvent?.messages ?? 0,
      stopped: Boolean(stopRequested || doneEvent?.stopped),
      exitCode,
      ...(status === "failed" ? { error: stderrTail.trim() || `runner exited with ${String(exitCode)}` } : {}),
    })
  }

  const send = (payload: Record<string, unknown>) => {
    if (!child?.stdin) return false
    try {
      child.stdin.write(JSON.stringify(payload) + "\n")
      return true
    } catch {
      return false
    }
  }

  const handle = (line: string) => {
    let event: RunnerEvent
    try {
      event = JSON.parse(line) as RunnerEvent
    } catch {
      return
    }
    if (!event || typeof event !== "object" || typeof (event as { type?: unknown }).type !== "string") return

    if (event.type === "generate") {
      const request = event
      pending.add(request.requestID)
      // Stream pieces back to Python, which throttles and re-emits them as
      // `delta` events for the panel. Nothing is sent once the request settled
      // or the run was stopped.
      const onDelta = (text: string) => {
        if (!text || controller.signal.aborted || !pending.has(request.requestID)) return
        send({ type: "delta", requestID: request.requestID, text })
      }
      void options
        .generate(request, controller.signal, onDelta)
        .finally(() => {
          pending.delete(request.requestID)
        })
        .then((result) => {
          send({
            type: "result",
            requestID: request.requestID,
            text: result.text,
            ...(result.usage ? { usage: result.usage } : {}),
          })
        })
        .catch((error: unknown) => {
          send({
            type: "generation_error",
            requestID: request.requestID,
            message: String((error as Error)?.message ?? error),
          })
        })
      options.onEvent(request)
      return
    }

    if (event.type === "done") {
      doneEvent = { messages: event.messages, stopped: event.stopped }
    }
    options.onEvent(event)
  }

  return {
    start(topic, startOptions) {
      if (child) throw new Error("a runner is already active")
      stopRequested = false
      doneEvent = null
      exitCode = null
      exited = false
      stderrTail = ""
      finished = new Promise<RunnerFinished>((resolve) => {
        resolveFinished = resolve
      })

      const command = [
        options.python,
        options.script,
        "--bridge",
        "--stream",
        "--topic", topic,
        "--rounds", String(startOptions.rounds),
        "--max-tokens", String(startOptions.maxOutputTokens),
        "--turn-timeout", String(Math.max(1, Math.round(options.turnTimeoutMs / 1000))),
        "--out-dir", options.outDir,
        "--a", startOptions.models?.a ?? "a",
        "--b", startOptions.models?.b ?? "b",
        "--a-name", startOptions.labels.a,
        "--b-name", startOptions.labels.b,
      ]
      if (startOptions.mode === "debate") command.push("--debate")
      if (startOptions.mode === "critical") command.push("--critical")
      if (startOptions.conclusion) command.push("--conclusion", startOptions.conclusion)

      const running = spawn(command, {
        cwd: options.cwd,
        windowsHide: true,
        env: { ...process.env, ...options.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
      })
      child = running

      const decoder = new LineDecoder(undefined, (length) => {
        stderrTail = (stderrTail + `\nrunner sent an overlong line (${length} characters); it was dropped`).slice(-4000)
      })
      const utf8 = new StringDecoder("utf8")
      running.stdout?.on("data", (chunk: Buffer | string) => {
        try {
          const text = typeof chunk === "string" ? chunk : utf8.write(chunk)
          for (const line of decoder.push(text)) handle(line)
        } catch (error) {
          stderrTail += `\n${String((error as Error)?.message ?? error)}`
        }
      })
      running.stderr?.on("data", (chunk: Buffer | string) => {
        stderrTail = (stderrTail + String(chunk)).slice(-4000)
      })
      running.stdin?.on?.("error", () => {
        /* a late write after the child exited must not crash the host */
      })
      running.on("error", (error) => {
        stderrTail += `\n${error.message}`
        exitCode = null
        exited = true
        settle()
      })
      running.on("exit", (code) => {
        exitCode = code
      })
      running.on("close", (code) => {
        const rest = utf8.end()
        if (rest) {
          try {
            for (const line of decoder.push(rest)) handle(line)
          } catch {
            /* reported through the exit status */
          }
        }
        exitCode = exitCode ?? code
        exited = true
        child = null
        settle()
      })
    },

    stop() {
      stopRequested = true
      controller.abort()
      send({ type: "command", command: "stop" })
      armKill()
    },

    abort() {
      controller.abort()
    },

    interject(text) {
      send({ type: "command", command: "interject", text })
    },

    changeTopic(text) {
      send({ type: "command", command: "topic", text })
    },

    dispose() {
      controller.abort()
      clearTimers()
      if (child) terminate(child)
      child = null
    },

    get finished() {
      return finished
    },
  }
}

