import { describe, expect, test } from "bun:test"
import { DiscussRpc } from "../../src/rpc"
import type { Run, Usage } from "../../src/discussion/types"

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

  test("the snapshot schema keeps every field of a fully populated run", () => {
    // The host drops properties a schema with additionalProperties:false does not list.
    const dropped: string[] = []
    const walk = (schema: any, value: unknown, path: string) => {
      if (!schema || value === null || typeof value !== "object") return
      if (Array.isArray(value)) return value.forEach((item, index) => walk(schema.items, item, `${path}[${index}]`))
      if (schema.type !== "object" && !(Array.isArray(schema.type) && schema.type.includes("object"))) return
      for (const [key, inner] of Object.entries(value)) {
        if (!schema.properties?.[key]) {
          if (schema.additionalProperties === false) dropped.push(`${path}.${key}`)
          continue
        }
        walk(schema.properties[key], inner, `${path}.${key}`)
      }
    }
    const run: Required<Run> = {
      runID: "r",
      topic: "t",
      settings: { a: { providerID: "p", modelID: "a", variant: "low" }, b: { providerID: "p", modelID: "b" }, mode: "cooperative", rounds: 1, maxOutputTokens: 100 },
      status: "completed",
      createdAt: 1,
      finishedAt: 2,
      messages: [{ speaker: "a", label: "p/a", round: 1, text: "x", seconds: 1 }],
      partial: { speaker: "b", label: "p/b", round: 1, text: "y" },
      transcript: "path",
      error: "e",
      errorKind: "provider",
      usage: { input: 1, output: 2, reasoning: 3, cost: 4, requests: 5 } satisfies Required<Usage>,
      handoff: { target: "plan", at: 1 },
    }
    walk((DiscussRpc.methods.snapshot.output as any).properties.run, run, "run")
    walk((DiscussRpc.methods.history.output as any).properties.runs, [run], "runs")
    expect(dropped).toEqual([])
  })
})
