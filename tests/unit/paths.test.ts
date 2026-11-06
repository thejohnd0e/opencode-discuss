import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { DEFAULT_RUNNER } from "../../src/paths"

describe("default runner path", () => {
  test("points at the package's own runner, independent of the working directory", () => {
    const packageRoot = resolve(dirname(import.meta.path), "..", "..")
    expect(DEFAULT_RUNNER).toBe(resolve(packageRoot, "scripts", "discuss-runner.py"))
    expect(existsSync(DEFAULT_RUNNER)).toBe(true)
  })
})
