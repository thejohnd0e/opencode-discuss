import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

export type Log = (stage: string, details?: Record<string, unknown>) => void

export const LOG_MAX_BYTES = 1_000_000

/**
 * Where the TUI journal goes. On by default so problems can be diagnosed
 * after the fact without restarting OpenCode with special variables:
 * - unset          → `<state dir>/logs/tui.jsonl`
 * - `off`/`0`/`false` → disabled
 * - any other value → that file
 */
export function logPath(env: Record<string, string | undefined> = process.env): string | undefined {
  const value = env.DISCUSS_LOG?.trim()
  if (value && ["off", "0", "false", "no"].includes(value.toLowerCase())) return undefined
  if (value) return value
  const base = env.LOCALAPPDATA ?? env.XDG_STATE_HOME ?? tmpdir()
  return join(base, "opencode-discuss", "logs", "tui.jsonl")
}

/**
 * Appends one JSON line per event. Keeps at most two files of about
 * `maxBytes` each (`tui.jsonl` and `tui.jsonl.1`). Never throws: a journal
 * must not break the TUI.
 */
export function createLog(path: string | undefined, maxBytes = LOG_MAX_BYTES, now: () => number = Date.now): Log {
  if (!path) return () => {}
  let ready = false
  return (stage, details = {}) => {
    try {
      if (!ready) {
        mkdirSync(dirname(path), { recursive: true })
        ready = true
      }
      try {
        if (statSync(path).size >= maxBytes) {
          rmSync(`${path}.1`, { force: true })
          renameSync(path, `${path}.1`)
        }
      } catch {
        /* no file yet */
      }
      appendFileSync(path, JSON.stringify({ at: new Date(now()).toISOString(), stage, ...details }) + "\n")
    } catch {
      /* journal is best effort */
    }
  }
}

/** Describes a value for the journal without copying user text into it. */
export function shape(value: unknown): string {
  if (typeof value === "string") return value.trim() ? `text(${value.trim().length})` : "empty"
  if (value === undefined || value === null) return "none"
  return typeof value
}
