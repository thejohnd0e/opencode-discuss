import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { DEFAULT_RUNNER, defaultPython } from "../../src/paths"

describe("default python command", () => {
  test("python on Windows, python3 elsewhere", () => {
    expect(defaultPython("win32")).toBe("python")
    expect(defaultPython("darwin")).toBe("python3")
    expect(defaultPython("linux")).toBe("python3")
  })
})

describe("default runner path", () => {
  test("points at the package's own runner, independent of the working directory", () => {
    const packageRoot = resolve(dirname(import.meta.path), "..", "..")
    expect(DEFAULT_RUNNER).toBe(resolve(packageRoot, "scripts", "discuss-runner.py"))
    expect(existsSync(DEFAULT_RUNNER)).toBe(true)
  })
})
