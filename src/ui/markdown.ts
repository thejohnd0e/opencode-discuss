/** A piece of a reply for the panel: a heading line, or a run of ordinary text. */
export type TextBlock = { heading: boolean; text: string }

const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/

/**
 * Splits a reply into headings and text so the panel can show `## Agreed` as a
 * bold "Agreed" instead of raw Markdown. Text between headings stays as it is
 * (lists keep their markers); leading and trailing blank lines of a block are
 * dropped. The stored text and the handoff keep the original Markdown.
 */
export function textBlocks(text: string): TextBlock[] {
  const blocks: TextBlock[] = []
  let pending: string[] = []
  const flush = () => {
    while (pending.length && !pending[0].trim()) pending.shift()
    while (pending.length && !pending[pending.length - 1].trim()) pending.pop()
    if (pending.length) blocks.push({ heading: false, text: pending.join("\n") })
    pending = []
  }
  for (const raw of text.split(/\r?\n/)) {
    const match = HEADING.exec(raw)
    if (match && match[1]) {
      flush()
      blocks.push({ heading: true, text: match[1] })
    } else {
      pending.push(raw)
    }
  }
  flush()
  return blocks
}
