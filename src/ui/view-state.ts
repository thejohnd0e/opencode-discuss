import type { Run, Settings } from "../discussion/types"

export type RunSummary = { runID: string; topic: string; status: string; createdAt: number }

export type View = {
  sessionID: string
  revision: number
  settings: Settings | null
  run?: Run
  runs: RunSummary[]
}

export type Snapshot = {
  revision: number
  settings: Settings | null
  run?: Run
  runs: RunSummary[]
}

export type Views = Record<string, View>

export function emptyView(sessionID: string): View {
  return { sessionID, revision: -1, settings: null, runs: [] }
}

export function viewOf(views: Views, sessionID: string): View {
  return views[sessionID] ?? emptyView(sessionID)
}

/** The next map of views after a snapshot, or null when the snapshot is older than what is shown. */
export function applySnapshot(views: Views, sessionID: string, snapshot: Snapshot): Views | null {
  if (snapshot.revision < viewOf(views, sessionID).revision) return null
  return {
    ...views,
    [sessionID]: {
      sessionID,
      revision: snapshot.revision,
      settings: snapshot.settings,
      run: snapshot.run,
      runs: snapshot.runs,
    },
  }
}

/** An update event that is not newer than the shown revision needs no refetch. */
export function isStaleEvent(view: View, revision: unknown): boolean {
  return typeof revision === "number" && revision < view.revision
}

export type RefresherOptions = {
  fetch: (sessionID: string) => Promise<Snapshot>
  get: () => Views
  set: (views: Views) => void
  isDisposed: () => boolean
  onError?: (sessionID: string, error: unknown) => void
  delayMs?: number
  setTimer?: (callback: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

/**
 * Fetches snapshots and applies them in revision order. `schedule` coalesces a
 * burst of update events into one fetch; `refresh` drops a response that
 * arrives after a newer one.
 */
export function createRefresher(options: RefresherOptions) {
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms))
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const pending = new Map<string, unknown>()

  const refresh = async (sessionID: string) => {
    try {
      const snapshot = await options.fetch(sessionID)
      if (options.isDisposed()) return
      const next = applySnapshot(options.get(), sessionID, snapshot)
      if (next) options.set(next)
    } catch (error) {
      options.onError?.(sessionID, error)
    }
  }

  const schedule = (sessionID: string) => {
    if (pending.has(sessionID)) return
    pending.set(
      sessionID,
      setTimer(() => {
        pending.delete(sessionID)
        void refresh(sessionID)
      }, options.delayMs ?? 200),
    )
  }

  /** Handle an `updated` event; returns whether a refetch was scheduled. */
  const onUpdated = (sessionID: string | undefined, revision: unknown): boolean => {
    if (options.isDisposed() || !sessionID) return false
    if (isStaleEvent(viewOf(options.get(), sessionID), revision)) return false
    schedule(sessionID)
    return true
  }

  const cancel = () => {
    for (const handle of pending.values()) clearTimer(handle)
    pending.clear()
  }

  return { refresh, schedule, onUpdated, cancel, pending: () => pending.size }
}
