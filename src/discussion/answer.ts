/** Result of checking a debate reply against the opponent's last reply (Task 15a). */
export type AnswerCheck = { quoted: number; matched: number }

export type AnswerNote = { text: string; warn: boolean }

/**
 * One line for the panel and the handoff: whether a debate reply answered the
 * opponent's arguments. `null` when the reply was not checked.
 */
export function answerNote(check: AnswerCheck | undefined): AnswerNote | null {
  if (!check) return null
  const points = (count: number) => `${count} point${count === 1 ? "" : "s"}`
  if (check.quoted === 0) return { text: "Did not quote the opponent: may not answer their arguments", warn: true }
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
  const { quoted, matched } = value as { quoted?: unknown; matched?: unknown }
  return (
    typeof quoted === "number" &&
    typeof matched === "number" &&
    Number.isInteger(quoted) &&
    Number.isInteger(matched) &&
    quoted >= 0 &&
    matched >= 0 &&
    matched <= quoted
  )
}
