import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createLog, logPath, shape } from "../../src/ui/log"

describe("TUI journal", () => {
  test("is on by default under the state directory; DISCUSS_LOG overrides or disables it", () => {
    expect(logPath({ LOCALAPPDATA: "C:\\Local" })).toBe(join("C:\\Local", "opencode-discuss", "logs", "tui.jsonl"))
    expect(logPath({ LOCALAPPDATA: "C:\\Local", DISCUSS_LOG: "D:\\x.jsonl" })).toBe("D:\\x.jsonl")
    for (const off of ["off", "OFF", "0", "false", "no"]) expect(logPath({ DISCUSS_LOG: off })).toBeUndefined()
  })

  test("writes one JSON line per event with a timestamp, creating the directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "discuss-log-"))
    try {
      const path = join(dir, "nested", "tui.jsonl")
      const log = createLog(path, 1_000_000, () => Date.UTC(2026, 10, 6, 12, 0, 0))
      log("command", { id: "discuss.models", args: "text(5)" })
      log("panel-current", { name: null })
      const lines = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line))
      expect(lines).toEqual([
        { at: "2026-11-06T12:00:00.000Z", stage: "command", id: "discuss.models", args: "text(5)" },
        { at: "2026-11-06T12:00:00.000Z", stage: "panel-current", name: null },
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("rotates to a single .1 file once the size limit is reached", () => {
    const dir = mkdtempSync(join(tmpdir(), "discuss-log-"))
    try {
      const path = join(dir, "tui.jsonl")
      const log = createLog(path, 200)
      for (let index = 0; index < 20; index++) log("event", { index, filler: "x".repeat(40) })
      expect(existsSync(`${path}.1`)).toBe(true)
      expect(existsSync(`${path}.2`)).toBe(false)
      expect(readFileSync(path, "utf8").length).toBeLessThan(400)
      const last = readFileSync(path, "utf8").trim().split("\n").at(-1)
      expect(JSON.parse(last!).index).toBe(19)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("never throws, even when the path cannot be written", () => {
    const log = createLog(join(tmpdir(), "\u0000invalid", "tui.jsonl"))
    expect(() => log("event")).not.toThrow()
    expect(() => createLog(undefined)("event")).not.toThrow()
  })

  test("user text is described by length, never copied", () => {
    expect(shape("  тема с пробелами ")).toBe("text(16)")
    expect(shape("   ")).toBe("empty")
    expect(shape(undefined)).toBe("none")
    expect(shape(3)).toBe("number")
  })
})
