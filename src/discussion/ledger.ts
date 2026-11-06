/**
 * Claim ledger of a debate (Task 15b). Each debate reply carries its new
 * claims and its verdicts on the opponent's open claims; the state of every
 * claim is derived from the messages, so it never drifts from what was said.
 */

export type Verdict = "rebutted" | "accepted"
export type LedgerRecord = {
  claims: Array<{ id: string; text: string }>
  answers: Array<{ id: string; verdict: Verdict }>
  /** false when the reply had no readable ledger block. */
  parsed: boolean
}

export type ClaimStatus = "open" | Verdict
export type Claim = { id: string; side: "a" | "b"; text: string; status: ClaimStatus; round: number }

type MessageLike = { speaker: string; round: number; kind?: string; ledger?: LedgerRecord }

const ID = /^[AB][1-9]\d{0,3}$/

export function validLedger(value: unknown): value is LedgerRecord {
  if (!value || typeof value !== "object") return false
  const record = value as { claims?: unknown; answers?: unknown; parsed?: unknown }
  if (typeof record.parsed !== "boolean" || !Array.isArray(record.claims) || !Array.isArray(record.answers)) return false
  const claimsOk = record.claims.every(
    (claim) =>
      claim &&
      typeof claim === "object" &&
      typeof (claim as { id?: unknown }).id === "string" &&
      ID.test((claim as { id: string }).id) &&
      typeof (claim as { text?: unknown }).text === "string",
  )
  const answersOk = record.answers.every(
    (answer) =>
      answer &&
      typeof answer === "object" &&
      typeof (answer as { id?: unknown }).id === "string" &&
      ID.test((answer as { id: string }).id) &&
      ((answer as { verdict?: unknown }).verdict === "rebutted" || (answer as { verdict?: unknown }).verdict === "accepted"),
  )
  return claimsOk && answersOk
}

/** Copy with only the known fields, for storage. */
export function cleanLedger(record: LedgerRecord): LedgerRecord {
  return {
    claims: record.claims.map(({ id, text }) => ({ id, text: text.slice(0, 300) })),
    answers: record.answers.map(({ id, verdict }) => ({ id, verdict })),
    parsed: record.parsed,
  }
}

const sideOf = (id: string): "a" | "b" => (id.startsWith("A") ? "a" : "b")

/** What a reply did with the ledger, and the state of all claims after the run so far. */
export type ReplyLedger = {
  index: number
  answered: Array<{ id: string; verdict: Verdict }>
  leftOpen: string[]
  added: string[]
  parsed: boolean
}

export function ledgerOf(messages: readonly MessageLike[]): { claims: Claim[]; replies: ReplyLedger[] } {
  const claims = new Map<string, Claim>()
  const replies: ReplyLedger[] = []
  messages.forEach((message, index) => {
    if (!message.ledger || message.kind === "conclusion") return
    if (message.speaker !== "a" && message.speaker !== "b") return
    const opponent = message.speaker === "a" ? "b" : "a"
    const openBefore = [...claims.values()].filter((claim) => claim.side === opponent && claim.status === "open").map((claim) => claim.id)
    const answered: ReplyLedger["answered"] = []
    for (const answer of message.ledger.answers) {
      const claim = claims.get(answer.id)
      if (claim && claim.side === opponent && claim.status === "open") {
        claim.status = answer.verdict
        answered.push({ id: answer.id, verdict: answer.verdict })
      }
    }
    const added: string[] = []
    for (const claim of message.ledger.claims) {
      if (claims.has(claim.id) || sideOf(claim.id) !== message.speaker) continue
      claims.set(claim.id, { id: claim.id, side: message.speaker, text: claim.text, status: "open", round: message.round })
      added.push(claim.id)
    }
    const answeredIds = new Set(answered.map((entry) => entry.id))
    replies.push({
      index,
      answered,
      leftOpen: openBefore.filter((id) => !answeredIds.has(id)),
      added,
      parsed: message.ledger.parsed,
    })
  })
  return { claims: [...claims.values()], replies }
}

export type LedgerNote = { text: string; warn: boolean }

/** One line under a reply in the panel. */
export function replyLedgerNote(reply: ReplyLedger): LedgerNote {
  if (!reply.parsed) return { text: "No claims block: the ledger could not be read for this reply", warn: true }
  const parts: string[] = []
  if (reply.answered.length) parts.push(`answers ${reply.answered.map((entry) => `${entry.id} ${entry.verdict}`).join(", ")}`)
  if (reply.leftOpen.length) parts.push(`leaves ${reply.leftOpen.join(", ")} open`)
  if (reply.added.length) parts.push(`new ${reply.added.join(", ")}`)
  const text = parts.length ? parts.join(" · ") : "no claims"
  return { text: text[0].toUpperCase() + text.slice(1), warn: reply.leftOpen.length > 0 }
}

export function statusText(status: ClaimStatus): string {
  return status === "open" ? "never answered" : status === "rebutted" ? "rebutted by the opponent" : "accepted by the opponent"
}
