import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Plugin } from "@opencode/plugin"
import { Rpc } from "@opencode/plugin/rpc"

const root = join(import.meta.dir, "..", "..")

const version = (name: string) =>
  JSON.parse(readFileSync(join(root, "node_modules", name, "package.json"), "utf8")).version as string

describe("installed plugin contract", () => {
  test("the SDK matches the OpenCode release this project targets", () => {
    expect(version("@opencode/plugin")).toBe("2.2.5")
    expect(version("@opencode/client")).toBe("2.2.5")
    expect(version("@opencode/schema")).toBe("2.2.5")
  })

  test("plugin and RPC definitions are callable public exports", () => {
    expect(typeof Plugin.define).toBe("function")
    expect(typeof Rpc.define).toBe("function")
  })

  test("an RPC definition with methods and events validates", () => {
    const definition = Rpc.define({
      id: "probe",
      methods: {
        ping: {
          input: { type: "object", properties: {}, additionalProperties: false },
          output: { type: "object", properties: {}, additionalProperties: false },
        },
      },
      events: {
        tick: { schema: { type: "object", properties: {}, additionalProperties: false } },
      },
    })
    expect(definition.id).toBe("probe")
    expect(Object.keys(definition.methods)).toEqual(["ping"])
    expect(Object.keys(definition.events)).toEqual(["tick"])
  })

  test("a reserved rpc.* error name is rejected at definition time", () => {
    expect(() =>
      Rpc.define({
        id: "probe.reserved",
        methods: {
          ping: {
            input: { type: "object", properties: {}, additionalProperties: false },
            output: { type: "object", properties: {}, additionalProperties: false },
            errors: { "rpc.reserved": { type: "object", properties: {}, additionalProperties: false } },
          } as never,
        },
        events: {},
      }),
    ).toThrow()
  })
})
