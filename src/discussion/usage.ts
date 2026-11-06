import type { Usage } from "./types"

/** Token and cost figures reported by the host for one model step. */
export type StepUsage = { input?: number; output?: number; reasoning?: number; cost?: number }

const finite = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined)

/** Reads `{ cost, tokens: { input, output, reasoning } }` from a step event; undefined when it has none. */
export function stepUsage(data: unknown): StepUsage | undefined {
  if (!data || typeof data !== "object") return undefined
  const record = data as { cost?: unknown; tokens?: { input?: unknown; output?: unknown; reasoning?: unknown } }
  const usage: StepUsage = {}
  const input = finite(record.tokens?.input)
  const output = finite(record.tokens?.output)
  const reasoning = finite(record.tokens?.reasoning)
  const cost = finite(record.cost)
  if (input !== undefined) usage.input = input
  if (output !== undefined) usage.output = output
  if (reasoning !== undefined) usage.reasoning = reasoning
  if (cost !== undefined) usage.cost = cost
  return Object.keys(usage).length ? usage : undefined
}

/** Sums the token and cost fields; `requests` is left to its own counter. */
export function addUsage<T extends StepUsage>(base: T | undefined, more: StepUsage): T {
  const result = { ...(base ?? {}) } as T
  for (const key of ["input", "output", "reasoning", "cost"] as const) {
    const value = more[key]
    if (value === undefined) continue
    result[key] = ((result[key] ?? 0) + value) as T[typeof key]
  }
  return result
}

const count = (value: number) => Math.round(value).toLocaleString("en-US")

/**
 * One line for the panel and the handoff. "unknown" when the host reported
 * nothing; cost is shown only when the host priced the model (above zero).
 */
export function describeUsage(usage: Usage | undefined): string {
  const has = usage && (usage.input !== undefined || usage.output !== undefined || usage.cost !== undefined)
  if (!usage || !has) return "unknown"
  const parts: string[] = []
  if (usage.input !== undefined) parts.push(`in ${count(usage.input)}`)
  if (usage.output !== undefined) {
    parts.push(`out ${count(usage.output)}${usage.reasoning ? ` (reasoning ${count(usage.reasoning)})` : ""}`)
  }
  parts.push(usage.cost && usage.cost > 0 ? `$${usage.cost.toFixed(4)}` : "cost unknown")
  return parts.join(" · ")
}

export const ORCHESTRATOR_NOTE = "The orchestrating chat's own model calls are extra and not counted here."
