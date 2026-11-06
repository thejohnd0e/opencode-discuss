/**
 * Compile-only probe of the public plugin API this project intends to use.
 *
 * It is not executed against a live server. `tsc --noEmit` failing here means the
 * installed OpenCode plugin contract does not support the planned design, which is
 * the compatibility gate described in the implementation plan.
 */
import { Plugin } from "@opencode/plugin"
import { Rpc } from "@opencode/plugin/rpc"

const Discuss = Rpc.define({
  id: "discuss",
  methods: {
    start: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" }, topic: { type: "string" } },
        required: ["sessionID", "topic"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { runID: { type: "string" } },
        required: ["runID"],
        additionalProperties: false,
      },
    },
  },
  events: {
    updated: {
      schema: {
        type: "object",
        properties: { sessionID: { type: "string" }, revision: { type: "number" } },
        required: ["sessionID", "revision"],
        additionalProperties: false,
      },
    },
  },
})

export default Plugin.define({
  id: "discuss.compatibility-probe",
  async setup(ctx) {
    const registration = await ctx.rpc.register(Discuss, {
      start: async (input) => {
        const { sessionID } = input as { sessionID: string }
        return { runID: `${sessionID}:probe` }
      },
    })

    await registration.events.emit("updated", { sessionID: "probe", revision: 1 })
    await ctx.rpc(Discuss).start({ sessionID: "probe", topic: "probe" })

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "discuss_start",
        description: "Start a discussion",
        input: {
          type: "object",
          properties: { topic: { type: "string" } },
          required: ["topic"],
          additionalProperties: false,
        },
        execute: async (input, context) => {
          context.signal.addEventListener("abort", () => {})
          return { content: `started ${(input as { topic: string }).topic}` }
        },
      })
    })

    await ctx.storage.set("probe", { ok: true })

    const generated = await ctx.experimental.generate.text({
      model: { providerID: "probe", id: "model" },
      prompt: "probe",
    })
    void generated

    const created = await ctx.session.create({
      title: "probe",
      agent: "discuss-participant",
      model: { providerID: "probe", id: "model" },
      location: { directory: ctx.location.directory },
    })
    await ctx.session.switchModel({
      sessionID: created.id,
      model: { providerID: "probe", id: "model" },
    })
    await ctx.session.prompt({ sessionID: created.id, text: "probe" })
    await ctx.session.interrupt({ sessionID: created.id })
    await ctx.session.remove({ sessionID: created.id })

    const controller = new AbortController()
    for await (const event of ctx.event.subscribe({
      types: ["session.text.delta", "session.execution.succeeded", "session.execution.failed"],
      signal: controller.signal,
    })) {
      if (event.type === "session.text.delta") void event.data.delta
    }

    await ctx.session.hook("context", (event) => {
      event.options.maxTokens = 1200
    })

    await ctx.permission.assert({
      sessionID: created.id,
      agent: "discuss",
      action: "discuss.start",
      resources: ["model-a", "model-b"],
      metadata: { topic: "probe" },
      source: { type: "tool", messageID: "msg_probe", id: "call_probe" },
    })
  },
})
