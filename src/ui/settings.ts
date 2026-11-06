import { MAX_OUTPUT_TOKENS, MAX_ROUNDS, MIN_OUTPUT_TOKENS, MODES, type Mode, type Settings } from "../discussion/types"

export const SETTINGS_USAGE = `Usage: /discuss-settings rounds=1..${MAX_ROUNDS} tokens=${MIN_OUTPUT_TOKENS}..${MAX_OUTPUT_TOKENS} mode=${MODES.join("|")}`

const KEYS: Record<string, "rounds" | "maxOutputTokens" | "mode"> = {
  rounds: "rounds",
  round: "rounds",
  r: "rounds",
  tokens: "maxOutputTokens",
  max: "maxOutputTokens",
  output: "maxOutputTokens",
  maxoutputtokens: "maxOutputTokens",
  t: "maxOutputTokens",
  mode: "mode",
  m: "mode",
}

export type SettingsChange = { ok: true; settings: Settings; changed: string[] } | { ok: false; reason: string }

/**
 * Applies `key=value` arguments to the saved settings. Models are never
 * touched here; unknown keys, bad values and repeated keys are refused as a
 * whole so a typo never half-applies.
 */
export function applySettingsArgs(args: string[], current: Settings): SettingsChange {
  if (args.length === 0) return { ok: false, reason: SETTINGS_USAGE }
  const next: Settings = { ...current }
  const seen = new Set<string>()
  const changed: string[] = []
  for (const arg of args) {
    const match = /^([a-z]+)\s*[=:]\s*(.+)$/i.exec(arg)
    if (!match) return { ok: false, reason: `“${arg}” is not key=value. ${SETTINGS_USAGE}` }
    const key = KEYS[match[1].toLowerCase()]
    if (!key) return { ok: false, reason: `Unknown setting “${match[1]}”. ${SETTINGS_USAGE}` }
    if (seen.has(key)) return { ok: false, reason: `“${match[1]}” is given twice` }
    seen.add(key)
    const value = match[2].trim()
    if (key === "mode") {
      const mode = value.toLowerCase() as Mode
      if (!MODES.includes(mode)) return { ok: false, reason: `mode must be one of ${MODES.join(", ")}` }
      next.mode = mode
      changed.push(`mode ${mode}`)
      continue
    }
    if (!/^\d+$/.test(value)) return { ok: false, reason: `${match[1]} must be a whole number` }
    const number = Number(value)
    if (key === "rounds") {
      if (number < 1 || number > MAX_ROUNDS) return { ok: false, reason: `rounds must be between 1 and ${MAX_ROUNDS}` }
      next.rounds = number
      changed.push(`rounds ${number}`)
    } else {
      if (number < MIN_OUTPUT_TOKENS || number > MAX_OUTPUT_TOKENS) {
        return { ok: false, reason: `tokens must be between ${MIN_OUTPUT_TOKENS} and ${MAX_OUTPUT_TOKENS}` }
      }
      next.maxOutputTokens = number
      changed.push(`max output ${number}`)
    }
  }
  return { ok: true, settings: next, changed }
}

export function describeSettings(settings: Settings): string {
  return `Mode: ${settings.mode} · rounds: ${settings.rounds} · max output: ${settings.maxOutputTokens} · ceiling: ${settings.rounds * 2} calls, ${settings.rounds * 2 * settings.maxOutputTokens} output tokens`
}
