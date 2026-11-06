import { describe, expect, test } from "bun:test"
import { DiscussRpc } from "../../src/rpc"

const objectSchema = (schema: unknown) => {
  const value = schema as { type?: string }
  return value.type === "object"
}

describe("Discuss RPC contract", () => {
  test("exposes the lifecycle methods the server implements", () => {
    expect(Object.keys(DiscussRpc.methods).sort()).toEqual(
      [
        "handoff",
        "history",
        "interject",
        "models",
        "settingsGet",
        "settingsSet",
        "snapshot",
        "start",
        "stop",
        "topic",
      ].sort(),
    )
  })

  test("every method declares object input and output schemas", () => {
    for (const [name, method] of Object.entries(DiscussRpc.methods)) {
      expect(`${name}:${objectSchema(method.input)}`).toBe(`${name}:true`)
      expect(`${name}:${objectSchema(method.output)}`).toBe(`${name}:true`)
    }
  })

  test("declares the busy and invalid_settings errors used by the UI", () => {
    expect(Object.keys(DiscussRpc.methods.start.errors ?? {}).sort()).toEqual(
      ["busy", "invalid_settings", "model_unavailable", "not_found"].sort(),
    )
  })

  test("declares an object-shaped update event with a revision", () => {
    const schema = DiscussRpc.events.updated.schema as {
      type: string
      required: string[]
    }
    expect(schema.type).toBe("object")
    expect(schema.required).toContain("revision")
    expect(schema.required).toContain("sessionID")
    expect(schema.required).toContain("runID")
  })
})
