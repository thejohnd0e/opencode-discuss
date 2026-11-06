import { describe, expect, test } from "bun:test"
import { DiscussionStore, openState, parseState } from "../../src/discussion/store"
import type { ModelRef, Settings } from "../../src/discussion/types"

const A: ModelRef = { providerID: "provider-a", modelID: "model-a" }
const B: ModelRef = { providerID: "provider-b", modelID: "model-b" }

const settings = (patch: Partial<Settings> = {}): Settings => ({
  a: A,
  b: B,
  mode: "cooperative",
  rounds: 2,
  maxOutputTokens: 1200,
  ...patch,
})

function memory() {
  const values = new Map<string, unknown>()
  return {
    writes: 0,
    async get(key: string) {
      return values.get(key) as never
    },
    async set(key: string, value: unknown) {
      this.writes += 1
      values.set(key, structuredClone(value))
    },
    async remove(key: string) {
      values.delete(key)
    },
    raw: values,
  }
}

describe("settings validation", () => {
  test("rejects rounds outside 1..12", () => {
    expect(() => parseState({ version: 2, sessions: {}, settings: settings({ rounds: 0 }) })).toThrow()
    expect(() => parseState({ version: 2, sessions: {}, settings: settings({ rounds: 13 }) })).toThrow()
    expect(() => parseState({ version: 2, sessions: {}, settings: settings({ rounds: 2.5 }) })).toThrow()
  })

  test("rejects a missing or empty model identity", () => {
    expect(() => parseState({ version: 2, sessions: {}, settings: settings({ a: { providerID: "", modelID: "x" } }) })).toThrow()
    expect(() => parseState({ version: 2, sessions: {}, settings: settings({ b: undefined as never }) })).toThrow()
  })

  test("rejects an unknown discussion mode", () => {
    expect(() => parseState({ version: 2, sessions: {}, settings: settings({ mode: "argument" as never }) })).toThrow()
  })

  test("rejects a non-positive output limit", () => {
    expect(() => parseState({ version: 2, sessions: {}, settings: settings({ maxOutputTokens: 0 }) })).toThrow()
  })
})

describe("state isolation and history", () => {
  test("two sessions in one location start empty and do not share runs", async () => {
    const storage = memory()
    const store = await DiscussionStore.open(storage)
    store.setSettings("location-1", "session-a", settings())
    store.setSettings("location-1", "session-b", settings({ mode: "debate" }))
    const a = store.startRun("location-1", "session-a", "topic a")
    const b = store.startRun("location-1", "session-b", "topic b")

    expect(store.session("location-1", "session-a").runs.map((run) => run.runID)).toEqual([a.runID])
    expect(store.session("location-1", "session-b").runs.map((run) => run.runID)).toEqual([b.runID])
    expect(store.session("location-1", "session-a").runs[0].topic).toBe("topic a")
    expect(store.session("location-1", "session-b").settings.mode).toBe("debate")
  })

  test("the same session id in another location is a different discussion", async () => {
    const storage = memory()
    const store = await DiscussionStore.open(storage)
    store.setSettings("location-1", "session-a", settings())
    store.setSettings("location-2", "session-a", settings({ rounds: 3 }))
    store.startRun("location-1", "session-a", "first")

    expect(store.session("location-1", "session-a").runs).toHaveLength(1)
    expect(store.session("location-2", "session-a").runs).toHaveLength(0)
    expect(store.session("location-2", "session-a").settings.rounds).toBe(3)
  })

  test("a new run keeps earlier runs", async () => {
    const storage = memory()
    const store = await DiscussionStore.open(storage)
    store.setSettings("location-1", "session-a", settings())
    const first = store.startRun("location-1", "session-a", "first topic")
    store.finishRun("location-1", "session-a", first.runID, "completed")
    const second = store.startRun("location-1", "session-a", "second topic")

    expect(store.session("location-1", "session-a").runs.map((run) => run.topic)).toEqual([
      "first topic",
      "second topic",
    ])
    expect(second.runID).not.toBe(first.runID)
  })

  test("messages and settings are frozen for an active run", async () => {
    const storage = memory()
    const store = await DiscussionStore.open(storage)
    store.setSettings("location-1", "session-a", settings())
    const run = store.startRun("location-1", "session-a", "topic")
    store.setSettings("location-1", "session-a", settings({ rounds: 5 }))
    store.appendMessage("location-1", "session-a", run.runID, { speaker: "a", round: 1, text: "hello" })

    expect(store.run("location-1", "session-a", run.runID)?.settings.rounds).toBe(2)
    expect(store.run("location-1", "session-a", run.runID)?.messages).toHaveLength(1)
    expect(store.session("location-1", "session-a").settings.rounds).toBe(5)
  })
})

