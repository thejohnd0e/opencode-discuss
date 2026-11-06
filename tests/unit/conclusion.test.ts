import { describe, expect, test } from "bun:test"
import { DiscussionService } from "../../src/discussion/service"
import { DiscussionStore, validateSettings } from "../../src/discussion/store"
import { buildHandoff } from "../../src/discussion/handoff"
import { createRunner, type Runner, type RunnerEvent, type RunnerFinished, type RunnerStart } from "../../src/discussion/runner"
import { callBound, dialogueReplies, isDialogueReply, type Run, type Settings } from "../../src/discussion/types"
import { applySettingsArgs, describeSettings } from "../../src/ui/settings"
import { EventEmitter } from "node:events"

const base: Settings = {
  a: { providerID: "p", modelID: "left" },
  b: { providerID: "p", modelID: "right" },
  mode: "cooperative",
  rounds: 1,
  maxOutputTokens: 500,
}

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
  readonly starts: RunnerStart[] = []
  #resolve!: (value: RunnerFinished) => void
  finished: Promise<RunnerFinished> = new Promise((resolve) => {
    this.#resolve = resolve
  })
  start(_topic: string, options: RunnerStart) {
    this.starts.push(options)
  }
  stop() {}
  interject() {}
  changeTopic() {}
  abort() {}
  dispose() {}
  emit(event: RunnerEvent) {
    for (const listener of this.events) listener(event)
  }
  finish(value: RunnerFinished) {
    this.#resolve(value)
  }
}

async function setup(settings: Settings) {
  const store = await DiscussionStore.open(memory())
  store.setSettings("loc", "ses", settings)
  const runner = new FakeRunner()
  const service = new DiscussionService({
    store,
    location: "loc",
    verifySession: async () => true,
    emit: () => {},
    createRunner: (onEvent) => {
      runner.events.push(onEvent)
      return runner
    },
    python: "python",
    script: "runner.py",
    cwd: "C:/work",
  })
  const started = await service.start("ses", "topic", "req-1")
  if (!started.ok) throw new Error("start failed")
  return { store, runner, service, runID: started.runID }
}

async function settled(service: DiscussionService, runID: string) {
  for (let index = 0; index < 100 && service.snapshot("ses", runID)?.status === "running"; index++) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return service.snapshot("ses", runID)
}

describe("conclusion setting", () => {
  test("conclusion=a|b|none is parsed, and none removes it", () => {
    const withA = applySettingsArgs(["conclusion=a"], base)
    expect(withA.ok && withA.settings.conclusion).toBe("a")
    const off = applySettingsArgs(["conclusion=none"], { ...base, conclusion: "b" })
    expect(off.ok && "conclusion" in off.settings).toBe(false)
    const alias = applySettingsArgs(["summary=off"], { ...base, conclusion: "a" })
    expect(alias.ok && alias.settings.conclusion).toBeUndefined()
    expect(applySettingsArgs(["conclusion=both"], base).ok).toBe(false)
  })

  test("the ceiling counts one more call with a conclusion", () => {
    expect(callBound(base)).toEqual({ participantCalls: 2, worstCaseOutputTokens: 1000 })
    expect(callBound({ ...base, conclusion: "b" })).toEqual({ participantCalls: 3, worstCaseOutputTokens: 1500 })
    expect(dialogueReplies({ ...base, conclusion: "b" })).toBe(2)
    expect(describeSettings({ ...base, conclusion: "b" })).toContain("conclusion by B · ceiling: 3 calls")
    expect(describeSettings(base)).toContain("no conclusion")
  })

  test("stored settings accept a missing or valid conclusion and reject others", () => {
    expect(validateSettings(base).conclusion).toBeUndefined()
    expect(validateSettings({ ...base, conclusion: "a" }).conclusion).toBe("a")
    expect(validateSettings({ ...base, conclusion: "none" }).conclusion).toBeUndefined()
    expect(() => validateSettings({ ...base, conclusion: "c" })).toThrow()
  })

  test("the conclusion is not a dialogue reply", () => {
    expect(isDialogueReply({ speaker: "a", label: "x", round: 1, text: "t" })).toBe(true)
    expect(isDialogueReply({ speaker: "a", label: "x", round: 1, text: "t", kind: "conclusion" })).toBe(false)
    expect(isDialogueReply({ speaker: "human", label: "x", round: 1, text: "t" })).toBe(false)
  })
})

