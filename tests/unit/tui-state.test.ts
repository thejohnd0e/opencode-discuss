import { describe, expect, test } from "bun:test"
import { applySnapshot, createRefresher, emptyView, isStaleEvent, viewOf, type Snapshot, type Views } from "../../src/ui/view-state"

const snap = (revision: number, extra: Partial<Snapshot> = {}): Snapshot => ({ revision, settings: null, runs: [], ...extra })

function harness(fetch: (sessionID: string) => Promise<Snapshot>) {
  let views: Views = {}
  let disposed = false
  const timers: Array<{ callback: () => void; ms: number; live: boolean }> = []
  const errors: unknown[] = []
  const refresher = createRefresher({
    fetch,
    get: () => views,
    set: (next) => {
      views = next
    },
    isDisposed: () => disposed,
    onError: (_id, error) => errors.push(error),
    setTimer: (callback, ms) => {
      const timer = { callback, ms, live: true }
      timers.push(timer)
      return timer
    },
    clearTimer: (handle) => {
      ;(handle as { live: boolean }).live = false
    },
  })
  const fire = () => timers.filter((timer) => timer.live).forEach((timer) => ((timer.live = false), timer.callback()))
  return { refresher, fire, errors, views: () => views, dispose: () => (disposed = true), timers }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("view state", () => {
  test("an unseen session starts at revision -1, so any first snapshot is accepted", () => {
    expect(emptyView("s").revision).toBe(-1)
    expect(applySnapshot({}, "s", snap(0))?.s.revision).toBe(0)
  })

  test("an older snapshot is dropped, an equal or newer one is applied", () => {
    const views = applySnapshot({}, "s", snap(5))!
    expect(applySnapshot(views, "s", snap(4))).toBeNull()
    expect(applySnapshot(views, "s", snap(5))).not.toBeNull()
    expect(applySnapshot(views, "s", snap(9))?.s.revision).toBe(9)
  })

  test("sessions are independent", () => {
    let views = applySnapshot({}, "a", snap(7))!
    views = applySnapshot(views, "b", snap(1))!
    expect(viewOf(views, "a").revision).toBe(7)
    expect(viewOf(views, "b").revision).toBe(1)
    expect(applySnapshot(views, "b", snap(2))?.a.revision).toBe(7)
  })

  test("isStaleEvent: only an older numeric revision is stale", () => {
    const view = { ...emptyView("s"), revision: 5 }
    expect(isStaleEvent(view, 4)).toBe(true)
    expect(isStaleEvent(view, 5)).toBe(false)
    expect(isStaleEvent(view, 9)).toBe(false)
    expect(isStaleEvent(view, undefined)).toBe(false)
  })
})

describe("refresher", () => {
  test("a burst of events becomes one fetch", async () => {
    let calls = 0
    const h = harness(async () => (calls++, snap(3)))
    h.refresher.onUpdated("s", 1)
    h.refresher.onUpdated("s", 2)
    h.refresher.onUpdated("s", 3)
    expect(h.timers.length).toBe(1)
    h.fire()
    await flush()
    expect(calls).toBe(1)
    expect(viewOf(h.views(), "s").revision).toBe(3)
  })

  test("an event whose revision is old does not schedule a fetch", () => {
    const h = harness(async () => snap(10))
    h.refresher.refresh("s")
    return flush().then(() => {
      expect(h.refresher.onUpdated("s", 3)).toBe(false)
      expect(h.refresher.onUpdated("s", 11)).toBe(true)
      expect(h.refresher.onUpdated("s", undefined)).toBe(true)
    })
  })

  test("a revision gap (event far ahead of the view) still refetches", async () => {
    const h = harness(async () => snap(2))
    await h.refresher.refresh("s")
    expect(h.refresher.onUpdated("s", 40)).toBe(true)
  })

  test("an event without a session or after disposal is ignored", () => {
    const h = harness(async () => snap(1))
    expect(h.refresher.onUpdated(undefined, 1)).toBe(false)
    h.dispose()
    expect(h.refresher.onUpdated("s", 1)).toBe(false)
  })

  test("a slow older response arriving after a newer one does not roll the view back", async () => {
    const resolvers: Array<(value: Snapshot) => void> = []
    const h = harness(() => new Promise<Snapshot>((resolve) => resolvers.push(resolve)))
    const first = h.refresher.refresh("s")
    const second = h.refresher.refresh("s")
    resolvers[1](snap(8))
    await second
    resolvers[0](snap(3))
    await first
    expect(viewOf(h.views(), "s").revision).toBe(8)
  })

  test("a response arriving after disposal is not applied", async () => {
    let resolve!: (value: Snapshot) => void
    const h = harness(() => new Promise<Snapshot>((r) => (resolve = r)))
    const pending = h.refresher.refresh("s")
    h.dispose()
    resolve(snap(4))
    await pending
    expect(h.views()).toEqual({})
  })

  test("a failed fetch is reported and keeps the previous view", async () => {
    let fail = false
    const h = harness(async () => {
      if (fail) throw new Error("boom")
      return snap(2)
    })
    await h.refresher.refresh("s")
    fail = true
    await h.refresher.refresh("s")
    expect(h.errors.length).toBe(1)
    expect(viewOf(h.views(), "s").revision).toBe(2)
  })

  test("cancel clears scheduled fetches", () => {
    const h = harness(async () => snap(1))
    h.refresher.schedule("a")
    h.refresher.schedule("b")
    expect(h.refresher.pending()).toBe(2)
    h.refresher.cancel()
    expect(h.refresher.pending()).toBe(0)
    h.fire()
    expect(h.timers.every((timer) => !timer.live)).toBe(true)
  })

  test("after a fetch fires, the next event schedules again", async () => {
    const h = harness(async () => snap(1))
    h.refresher.schedule("s")
    h.fire()
    await flush()
    h.refresher.schedule("s")
    expect(h.timers.filter((timer) => timer.live).length).toBe(1)
  })
})
