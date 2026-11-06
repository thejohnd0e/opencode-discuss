/** Result of checking a debate reply against the opponent's last reply (Task 15a). */
export type AnswerCheck = {
  quoted: number
  /** Quotes found in the opponent's own words. */
  matched: number
  /** Quotes of the replier's own earlier words, found only in what the opponent had quoted. */
  recycled?: number
}

export type AnswerNote = { text: string; warn: boolean }

/**
 * One line for the panel and the handoff: whether a debate reply answered the
 * opponent's arguments. `null` when the reply was not checked.
 */
export function answerNote(check: AnswerCheck | undefined): AnswerNote | null {
  if (!check) return null
  const points = (count: number) => `${count} point${count === 1 ? "" : "s"}`
  if (check.quoted === 0) return { text: "Did not quote the opponent: may not answer their arguments", warn: true }
  const recycled = check.recycled ?? 0
  if (recycled > 0) {
    const own = `${recycled} quote${recycled === 1 ? " is" : "s are"} its own words back, not the opponent's`
    return {
      text: check.matched > 0 ? `Answers ${points(check.matched)} of the opponent; ${own}` : `Quotes its own words back, not the opponent's: may not answer their arguments`,
      warn: true,
    }
  }
  if (check.matched === 0) {
    return { text: "Quotes not found in the opponent's reply: may not answer their arguments", warn: true }
  }
  if (check.matched < check.quoted) {
    return {
      text: `Answers ${points(check.matched)} of the opponent; ${check.quoted - check.matched} quote${check.quoted - check.matched === 1 ? "" : "s"} not found in their reply`,
      warn: true,
    }
  }
  return { text: `Answers ${points(check.matched)} of the opponent`, warn: false }
}

export function validAnswerCheck(value: unknown): value is AnswerCheck {
  if (!value || typeof value !== "object") return false
  const { quoted, matched, recycled } = value as { quoted?: unknown; matched?: unknown; recycled?: unknown }
  const extra = recycled === undefined ? 0 : recycled
  return (
    typeof quoted === "number" &&
    typeof matched === "number" &&
    typeof extra === "number" &&
    Number.isInteger(quoted) &&
    Number.isInteger(matched) &&
    Number.isInteger(extra) &&
    quoted >= 0 &&
    matched >= 0 &&
    extra >= 0 &&
    matched + extra <= quoted
  )
}

/** Copy with only the known fields, for storage. */
export function cleanAnswerCheck(check: AnswerCheck): AnswerCheck {
  return { quoted: check.quoted, matched: check.matched, ...(check.recycled ? { recycled: check.recycled } : {}) }
}