describe("conclusion in a run", () => {
  test("the runner is told who writes it", async () => {
    const { runner } = await setup({ ...base, conclusion: "b" })
    expect(runner.starts[0].conclusion).toBe("b")
    const plain = await setup(base)
    expect(plain.runner.starts[0].conclusion).toBeUndefined()
  })

  test("a run with both replies and the conclusion completes, and the conclusion is stored as such", async () => {
    const { runner, service, runID } = await setup({ ...base, conclusion: "a" })
    runner.emit({ type: "message", speaker: "p/left", round: 1, text: "one" })
    runner.emit({ type: "message", speaker: "p/right", round: 1, text: "two", check: { quoted: 1, matched: 0 } })
    runner.emit({ type: "message", speaker: "p/right", round: 1, text: "bad", check: { quoted: 1, matched: 5 } } as never)
    runner.emit({ type: "delta", speaker: "p/left", round: 1, text: "Agr", conclusion: true })
    runner.emit({ type: "message", speaker: "p/left", round: 1, text: "Agreed: …", conclusion: true })
    runner.finish({ status: "completed", messages: 3, stopped: false, exitCode: 0 })
    const run = await settled(service, runID)
    expect(run?.status).toBe("completed")
    expect(run?.messages.map((message) => message.kind ?? "reply")).toEqual(["reply", "reply", "reply", "conclusion"])
    expect(run?.messages[3].speaker).toBe("a")
    // the service keeps a valid answer check and drops an impossible one
    expect(run?.messages[1].check).toEqual({ quoted: 1, matched: 0 })
    expect(run?.messages[2].check).toBeUndefined()
  })

  test("a run whose conclusion is missing is failed with a clear reason", async () => {
    const { runner, service, runID } = await setup({ ...base, conclusion: "a" })
    runner.emit({ type: "message", speaker: "p/left", round: 1, text: "one" })
    runner.emit({ type: "message", speaker: "p/right", round: 1, text: "two" })
    runner.finish({ status: "completed", messages: 2, stopped: false, exitCode: 0 })
    const run = await settled(service, runID)
    expect(run?.status).toBe("failed")
    expect(run?.error).toContain("conclusion")
  })

  test("the conclusion does not make a short dialogue look complete", async () => {
    const { runner, service, runID } = await setup({ ...base, conclusion: "a" })
    runner.emit({ type: "message", speaker: "p/left", round: 1, text: "one" })
    runner.emit({ type: "message", speaker: "p/left", round: 1, text: "sum", conclusion: true })
    runner.finish({ status: "completed", messages: 2, stopped: false, exitCode: 0 })
    const run = await settled(service, runID)
    expect(run?.status).toBe("failed")
    expect(run?.error).toContain("1 of 2")
  })
})

describe("conclusion in the handoff", () => {
  const run: Run = {
    runID: "r",
    topic: "Plan",
    settings: { ...base, conclusion: "b" },
    status: "completed",
    createdAt: 1,
    messages: [
      { speaker: "a", label: "p/left", round: 1, text: "Left view." },
      { speaker: "b", label: "p/right", round: 1, text: "Right view." },
      { speaker: "b", label: "p/right", round: 1, text: "Agreed: ship small. Next steps: 1. Tests.", kind: "conclusion" },
    ],
    partial: null,
  }

  test("comes first, names its author, and stays out of the positions", () => {
    const packet = buildHandoff(run)
    const conclusionAt = packet.indexOf("## Conclusion (written by B, p/right)")
    expect(conclusionAt).toBeGreaterThan(0)
    expect(conclusionAt).toBeLessThan(packet.indexOf("## Latest positions"))
    expect(packet).toContain("Check it against the positions below")
    const positions = packet.slice(packet.indexOf("## Latest positions"), packet.indexOf("## All statements"))
    expect(positions).toContain("Right view.")
    expect(positions).not.toContain("ship small")
    expect(packet).toContain("Replies: 2 of 2")
  })

  test("a run without a conclusion has no such section", () => {
    expect(buildHandoff({ ...run, messages: run.messages.slice(0, 2) })).not.toContain("## Conclusion")
  })
})

describe("runner arguments", () => {
  test("--conclusion is passed only when set", () => {
    const capture = (options: RunnerStart) => {
      let args: string[] = []
      const child = new EventEmitter() as any
      child.stdin = { write: () => true }
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.kill = () => {}
      createRunner({
        python: "python",
        script: "runner.py",
        cwd: "C:/w",
        turnTimeoutMs: 1000,
        outDir: "C:/o",
        spawn: (command) => {
          args = command
          return child
        },
        generate: async () => ({ text: "x" }),
        onEvent: () => {},
      }).start("t", options)
      return args
    }
    const withIt = capture({ rounds: 1, maxOutputTokens: 100, labels: { a: "A", b: "B" }, conclusion: "b" })
    expect(withIt[withIt.indexOf("--conclusion") + 1]).toBe("b")
    expect(capture({ rounds: 1, maxOutputTokens: 100, labels: { a: "A", b: "B" } })).not.toContain("--conclusion")
  })
})
