import { describe, expect, test } from "bun:test"
import { applySettingsArgs, checkSettingsArgs } from "../../src/ui/settings"
import type { Settings } from "../../src/discussion/types"

const saved: Settings = {
  a: { providerID: "p", modelID: "a", variant: "low" },
  b: { providerID: "q", modelID: "b" },
  mode: "cooperative",
  rounds: 2,
  maxOutputTokens: 1200,
}

describe("/discuss-settings arguments", () => {
  test("changes rounds, tokens and mode and keeps the models", () => {
    const result = applySettingsArgs(["rounds=1", "tokens=300", "mode=Critical"], saved)
    expect(result).toEqual({
      ok: true,
      settings: { ...saved, rounds: 1, maxOutputTokens: 300, mode: "critical" },
      changed: ["rounds 1", "max output 300", "mode critical"],
    })
  })

  test("short aliases and ':' work", () => {
    const result = applySettingsArgs(["r:3", "t=500", "m=debate"], saved)
    expect(result.ok && result.settings).toMatchObject({ rounds: 3, maxOutputTokens: 500, mode: "debate" })
  })

  test("anything invalid refuses the whole change", () => {
    for (const args of [
      [],
      ["rounds"],
      ["rounds=0"],
      ["rounds=13"],
      ["rounds=1.5"],
      ["tokens=15"],
      ["tokens=32001"],
      ["mode=angry"],
      ["colour=red"],
      ["rounds=1", "r=2"],
      ["rounds=1", "tokens=abc"],
    ]) {
      expect(applySettingsArgs(args, saved).ok).toBe(false)
    }
  })

  test("the saved settings object is not mutated", () => {
    applySettingsArgs(["rounds=1"], saved)
    expect(saved.rounds).toBe(2)
  })
})

describe("checking arguments before a pair exists", () => {
  test("valid arguments pass, typos and bad values are reported", () => {
    expect(checkSettingsArgs(["rounds=2", "tokens=1000"])).toBeNull()
    expect(checkSettingsArgs(["mode=debate"])).toBeNull()
    expect(checkSettingsArgs(["rounds=0"])).toContain("rounds")
    expect(checkSettingsArgs(["colour=red"])).toContain("Unknown")
    expect(checkSettingsArgs(["tokens=abc"])).toContain("whole number")
  })
})
