import { callBound, CONCLUSIONS, MAX_OUTPUT_TOKENS, MAX_ROUNDS, MIN_OUTPUT_TOKENS, MODES, type Conclusion, type Mode, type Settings } from "../discussion/types"

export const SETTINGS_USAGE = `Usage: /discuss-settings rounds=1..${MAX_ROUNDS} tokens=${MIN_OUTPUT_TOKENS}..${MAX_OUTPUT_TOKENS} mode=${MODES.join("|")} conclusion=${CONCLUSIONS.join("|")} review=on|off`

const KEYS: Record<string, "rounds" | "maxOutputTokens" | "mode" | "conclusion" | "review"> = {
  review: "review",
  conclusion: "conclusion",
  summary: "conclusion",
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
    if (key === "review") {
      const raw = value.toLowerCase()
      const on = ["on", "yes", "true", "1"].includes(raw)
      const off = ["off", "no", "false", "0", "none"].includes(raw)
      if (!on && !off) return { ok: false, reason: "review must be on or off" }
      if (on) next.review = true
      else delete next.review
      changed.push(on ? "review on" : "review off")
      continue
    }
    if (key === "conclusion") {
      const raw = value.toLowerCase()
      const choice = (raw === "off" || raw === "no" ? "none" : raw) as Conclusion
      if (!CONCLUSIONS.includes(choice)) return { ok: false, reason: `conclusion must be one of ${CONCLUSIONS.join(", ")}` }
      if (choice === "none") {
        delete next.conclusion
        delete next.review
      } else next.conclusion = choice
      changed.push(choice === "none" ? "no conclusion" : `conclusion by ${choice.toUpperCase()}`)
      continue
    }
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
  if (next.review && next.conclusion !== "a" && next.conclusion !== "b") {
    return { ok: false, reason: "review needs a conclusion: add conclusion=a or conclusion=b" }
  }
  return { ok: true, settings: next, changed }
}

export function conclusionText(settings: Settings): string {
  if (settings.conclusion !== "a" && settings.conclusion !== "b") return "no conclusion"
  const reviewer = settings.conclusion === "a" ? "B" : "A"
  return `conclusion by ${settings.conclusion.toUpperCase()}${settings.review ? `, reviewed by ${reviewer}` : ""}`
}

export function describeSettings(settings: Settings): string {
  const bound = callBound(settings)
  return `Mode: ${settings.mode} · rounds: ${settings.rounds} · max output: ${settings.maxOutputTokens} · ${conclusionText(settings)} · ceiling: ${bound.participantCalls} calls, ${bound.worstCaseOutputTokens} output tokens`
}

const PROBE: Settings = {
  a: { providerID: "probe", modelID: "a" },
  b: { providerID: "probe", modelID: "b" },
  mode: "cooperative",
  rounds: 1,
  maxOutputTokens: MIN_OUTPUT_TOKENS,
}

/** Validates `key=value` arguments without saved settings; returns the reason, or null when they are valid. */
export function checkSettingsArgs(args: string[]): string | null {
  const result = applySettingsArgs(args, PROBE)
  return result.ok ? null : result.reason
}

/**
 * Debate replies carry quotes, answers and a claims block, and reasoning
 * models spend part of the cap before any text. At 1500 tokens one side failed
 * twice in a 3-round debate (live 2026-11-07), so warn below this.
 */
export const DEBATE_MIN_TOKENS = 3000

export function debateTokenWarning(settings: Settings): string | null {
  if (settings.mode !== "debate" || settings.maxOutputTokens >= DEBATE_MIN_TOKENS) return null
  return `Debate replies are long and reasoning models may use up ${settings.maxOutputTokens} tokens before writing anything; ${DEBATE_MIN_TOKENS}+ is safer (/discuss-settings tokens=${DEBATE_MIN_TOKENS}).`
}
