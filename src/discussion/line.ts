/** Newline-delimited JSON framing with a hard cap on a single message. */
export class LineDecoder {
  #buffer = ""
  #limit: number

  constructor(limit = 8 * 1024 * 1024) {
    this.#limit = limit
  }

  push(chunk: string): string[] {
    this.#buffer += chunk
    if (this.#buffer.length > this.#limit && !this.#buffer.includes("\n")) {
      this.#buffer = ""
      throw new Error(`line too long (limit ${this.#limit} characters)`)
    }
    const lines = this.#buffer.split("\n")
    this.#buffer = lines.pop() ?? ""
    if (this.#buffer.length > this.#limit) {
      this.#buffer = ""
      throw new Error(`line too long (limit ${this.#limit} characters)`)
    }
    return lines.filter((line) => line.trim() !== "")
  }

  reset(): void {
    this.#buffer = ""
  }
}
