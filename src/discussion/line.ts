/**
 * Newline-delimited JSON framing with a hard cap on a single message.
 *
 * The cap is exact: no line longer than `limit` characters is ever returned,
 * whether it arrives whole inside one chunk or spread over many. An overlong
 * line is dropped up to its newline (the next line is read normally) and
 * reported through `onOverflow`; lines around it in the same chunk are kept.
 */
export class LineDecoder {
  #buffer = ""
  #limit: number
  #onOverflow: (length: number) => void
  /** Inside an overlong line: discard until the next newline. */
  #skipping = false
  #skipped = 0

  constructor(limit = 8 * 1024 * 1024, onOverflow: (length: number) => void = () => {}) {
    this.#limit = limit
    this.#onOverflow = onOverflow
  }

  push(chunk: string): string[] {
    const out: string[] = []
    let rest = chunk

    if (this.#skipping) {
      const end = rest.indexOf("\n")
      if (end < 0) {
        this.#skipped += rest.length
        return out
      }
      this.#onOverflow(this.#skipped + end)
      this.#skipping = false
      this.#skipped = 0
      rest = rest.slice(end + 1)
    }

    const parts = (this.#buffer + rest).split("\n")
    const tail = parts.pop() ?? ""
    for (const line of parts) {
      if (line.length > this.#limit) this.#onOverflow(line.length)
      else if (line.trim() !== "") out.push(line)
    }

    if (tail.length > this.#limit) {
      this.#buffer = ""
      this.#skipping = true
      this.#skipped = tail.length
    } else {
      this.#buffer = tail
    }
    return out
  }

  reset(): void {
    this.#buffer = ""
    this.#skipping = false
    this.#skipped = 0
  }
}
