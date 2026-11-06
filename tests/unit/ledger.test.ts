import { describe, expect, test } from "bun:test"
import { ledgerOf, replyLedgerNote, statusText, validLedger } from "../../src/discussion/ledger"
import { buildHandoff } from "../../src/discussion/handoff"
import { parseState } from "../../src/discussion/store"
import type { Message, Run, Settings } from "../../src/discussion/types"

const settings: Settings = {
  a: { providerID: "p", modelID: "left" },
  b: { providerID: "p", modelID: "right" },
  mode: "debate",
  rounds: 2,
  maxOutputTokens: 1000,
}

const messages: Message[] = [
  {
    speaker: "a",
    label: "p/left",
    round: 1,
    text: "Opening.",
    ledger: { claims: [{ id: "A1", text: "refactor is safer" }, { id: "A2", text: "rewrites lose rules" }], answers: [], parsed: true },
  },
  {
    speaker: "b",
    label: "p/right",
    round: 1,
    text: "Reply.",
    ledger: { claims: [{ id: "B1", text: "tests come first" }], answers: [{ id: "A1", verdict: "rebutted" }], parsed: true },
  },
  {
    speaker: "a",
    label: "p/left",
    round: 2,
    text: "Second.",
    ledger: { claims: [], answers: [{ id: "B1", verdict: "accepted" }, { id: "A2", verdict: "accepted" }], parsed: true },
  },
  { speaker: "b", label: "p/right", round: 2, text: "No block.", ledger: { claims: [], answers: [], parsed: false } },
]

describe("ledger state", () => {
  test("claims are opened by their author and closed by the opponent", () => {
    const { claims } = ledgerOf(messages)
    expect(claims.map((claim) => [claim.id, claim.status])).toEqual([
      ["A1", "rebutted"],
      ["A2", "open"],
      ["B1", "accepted"],
    ])
  })

  test("each reply knows what it answered, left open and added", () => {
    const { replies } = ledgerOf(messages)
    expect(replies.map((reply) => ({ answered: reply.answered.map((a) => a.id), leftOpen: reply.leftOpen, added: reply.added }))).toEqual([
      { answered: [], leftOpen: [], added: ["A1", "A2"] },
      { answered: ["A1"], leftOpen: ["A2"], added: ["B1"] },
      // A cannot close its own claim A2
      { answered: ["B1"], leftOpen: [], added: [] },
      { answered: [], leftOpen: ["A2"], added: [] },
    ])
  })

  test("the conclusion and claims with the wrong side letter are ignored", () => {
    const { claims } = ledgerOf([
      { speaker: "a", label: "x", round: 1, text: "t", ledger: { claims: [{ id: "B5", text: "wrong side" }], answers: [], parsed: true } },
      { speaker: "b", label: "x", round: 1, text: "t", kind: "conclusion", ledger: { claims: [{ id: "B1", text: "c" }], answers: [], parsed: true } },
    ])
    expect(claims).toEqual([])
  })
})

describe("ledger notes", () => {
  const { replies } = ledgerOf(messages)

  test("a reply that leaves claims open is a warning", () => {
    expect(replyLedgerNote(replies[1])).toEqual({ text: "Answers A1 rebutted · leaves A2 open · new B1", warn: true })
  })

  test("a reply that closed everything is quiet", () => {
    expect(replyLedgerNote(replies[2])).toEqual({ text: "Answers B1 accepted", warn: false })
    expect(replyLedgerNote(replies[0])).toEqual({ text: "New A1, A2", warn: false })
  })

  test("an unreadable block is a warning", () => {
    expect(replyLedgerNote(replies[3]).warn).toBe(true)
    expect(replyLedgerNote(replies[3]).text).toContain("could not be read")
  })

  test("status wording", () => {
    expect(statusText({ status: "open", open: "skipped" })).toBe("skipped by the opponent")
    expect(statusText({ status: "open", open: "ended" })).toBe("left open: the debate ended")
    expect(statusText({ status: "rebutted" })).toBe("rebutted by the opponent")
  })

  test("an open claim is skipped if the opponent replied after it, ended otherwise", () => {
    const { claims } = ledgerOf([
      ...messages,
      { speaker: "b", label: "p/right", round: 3, text: "Last.", ledger: { claims: [{ id: "B2", text: "last word" }], answers: [], parsed: true } },
      { speaker: "b", label: "p/right", round: 3, text: "Sum.", kind: "conclusion" },
    ])
    const byId = Object.fromEntries(claims.map((claim) => [claim.id, claim]))
    // A2 was made in the first reply; B replied after it twice without closing it
    expect(byId.A2.open).toBe("skipped")
    // B2 came in the last dialogue reply: only a conclusion follows, which is not a reply
    expect(byId.B2.open).toBe("ended")
    expect(byId.A1.open).toBeUndefined()
  })
})

describe("ledger validation and storage", () => {
  test("valid and invalid records", () => {
    expect(validLedger({ claims: [{ id: "A1", text: "x" }], answers: [{ id: "B2", verdict: "accepted" }], parsed: true })).toBe(true)
    expect(validLedger({ claims: [{ id: "C1", text: "x" }], answers: [], parsed: true })).toBe(false)
    expect(validLedger({ claims: [], answers: [{ id: "A1", verdict: "maybe" }], parsed: true })).toBe(false)
    expect(validLedger({ claims: [], answers: [] })).toBe(false)
  })

  test("a stored message keeps its ledger", () => {
    const state = parseState({
      version: 2,
      revision: 1,
      sessions: {
        "loc\u0000ses": {
          location: "loc",
          sessionID: "ses",
          settings,
          runs: [{ runID: "r", topic: "t", settings, status: "completed", createdAt: 1, messages: messages.slice(0, 2), partial: null }],
        },
      },
    })
    expect(Object.values(state.sessions)[0].runs[0].messages[1].ledger?.answers).toEqual([{ id: "A1", verdict: "rebutted" }])
  })
})

describe("ledger in the handoff", () => {
  test("lists every claim with its author and fate", () => {
    const run: Run = { runID: "r", topic: "t", settings, status: "completed", createdAt: 1, messages, partial: null }
    const packet = buildHandoff(run)
    expect(packet).toContain("## Claims ledger")
    expect(packet).toContain("- A1 (p/left): refactor is safer — rebutted by the opponent")
    expect(packet).toContain("- A2 (p/left): rewrites lose rules — skipped by the opponent")
    expect(packet).toContain("- B1 (p/right): tests come first — accepted by the opponent")
    expect(packet.indexOf("## Claims ledger")).toBeLessThan(packet.indexOf("## Latest positions"))
  })

  test("no section without claims", () => {
    const run: Run = { runID: "r", topic: "t", settings, status: "completed", createdAt: 1, messages: [], partial: null }
    expect(buildHandoff(run)).not.toContain("Claims ledger")
  })
})