describe("durability", () => {
  test("a reopened store sees the same history", async () => {
    const storage = memory()
    const first = await DiscussionStore.open(storage)
    first.setSettings("location-1", "session-a", settings())
    const run = first.startRun("location-1", "session-a", "topic")
    first.appendMessage("location-1", "session-a", run.runID, { speaker: "a", round: 1, text: "kept" })
    await first.flush()

    const second = await DiscussionStore.open(storage)
    expect(second.session("location-1", "session-a").runs).toHaveLength(1)
    expect(second.session("location-1", "session-a").runs[0].messages[0].text).toBe("kept")
  })

  test("a run interrupted by a restart is restored as cancelled", async () => {
    const storage = memory()
    const first = await DiscussionStore.open(storage)
    first.setSettings("location-1", "session-a", settings())
    const run = first.startRun("location-1", "session-a", "topic")
    await first.flush()

    const second = await DiscussionStore.open(storage)
    const restored = second.run("location-1", "session-a", run.runID)
    expect(restored?.status).toBe("cancelled")
    expect(restored?.error).toBe("interrupted by restart")
    expect(second.recoveredRuns).toBe(1)
  })

  test("corrupt storage is reported and a backup is kept without touching the source", async () => {
    const storage = memory()
    await storage.set("discuss/state", { version: 999, nonsense: true })
    const before = storage.writes
    const store = await DiscussionStore.open(storage)

    expect(store.corrupt).toBe(true)
    const backupKeys = [...storage.raw.keys()].filter((key) => key.startsWith("discuss/state.corrupt-"))
    expect(backupKeys).toHaveLength(1)
    expect(storage.raw.get("discuss/state")).toEqual({ version: 999, nonsense: true })
    expect(storage.writes).toBe(before + 1)
  })

  test("concurrent edits produce increasing revisions and one consistent snapshot", async () => {
    const storage = memory()
    const store = await DiscussionStore.open(storage)
    store.setSettings("location-1", "session-a", settings())
    const run = store.startRun("location-1", "session-a", "topic")

    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.appendMessage("location-1", "session-a", run.runID, {
          speaker: index % 2 === 0 ? "a" : "b",
          round: 1,
          text: `message ${index}`,
        }),
      ),
    )

    expect(store.session("location-1", "session-a").runs[0].messages).toHaveLength(20)
    expect(store.revision).toBeGreaterThanOrEqual(22)

    await store.flush()
    const reopened = await DiscussionStore.open(storage)
    expect(reopened.session("location-1", "session-a").runs[0].messages).toHaveLength(20)
  })

  test("unknown sessions read as empty without writing", async () => {
    const storage = memory()
    const store = await DiscussionStore.open(storage)
    const before = storage.writes
    expect(store.session("location-1", "missing").runs).toEqual([])
    expect(storage.writes).toBe(before)
  })
})

