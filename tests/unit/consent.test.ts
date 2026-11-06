import { describe, expect, test } from "bun:test"
import { DECLINED_MESSAGE, errorShape, explainRefusal, requireConsent, START_ACTION } from "../../src/discussion/consent"

describe("start consent", () => {
  test("an allowed start (no rule, or a saved allow) becomes a prompt", () => {
    const event = { action: START_ACTION, effect: "allow" as const }
    expect(requireConsent(event)).toBe(true)
    expect(event.effect).toBe("ask")
    expect(event).toHaveProperty("message")
  })

  test("a deny stays a deny and an ask stays an ask", () => {
    const denied = { action: START_ACTION, effect: "deny" as const }
    expect(requireConsent(denied)).toBe(false)
    expect(denied.effect).toBe("deny")
    const asked = { action: START_ACTION, effect: "ask" as const, message: "custom" }
    expect(requireConsent(asked)).toBe(false)
    expect(asked.message).toBe("custom")
  })

  test("other actions are untouched", () => {
    const event = { action: "edit", effect: "allow" as const }
    expect(requireConsent(event)).toBe(false)
    expect(event.effect).toBe("allow")
  })
})

describe("refusal message", () => {
  test("an empty host rejection gets a clear reason on the same object", () => {
    const error = new Error("")
    expect(explainRefusal(error)).toBe(error)
    expect(error.message).toBe(DECLINED_MESSAGE)
  })

  test("an empty `reason` field is filled too; an explained error is left alone", () => {
    const tagged = { _tag: "Tool.Error", reason: "", message: "" }
    explainRefusal(tagged)
    expect(tagged.reason).toBe(DECLINED_MESSAGE)
    expect(tagged.message).toBe(DECLINED_MESSAGE)
    const explained = new Error("denied by rule: discuss.start")
    explainRefusal(explained)
    expect(explained.message).toBe("denied by rule: discuss.start")
  })

  test("frozen errors and non-objects do not throw", () => {
    const frozen = Object.freeze({ message: "" })
    expect(() => explainRefusal(frozen)).not.toThrow()
    expect(explainRefusal("x")).toBe("x")
    expect(explainRefusal(undefined)).toBeUndefined()
  })

  test("the journal shape names the error and its keys without values", () => {
    expect(errorShape({ _tag: "Tool.Error", reason: "" })).toEqual({ name: "object", keys: ["_tag", "reason"] })
    expect(errorShape(new TypeError("x")).name).toBe("TypeError")
  })
})
