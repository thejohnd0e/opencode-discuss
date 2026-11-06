import { modelLabel, type Settings } from "./types"

export type CatalogModel = {
  providerID: string
  id: string
  enabled?: boolean
  type?: string
  limit?: { output?: number }
}

export type PreflightFailure = {
  error: "model_unavailable" | "invalid_settings"
  reason: string
  side?: "a" | "b"
  modelID?: string
}

/**
 * Check the saved pair against the host's model list before anything is
 * spent: each model must still exist, be enabled and chat-capable, and the
 * output cap must not exceed the model's advertised limit (when known).
 */
export function preflight(catalog: readonly CatalogModel[], settings: Settings): PreflightFailure | null {
  for (const side of ["a", "b"] as const) {
    const ref = settings[side]
    const label = modelLabel(ref)
    const found = catalog.find((entry) => entry.providerID === ref.providerID && entry.id === ref.modelID)
    if (!found) {
      return { error: "model_unavailable", side, modelID: ref.modelID, reason: `model ${side.toUpperCase()} (${label}) is no longer available; pick it again with /discuss-models` }
    }
    if (found.enabled === false || (found.type !== undefined && found.type !== "chat")) {
      return { error: "model_unavailable", side, modelID: ref.modelID, reason: `model ${side.toUpperCase()} (${label}) is disabled or not a chat model` }
    }
    const limit = found.limit?.output
    if (typeof limit === "number" && limit > 0 && settings.maxOutputTokens > limit) {
      return {
        error: "invalid_settings",
        reason: `output cap ${settings.maxOutputTokens} exceeds the ${limit}-token limit of model ${side.toUpperCase()} (${label}); lower it, e.g. /discuss-settings tokens=${limit}`,
      }
    }
  }
  return null
}
