import { createHash } from "node:crypto"

/**
 * OpenCode reports the same directory as `D:\x\y` from one API and `D:/x/y`
 * from another. Compare on a normalized form: forward slashes, no trailing
 * slash, and lower case on Windows-style paths (they are case-insensitive).
 */
export function normalizeLocation(directory: string): string {
  let value = directory.trim().replace(/\\/g, "/")
  if (value.length > 1) value = value.replace(/\/+$/, "")
  return /^[a-z]:/i.test(value) ? value.toLowerCase() : value
}

export function sameLocation(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  return normalizeLocation(a) === normalizeLocation(b)
}

/** The legacy single key that every plugin instance overwrote as a whole. */
export const LEGACY_STATE_KEY = "discuss/state"

/**
 * One storage key per location. OpenCode runs one plugin instance per
 * location, all sharing plugin storage; a key each means no instance can
 * overwrite another location's state.
 */
export function stateKey(location: string): string {
  const digest = createHash("sha256").update(normalizeLocation(location)).digest("hex").slice(0, 16)
  return `discuss/state@${digest}`
}

/** Extracts a session's directory from the SessionInfo shapes 2.2.5 returns. */
export function sessionDirectory(info: unknown): string | undefined {
  const location = (info as { location?: { directory?: unknown } } | undefined)?.location
  return typeof location?.directory === "string" ? location.directory : undefined
}
