import type { ModelRef, Settings } from "../discussion/types"

export type CatalogModel = {
  providerID: string
  modelID: string
  name: string
  variants: string[]
  available: boolean
}

export type ModelOption = {
  title: string
  value: string
  description: string
  category: string
  disabled: boolean
}

export function toOptions(catalog: CatalogModel[]): ModelOption[] {
  const options: ModelOption[] = []
  for (const model of catalog) {
    const base = {
      description: `${model.providerID} · ${model.modelID}`,
      category: model.providerID,
      disabled: !model.available,
    }
    if (model.variants.length === 0) {
      options.push({ ...base, title: model.name, value: `${model.providerID}/${model.modelID}` })
      continue
    }
    for (const variant of model.variants) {
      options.push({
        ...base,
        title: `${model.name} · ${variant}`,
        value: `${model.providerID}/${model.modelID}#${variant}`,
      })
    }
  }
  return options
}

export function parseChoice(value: string): ModelRef {
  const [path, variant] = value.split("#")
  const index = path.indexOf("/")
  const providerID = index === -1 ? path : path.slice(0, index)
  const modelID = index === -1 ? "" : path.slice(index + 1)
  return { providerID, modelID, ...(variant ? { variant } : {}) }
}

export function mergeSettings(current: Settings, a: ModelRef, b: ModelRef): Settings {
  return { ...current, a, b }
}

export type Resolved =
  | { ok: true; value: string }
  | { ok: false; reason: "not_found" | "unavailable" | "ambiguous"; matches: ModelOption[] }

/** Splits slash-command arguments into model queries. */
export function splitArgs(input: unknown): string[] {
  return typeof input === "string" ? input.trim().split(/\s+/).filter(Boolean) : []
}

/**
 * Resolves a typed model reference against the catalog options.
 *
 * Accepts `provider/model`, `provider:model`, either with `#variant`, or a
 * fragment of the id or display name. An exact id wins. A model with variants
 * typed without one, or a fragment matching several models, is ambiguous and
 * returns the candidates so the caller can ask. Disabled models never resolve.
 */
export function resolveChoice(query: string, options: ModelOption[]): Resolved {
  const raw = query.trim().toLowerCase()
  if (!raw) return { ok: false, reason: "not_found", matches: [] }
  const normalized = raw.includes("/") ? raw : raw.replace(":", "/")

  const exact = options.filter((option) => option.value.toLowerCase() === normalized)
  if (exact.length === 1) {
    return exact[0].disabled ? { ok: false, reason: "unavailable", matches: exact } : { ok: true, value: exact[0].value }
  }

  const variants = options.filter((option) => option.value.toLowerCase().startsWith(`${normalized}#`))
  const candidates = variants.length
    ? variants
    : options.filter(
        (option) => option.value.toLowerCase().includes(raw) || option.value.toLowerCase().includes(normalized) || option.title.toLowerCase().includes(raw),
      )

  const enabled = candidates.filter((option) => !option.disabled)
  if (enabled.length === 1) return { ok: true, value: enabled[0].value }
  if (enabled.length > 1) return { ok: false, reason: "ambiguous", matches: enabled }
  return { ok: false, reason: candidates.length ? "unavailable" : "not_found", matches: candidates }
}

export function choiceOf(model: ModelRef): string {
  return `${model.providerID}/${model.modelID}${model.variant ? `#${model.variant}` : ""}`
}