describe("legacy migration", () => {
  const legacy = {
    version: 1,
    sessions: {
      ses_one: {
        status: "completed",
        topic: "Old topic",
        rounds: 2,
        messages: [
          { speaker: "Qwen", round: 1, text: "left", seconds: 3 },
          { speaker: "DeepSeek", round: 1, text: "right" },
          { speaker: "Тема", round: 1, text: "topic change" },
        ],
        transcript: "C:/transcripts/one.md",
        models: { a: "local:test-model", b: "deepseek:deepseek-flash" },
        finishedAt: 1700000000000,
      },
      ses_two: {
        status: "cancelled",
        topic: "Unverified",
        messages: [],
        models: { a: "local:test-model", b: "deepseek:deepseek-flash" },
      },
      ses_three: {
        status: "completed",
        topic: "Bad models",
        messages: [],
        models: { a: "no-colon", b: "deepseek:deepseek-flash" },
      },
    },
  }

  test("imports a verified session with model identities and transcript", async () => {
    const store = await DiscussionStore.open(memory())
    const result = store.importLegacy(legacy, (id) => (id === "ses_one" ? "location-1" : null))

    expect(result).toEqual({ imported: 1, skipped: 2 })
    const record = store.session("location-1", "ses_one")
    expect(record.runs[0].topic).toBe("Old topic")
    expect(record.runs[0].settings.a).toEqual({ providerID: "local", modelID: "test-model" })
    expect(record.runs[0].messages.map((entry) => entry.speaker)).toEqual(["a", "b", "topic"])
    expect(record.runs[0].transcript).toBe("C:/transcripts/one.md")
  })

  test("a second import does not duplicate the same legacy run", async () => {
    const store = await DiscussionStore.open(memory())
    const verify = (id: string) => (id === "ses_one" ? "location-1" : null)
    store.importLegacy(legacy, verify)
    const second = store.importLegacy(legacy, verify)

    expect(second.imported).toBe(0)
    expect(store.session("location-1", "ses_one").runs).toHaveLength(1)
  })

  test("an empty or foreign snapshot imports nothing and does not throw", async () => {
    const store = await DiscussionStore.open(memory())
    expect(store.importLegacy(null, () => "location-1")).toEqual({ imported: 0, skipped: 0 })
    expect(store.importLegacy({ version: 1 }, () => "location-1")).toEqual({ imported: 0, skipped: 0 })
  })
})

describe("previous pair for a new session", () => {
  test("the last saved settings are kept per location and survive a reload", async () => {
    const storage = memory()
    const store = await DiscussionStore.open(storage, { location: "L" })
    expect(store.lastSettings()).toBeNull()
    store.setSettings("L", "ses_1", settings({ rounds: 1 }))
    store.setSettings("L", "ses_2", settings({ rounds: 3, maxOutputTokens: 1000 }))
    expect(store.lastSettings()).toMatchObject({ rounds: 3, maxOutputTokens: 1000 })
    // Offering is not applying: a new session still has no settings.
    expect(store.session("L", "ses_new").settings).toBeNull()
    await store.flush()
    const reopened = await DiscussionStore.open(storage, { location: "L" })
    expect(reopened.lastSettings()).toMatchObject({ rounds: 3 })
    const other = await DiscussionStore.open(storage, { location: "M" })
    expect(other.lastSettings()).toBeNull()
  })

  test("state from before `last` existed falls back to the newest run's settings", async () => {
    const storage = memory()
    const old = await DiscussionStore.open(storage, { location: "L" })
    old.setSettings("L", "ses_1", settings({ rounds: 2 }))
    old.startRun("L", "ses_1", "topic")
    await old.flush()
    const key = [...storage.raw.keys()].find((name) => name.startsWith("discuss/state@"))!
    const raw = storage.raw.get(key) as Record<string, unknown>
    delete raw.last
    const reopened = await DiscussionStore.open(storage, { location: "L" })
    expect(reopened.lastSettings()).toMatchObject({ rounds: 2 })
  })

  test("a malformed `last` is dropped instead of blocking the load", () => {
    const state = parseState({ version: 2, revision: 1, sessions: {}, last: { rounds: 99 } })
    expect(state.last).toBeUndefined()
  })
})

describe("request accounting", () => {
  test("requests are summed per run and survive a reload", async () => {
    const storage = memory()
    const store = await DiscussionStore.open(storage, { location: "L" })
    store.setSettings("L", "ses", settings())
    const run = store.startRun("L", "ses", "topic")
    store.addRequests("L", "ses", run.runID, 1)
    store.addRequests("L", "ses", run.runID, 3)
    store.addRequests("L", "ses", run.runID, 0)
    store.setUsage("L", "ses", run.runID, { output: 10 })
    expect(store.run("L", "ses", run.runID)?.usage).toEqual({ requests: 4, output: 10 })
    await store.flush()
    const reopened = await DiscussionStore.open(storage, { location: "L" })
    expect(reopened.run("L", "ses", run.runID)?.usage?.requests).toBe(4)
  })
})

