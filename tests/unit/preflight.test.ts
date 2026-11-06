import { describe, expect, test } from "bun:test"
import { preflight, type CatalogModel } from "../../src/discussion/preflight"
import type { Settings } from "../../src/discussion/types"

const settings: Settings = {
  a: { providerID: "p", modelID: "left" },
  b: { providerID: "p", modelID: "right" },
  mode: "cooperative",
  rounds: 1,
  maxOutputTokens: 1000,
}
const catalog = (extra: Partial<CatalogModel> = {}): CatalogModel[] => [
  { providerID: "p", id: "left", enabled: true, type: "chat", limit: { output: 4000 } },
  { providerID: "p", id: "right", enabled: true, type: "chat", limit: { output: 4000 }, ...extra },
]

describe("preflight", () => {
  test("a healthy pair passes", () => {
    expect(preflight(catalog(), settings)).toBeNull()
  })

  test("a missing model is reported with its side", () => {
    const result = preflight(catalog().slice(1), settings)
    expect(result?.error).toBe("model_unavailable")
    expect(result?.side).toBe("a")
    expect(result?.modelID).toBe("left")
  })

  test("a disabled or non-chat model is unavailable", () => {
    expect(preflight(catalog({ enabled: false }), settings)?.side).toBe("b")
    expect(preflight(catalog({ type: "embedding" }), settings)?.error).toBe("model_unavailable")
  })

  test("a cap above the model limit is an invalid setting that names the limit", () => {
    const result = preflight(catalog({ limit: { output: 500 } }), settings)
    expect(result?.error).toBe("invalid_settings")
    expect(result?.reason).toContain("500")
  })

  test("an unknown limit does not block", () => {
    expect(preflight(catalog({ limit: undefined }), settings)).toBeNull()
    expect(preflight(catalog({ limit: { output: 0 } }), settings)).toBeNull()
  })
})
