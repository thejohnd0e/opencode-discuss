import { describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

const root = resolve(dirname(import.meta.path), "..", "..")
const script = join(root, "scripts", "install-agents.mjs")

function run(target: string, ...extra: string[]): string {
  const result = Bun.spawnSync([process.execPath, script, "--target", target, ...extra])
  expect(result.exitCode).toBe(0)
  return result.stdout.toString()
}

describe("install-agents", () => {
  test("installs, leaves identical files alone, and backs up a changed one", () => {
    const target = mkdtempSync(join(tmpdir(), "discuss-agents-"))
    try {
      expect(run(target, "--dry-run")).toContain("would install")
      expect(readdirSync(target)).toEqual([])

      expect(run(target)).toContain("installed")
      const original = readFileSync(join(root, "agents", "discuss.md"), "utf8")
      expect(readFileSync(join(target, "discuss.md"), "utf8")).toBe(original)
      expect(run(target)).not.toContain("installed")

      writeFileSync(join(target, "discuss.md"), "my own edit\n")
      expect(run(target)).toContain("replaced")
      const backups = readdirSync(target).filter((name) => name.endsWith(".bak"))
      expect(backups).toHaveLength(1)
      expect(readFileSync(join(target, backups[0]), "utf8")).toBe("my own edit\n")
      expect(readFileSync(join(target, "discuss.md"), "utf8")).toBe(original)
    } finally {
      rmSync(target, { recursive: true, force: true })
    }
  })
})
