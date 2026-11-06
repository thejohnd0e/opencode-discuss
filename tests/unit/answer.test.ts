import { describe, expect, test } from "bun:test"
import { answerNote, validAnswerCheck } from "../../src/discussion/answer"
import { buildHandoff } from "../../src/discussion/handoff"
import { parseState } from "../../src/discussion/store"
import type { Run, Settings } from "../../src/discussion/types"

const settings: Settings = {
  a: { providerID: "p", modelID: "left" },
  b: { providerID: "p", modelID: "right" },
  mode: "debate",
  rounds: 1,
  maxOutputTokens: 500,
}

describe("answer note", () => {
  test("unchecked replies have no note", () => {
    expect(answerNote(undefined)).toBeNull()
  })

  test("no quote or no real quote is a warning", () => {
    expect(answerNote({ quoted: 0, matched: 0 })).toEqual({ text: "Did not quote the opponent: may not answer their arguments", warn: true })
    expect(answerNote({ quoted: 2, matched: 0 })?.warn).toBe(true)
    expect(answerNote({ quoted: 2, matched: 0 })?.text).toContain("not found")
  })

  test("partly real quotes are a warning that says how many", () => {
    expect(answerNote({ quoted: 2, matched: 1 })).toEqual({
      text: "Answers 1 point of the opponent; 1 quote not found in their reply",
      warn: true,
    })
  })

  test("quoting back one's own words is a warning of its own", () => {
    expect(answerNote({ quoted: 2, matched: 0, recycled: 2 })).toEqual({
      text: "Quotes its own words back, not the opponent's: may not answer their arguments",
      warn: true,
    })
    expect(answerNote({ quoted: 2, matched: 1, recycled: 1 })).toEqual({
      text: "Answers 1 point of the opponent; 1 quote is its own words back, not the opponent's",
      warn: true,
    })
    expect(validAnswerCheck({ quoted: 2, matched: 1, recycled: 1 })).toBe(true)
    expect(validAnswerCheck({ quoted: 2, matched: 2, recycled: 1 })).toBe(false)
  })

  test("a counted quote that largely repeats one's own words is a warning but still counts", () => {
    expect(answerNote({ quoted: 2, matched: 2, mixed: 1 })).toEqual({
      text: "Answers 2 points of the opponent; 1 quote largely repeats its own earlier words",
      warn: true,
    })
    expect(validAnswerCheck({ quoted: 2, matched: 2, mixed: 1 })).toBe(true)
    expect(validAnswerCheck({ quoted: 2, matched: 1, mixed: 2 })).toBe(false)
  })

  test("all quotes real is a quiet confirmation", () => {
    expect(answerNote({ quoted: 2, matched: 2 })).toEqual({ text: "Answers 2 points of the opponent", warn: false })
  })

  test("validation", () => {
    expect(validAnswerCheck({ quoted: 1, matched: 1 })).toBe(true)
    expect(validAnswerCheck({ quoted: 1, matched: 2 })).toBe(false)
    expect(validAnswerCheck({ quoted: -1, matched: 0 })).toBe(false)
    expect(validAnswerCheck({ quoted: 1.5, matched: 0 })).toBe(false)
    expect(validAnswerCheck(null)).toBe(false)
  })
})

describe("answer check in stored state", () => {
  const state = (check: unknown) => ({
    version: 2,
    revision: 1,
    sessions: {
      "loc\u0000ses": {
        location: "loc",
        sessionID: "ses",
        settings,
        runs: [
          {
            runID: "r",
            topic: "t",
            settings,
            status: "completed",
            createdAt: 1,
            messages: [{ speaker: "b", label: "p/right", round: 1, text: "x", check }],
            partial: null,
          },
        ],
      },
    },
  })

  test("a valid check is kept, an invalid one is rejected", () => {
    const parsed = parseState(state({ quoted: 2, matched: 1 }))
    const record = Object.values(parsed.sessions)[0]
    expect(record.runs[0].messages[0].check).toEqual({ quoted: 2, matched: 1 })
    expect(() => parseState(state({ quoted: 1, matched: 3 }))).toThrow()
  })
})

describe("answer check in the handoff", () => {
  test("a reply that did not answer the opponent is flagged in the statements", () => {
    const run: Run = {
      runID: "r",
      topic: "t",
      settings,
      status: "completed",
      createdAt: 1,
      messages: [
        { speaker: "a", label: "p/left", round: 1, text: "Opening." },
        { speaker: "b", label: "p/right", round: 1, text: "My own view.", check: { quoted: 0, matched: 0 } },
      ],
      partial: null,
    }
    const packet = buildHandoff(run)
    expect(packet).toContain("- [p/right, round 1] (did not quote the opponent: may not answer their arguments) My own view.")
    expect(packet).toContain("- [p/left, round 1] Opening.")
  })

  test("a reply that answered is not flagged", () => {
    const run: Run = {
      runID: "r",
      topic: "t",
      settings,
      status: "completed",
      createdAt: 1,
      messages: [{ speaker: "b", label: "p/right", round: 1, text: "Answer.", check: { quoted: 1, matched: 1 } }],
      partial: null,
    }
    expect(buildHandoff(run)).toContain("- [p/right, round 1] Answer.")
  })
})
