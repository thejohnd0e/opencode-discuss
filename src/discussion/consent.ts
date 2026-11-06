/** Permission action checked before a tool-started discussion spends anything. */
export const START_ACTION = "discuss.start"

export type Evaluation = {
  readonly action: string
  effect: "allow" | "deny" | "ask"
  message?: string
}

/** What the orchestrator should report when the user rejects the prompt. */
export const DECLINED_MESSAGE =
  "The user declined to start the discussion. Nothing was started and no model was called. Do not retry unless the user asks again."

/**
 * The host rejects a refused prompt with an error whose message is empty, so
 * the orchestrator could only guess why the start failed. Fill in the reason
 * on the same error object (the host expects that error to be rethrown, not
 * replaced). Errors that already explain themselves are left alone.
 */
export function explainRefusal(error: unknown): unknown {
  if (!error || typeof error !== "object") return error
  const target = error as { message?: unknown; reason?: unknown }
  const empty = (value: unknown) => value === undefined || value === null || (typeof value === "string" && !value.trim())
  try {
    if (empty(target.message)) target.message = DECLINED_MESSAGE
  } catch {
    /* a read-only message stays as it is */
  }
  try {
    if ("reason" in target && empty(target.reason)) target.reason = DECLINED_MESSAGE
  } catch {
    /* a read-only reason stays as it is */
  }
  return error
}

/** Shape of an error for the journal: its name and own keys, no values. */
export function errorShape(error: unknown): { name: string; keys: string[] } {
  if (!error || typeof error !== "object") return { name: typeof error, keys: [] }
  return { name: (error as { name?: unknown }).name ? String((error as { name?: unknown }).name) : "object", keys: Object.keys(error) }
}

/**
 * Starting a discussion always needs the user's explicit approval: any outcome
 * other than "deny" becomes "ask", whatever the rules or a saved "allow" say.
 * Other actions are untouched. Returns whether the evaluation was changed.
 */
export function requireConsent(event: Evaluation): boolean {
  if (event.action !== START_ACTION || event.effect === "deny" || event.effect === "ask") return false
  event.effect = "ask"
  event.message = event.message ?? "Start a paid two-model discussion?"
  return true
}
