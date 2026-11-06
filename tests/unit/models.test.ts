import { describe, expect, test } from "bun:test"
import { mergeSettings, parseChoice, resolveChoice, splitArgs, toOptions, type CatalogModel } from "../../src/ui/models"
import type { Settings } from "../../src/discussion/types"

const catalog: CatalogModel[] = [
  {
    providerID: "provider-a",
    modelID: "shared",
    name: "Shared Name",
    variants: [],
    available: true,
  },
  {
    providerID: "provider-b",
    modelID: "shared",
    name: "Shared Name",
    variants: ["high", "low"],
    available: true,
  },
  {
    providerID: "provider-c",
    modelID: "offline",
    name: "Offline",
    variants: [],
    available: false,
  },
]

const base: Settings = {
  a: { providerID: "provider-a", modelID: "shared" },
  b: { providerID: "provider-b", modelID: "shared" },
  mode: "cooperative",
  rounds: 2,
  maxOutputTokens: 1200,
}

describe("model selection", () => {
  test("duplicate display names stay distinct through provider and variant", () => {
    const values = toOptions(catalog).map((option) => option.value)
    expect(new Set(values).size).toBe(values.length)
    expect(values).toContain("provider-a/shared")
    expect(values).toContain("provider-b/shared#high")
  })

  test("an unavailable model is offered but disabled", () => {
    const offline = toOptions(catalog).find((option) => option.value === "provider-c/offline")
    expect(offline?.disabled).toBe(true)
  })

  test("a choice round-trips to a model reference", () => {
    expect(parseChoice("provider-b/shared#high")).toEqual({
      providerID: "provider-b",
      modelID: "shared",
      variant: "high",
    })
  })

  test("the same model may sit on both sides", () => {
    const merged = mergeSettings(base, parseChoice("provider-a/shared"), parseChoice("provider-a/shared"))
    expect(merged.a).toEqual(merged.b)
  })

  test("changing models keeps the mode, rounds and limit", () => {
    const merged = mergeSettings(
      { ...base, mode: "critical", rounds: 4, maxOutputTokens: 2000 },
      parseChoice("provider-b/shared#low"),
      parseChoice("provider-a/shared"),
    )
    expect(merged).toMatchObject({ mode: "critical", rounds: 4, maxOutputTokens: 2000 })
    expect(merged.a).toEqual({ providerID: "provider-b", modelID: "shared", variant: "low" })
  })

  test("a saved model missing from the catalog is reported, not silently replaced", () => {
    const options = toOptions(catalog)
    const saved = parseChoice("provider-z/removed")
    expect(options.some((option) => option.value === "provider-z/removed")).toBe(false)
    const merged = mergeSettings(base, saved, base.b)
    expect(merged.a).toEqual(saved)
  })
})

describe("typed model selection", () => {
  const options = toOptions(catalog)

  test("arguments split on any whitespace; non-strings give none", () => {
    expect(splitArgs("  provider-a/shared \t provider-b/shared#low ")).toEqual(["provider-a/shared", "provider-b/shared#low"])
    expect(splitArgs("")).toEqual([])
    expect(splitArgs(undefined)).toEqual([])
  })

  test("an exact id resolves, case-insensitively and with ':' as separator", () => {
    expect(resolveChoice("provider-a/shared", options)).toEqual({ ok: true, value: "provider-a/shared" })
    expect(resolveChoice("Provider-A:Shared", options)).toEqual({ ok: true, value: "provider-a/shared" })
    expect(resolveChoice("provider-b/shared#high", options)).toEqual({ ok: true, value: "provider-b/shared#high" })
  })

  test("a model with variants typed without one is ambiguous between its variants only", () => {
    const result = resolveChoice("provider-b/shared", options)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe("ambiguous")
      expect(result.matches.map((option) => option.value)).toEqual(["provider-b/shared#high", "provider-b/shared#low"])
    }
  })

  test("a fragment that matches one enabled model resolves to it", () => {
    expect(resolveChoice("provider-a", options)).toEqual({ ok: true, value: "provider-a/shared" })
    expect(resolveChoice("low", options)).toEqual({ ok: true, value: "provider-b/shared#low" })
  })

  test("a display name shared by several models is ambiguous, not a silent pick", () => {
    const result = resolveChoice("shared name", options)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("ambiguous")
  })

  test("a disabled model is reported as unavailable, an unknown one as not found", () => {
    expect(resolveChoice("provider-c/offline", options)).toMatchObject({ ok: false, reason: "unavailable" })
    expect(resolveChoice("offline", options)).toMatchObject({ ok: false, reason: "unavailable" })
    expect(resolveChoice("nonexistent", options)).toMatchObject({ ok: false, reason: "not_found", matches: [] })
    expect(resolveChoice("   ", options)).toMatchObject({ ok: false, reason: "not_found" })
  })
})