describe("per-location state", () => {
  const HOME = "C:\\Users\\someone"
  const PROJECT = "D:\\Work\\project"
  const OTHER = "D:\\Work\\other"

  test("two locations sharing plugin storage never overwrite each other", async () => {
    const storage = memory()
    const project = await DiscussionStore.open(storage, { location: PROJECT })
    const other = await DiscussionStore.open(storage, { location: OTHER })
    project.setSettings(PROJECT, "ses_p", settings({ rounds: 1 }))
    other.setSettings(OTHER, "ses_o", settings({ rounds: 3 }))
    await project.flush()
    await other.flush()

    const reopenedProject = await DiscussionStore.open(storage, { location: PROJECT })
    const reopenedOther = await DiscussionStore.open(storage, { location: OTHER })
    expect(reopenedProject.session(PROJECT, "ses_p").settings?.rounds).toBe(1)
    expect(reopenedOther.session(OTHER, "ses_o").settings?.rounds).toBe(3)
    expect(reopenedProject.session(PROJECT, "ses_o").settings).toBeNull()
    expect(storage.raw.has("discuss/state")).toBe(false)
  })

  test("the same directory spelled with / or \\ maps to the same state", async () => {
    const storage = memory()
    const first = await DiscussionStore.open(storage, { location: "D:\\Work\\project" })
    first.setSettings("D:\\Work\\project", "ses_p", settings())
    await first.flush()
    const second = await DiscussionStore.open(storage, { location: "d:/Work/project/" })
    // The key is shared; records keep the location string they were written with.
    expect(second.session("D:\\Work\\project", "ses_p").settings).not.toBeNull()
  })

  test("adopts legacy records the host places here, including ones filed under the wrong location", async () => {
    const storage = memory()
    await storage.set("discuss/state", {
      version: 2,
      revision: 4,
      sessions: {
        [`${HOME}\u0000ses_p`]: { location: HOME, sessionID: "ses_p", settings: settings({ rounds: 1 }), runs: [] },
        [`${HOME}\u0000ses_home`]: { location: HOME, sessionID: "ses_home", settings: settings({ rounds: 5 }), runs: [] },
        [`${OTHER}\u0000ses_o`]: {
          location: OTHER,
          sessionID: "ses_o",
          settings: settings(),
          runs: [{ runID: "r1", topic: "t", settings: settings(), status: "running", createdAt: 1, messages: [], partial: null }],
        },
      },
    })
    const legacyBefore = structuredClone(storage.raw.get("discuss/state"))
    const where: Record<string, string> = { ses_p: PROJECT, ses_home: HOME, ses_o: PROJECT }
    const store = await DiscussionStore.open(storage, {
      location: PROJECT,
      belongs: async (sessionID) => where[sessionID] === PROJECT,
    })

    expect(store.migratedSessions).toBe(2)
    expect(store.session(PROJECT, "ses_p").settings?.rounds).toBe(1)
    expect(store.session(PROJECT, "ses_home").settings).toBeNull()
    // An adopted run that was still marked running is recovered like any other.
    expect(store.session(PROJECT, "ses_o").runs[0].status).toBe("cancelled")
    await store.flush()
    expect(storage.raw.get("discuss/state")).toEqual(legacyBefore)
  })

  test("adoption happens once: an existing per-location key is not merged again", async () => {
    const storage = memory()
    await storage.set("discuss/state", {
      version: 2,
      revision: 1,
      sessions: { [`${HOME}\u0000ses_p`]: { location: HOME, sessionID: "ses_p", settings: settings({ rounds: 1 }), runs: [] } },
    })
    let asked = 0
    const belongs = async () => {
      asked += 1
      return true
    }
    const first = await DiscussionStore.open(storage, { location: PROJECT, belongs })
    first.setSettings(PROJECT, "ses_p", settings({ rounds: 4 }))
    await first.flush()
    const second = await DiscussionStore.open(storage, { location: PROJECT, belongs })
    expect(asked).toBe(1)
    expect(second.migratedSessions).toBe(0)
    expect(second.session(PROJECT, "ses_p").settings?.rounds).toBe(4)
  })

  test("a failing ownership check skips the record instead of adopting it", async () => {
    const storage = memory()
    await storage.set("discuss/state", {
      version: 2,
      revision: 1,
      sessions: { [`${HOME}\u0000ses_p`]: { location: HOME, sessionID: "ses_p", settings: settings(), runs: [] } },
    })
    const store = await DiscussionStore.open(storage, {
      location: PROJECT,
      belongs: async () => {
        throw new Error("host unavailable")
      },
    })
    expect(store.migratedSessions).toBe(0)
    expect(store.session(PROJECT, "ses_p").settings).toBeNull()
  })
})
