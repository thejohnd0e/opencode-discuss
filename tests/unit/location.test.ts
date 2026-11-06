import { describe, expect, test } from "bun:test"
import { normalizeLocation, sameLocation, sessionDirectory, stateKey } from "../../src/discussion/location"

describe("locations", () => {
  test("backslashes, trailing slashes and drive-path case are normalized", () => {
    expect(normalizeLocation("D:\\MyProjects\\opencode-discuss\\")).toBe("d:/myprojects/opencode-discuss")
    expect(sameLocation("D:\\Projects\\demo", "D:/Projects/demo")).toBe(true)
    expect(sameLocation("C:\\Users\\someone", "D:/Projects/demo")).toBe(false)
    expect(sameLocation(undefined, "D:/x")).toBe(false)
  })

  test("POSIX paths keep their case", () => {
    expect(normalizeLocation("/home/User/proj/")).toBe("/home/User/proj")
    expect(sameLocation("/home/User/proj", "/home/user/proj")).toBe(false)
    expect(normalizeLocation("/")).toBe("/")
  })

  test("the state key is per location and stable across spellings", () => {
    expect(stateKey("D:\\Work\\a")).toBe(stateKey("d:/work/a/"))
    expect(stateKey("D:\\Work\\a")).not.toBe(stateKey("D:\\Work\\b"))
    expect(stateKey("D:\\Work\\a")).toMatch(/^discuss\/state@[0-9a-f]{16}$/)
  })

  test("a session's directory is read from its location, or undefined", () => {
    expect(sessionDirectory({ id: "s", location: { directory: "D:/x" } })).toBe("D:/x")
    expect(sessionDirectory({ id: "s" })).toBeUndefined()
    expect(sessionDirectory(undefined)).toBeUndefined()
  })
})
