import { describe, expect, test } from "bun:test"
import { callBound, MAX_OUTPUT_TOKENS, MAX_ROUNDS, type Settings } from "../../src/discussion/types"
import { validateSettings } from "../../src/discussion/store"

const settings: Settings = {
  a: { providerID: "p", modelID: "a" },
  b: { providerID: "p", modelID: "b" },
  mode: "cooperative",
  rounds: 2,
  maxOutputTokens: 1200,
}

describe("spend limits", () => {
  test("reports participant calls and worst-case output tokens", () => {
    expect(callBound(settings)).toEqual({ participantCalls: 4, worstCaseOutputTokens: 4800 })
  })

  test("is explicitly only a participant-output bound", () => {
    const bound = callBound(settings)
    expect(Object.keys(bound)).toEqual(["participantCalls", "worstCaseOutputTokens"])
  })

  test("rejects fractional, negative and fractional-token limits", () => {
    expect(() => validateSettings({ ...settings, rounds: 1.5 })).toThrow()
    expect(() => validateSettings({ ...settings, maxOutputTokens: -5 })).toThrow()
    expect(() => validateSettings({ ...settings, maxOutputTokens: 10.5 })).toThrow()
  })

  test("rejects limits above the documented ceiling", () => {
    expect(() => validateSettings({ ...settings, rounds: MAX_ROUNDS + 1 })).toThrow()
    expect(() => validateSettings({ ...settings, maxOutputTokens: MAX_OUTPUT_TOKENS + 1 })).toThrow()
  })

  test("accepts the ceiling itself", () => {
    expect(validateSettings({ ...settings, rounds: MAX_ROUNDS, maxOutputTokens: MAX_OUTPUT_TOKENS })).toMatchObject({
      rounds: MAX_ROUNDS,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    })
  })
})
