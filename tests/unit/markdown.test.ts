import { describe, expect, test } from "bun:test"
import { textBlocks } from "../../src/ui/markdown"

describe("panel text blocks", () => {
  test("plain text is one block", () => {
    expect(textBlocks("Just a reply.\nSecond line.")).toEqual([{ heading: false, text: "Just a reply.\nSecond line." }])
  })

  test("Markdown headings become heading blocks without the hashes", () => {
    const text = "## Agreed\n- ship small\n\n## Disagreed\nNone.\n\n### Next steps ###\n1. Tests"
    expect(textBlocks(text)).toEqual([
      { heading: true, text: "Agreed" },
      { heading: false, text: "- ship small" },
      { heading: true, text: "Disagreed" },
      { heading: false, text: "None." },
      { heading: true, text: "Next steps" },
      { heading: false, text: "1. Tests" },
    ])
  })

  test("a hash without a space or inside a line is not a heading", () => {
    expect(textBlocks("#hashtag and C# code")).toEqual([{ heading: false, text: "#hashtag and C# code" }])
  })

  test("Windows line endings and blank edges are handled", () => {
    expect(textBlocks("\r\n## Согласовано\r\n\r\nТекст\r\n\r\n")).toEqual([
      { heading: true, text: "Согласовано" },
      { heading: false, text: "Текст" },
    ])
  })
})
