import { Rpc } from "@opencode/plugin/rpc"

const model = {
  type: "object",
  properties: {
    providerID: { type: "string" },
    modelID: { type: "string" },
    variant: { type: "string" },
  },
  required: ["providerID", "modelID"],
  additionalProperties: false,
} as const

const settings = {
  type: "object",
  properties: {
    a: model,
    b: model,
    mode: { type: "string", enum: ["cooperative", "critical", "debate"] },
    rounds: { type: "number" },
    maxOutputTokens: { type: "number" },
  },
  required: ["a", "b", "mode", "rounds", "maxOutputTokens"],
  additionalProperties: false,
} as const

const object = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object" as const,
  properties,
  required,
  additionalProperties: false,
})

const message = object(
  {
    speaker: { type: "string", enum: ["a", "b", "human", "topic"] },
    label: { type: "string" },
    round: { type: "number" },
    text: { type: "string" },
    seconds: { type: "number" },
  },
  ["speaker", "label", "round", "text"],
)

const run = object(
  {
    runID: { type: "string" },
    topic: { type: "string" },
    settings,
    status: { type: "string", enum: ["idle", "running", "completed", "cancelled", "failed"] },
    createdAt: { type: "number" },
    finishedAt: { type: "number" },
    messages: { type: "array", items: message },
    partial: {
      type: ["object", "null"],
      properties: {
        speaker: { type: "string" },
        label: { type: "string" },
        round: { type: "number" },
        text: { type: "string" },
      },
      required: ["speaker", "label", "round", "text"],
      additionalProperties: false,
    },
    transcript: { type: "string" },
    error: { type: "string" },
    errorKind: { type: "string" },
    // Every field of `Usage` and `Run` must be listed: the host drops anything
    // else (live: `handoff`, `usage.requests` and `usage.reasoning` were lost).
    usage: object(
      {
        input: { type: "number" },
        output: { type: "number" },
        reasoning: { type: "number" },
        cost: { type: "number" },
        requests: { type: "number" },
      },
      [],
    ),
    handoff: object({ target: { type: "string", enum: ["plan", "build"] }, at: { type: "number" } }, ["target", "at"]),
  },
  ["runID", "topic", "settings", "status", "createdAt", "messages", "partial"],
)

const snapshot = object(
  {
    sessionID: { type: "string" },
    revision: { type: "number" },
    settings: { type: ["object", "null"] },
    run,
    runs: { type: "array", items: object({ runID: { type: "string" }, topic: { type: "string" }, status: { type: "string" }, createdAt: { type: "number" } }, ["runID", "topic", "status", "createdAt"]) },
  },
  ["sessionID", "revision", "runs"],
)

export const DiscussRpc = Rpc.define({
  id: "discuss",
  methods: {
    start: {
      input: object({ sessionID: { type: "string" }, topic: { type: "string" }, requestID: { type: "string" } }, ["sessionID", "topic", "requestID"]),
      output: object({ runID: { type: "string" }, revision: { type: "number" } }, ["runID", "revision"]),
      errors: {
        busy: object({ runID: { type: "string" } }, ["runID"]),
        invalid_settings: object({ reason: { type: "string" } }, ["reason"]),
        model_unavailable: object({ side: { type: "string" }, modelID: { type: "string" } }, ["side", "modelID"]),
        not_found: object({ sessionID: { type: "string" } }, ["sessionID"]),
      },
    },
    snapshot: {
      input: object({ sessionID: { type: "string" }, runID: { type: "string" } }, ["sessionID"]),
      output: snapshot,
      errors: { not_found: object({ sessionID: { type: "string" } }, ["sessionID"]) },
    },
    history: {
      input: object({ sessionID: { type: "string" } }, ["sessionID"]),
      output: object({ sessionID: { type: "string" }, runs: { type: "array", items: run } }, ["sessionID", "runs"]),
    },
    stop: {
      input: object({ sessionID: { type: "string" }, runID: { type: "string" } }, ["sessionID", "runID"]),
      output: object({ stopped: { type: "boolean" }, revision: { type: "number" } }, ["stopped", "revision"]),
      errors: { stale_run: object({ runID: { type: "string" } }, ["runID"]) },
    },
    interject: {
      input: object({ sessionID: { type: "string" }, runID: { type: "string" }, text: { type: "string" } }, ["sessionID", "runID", "text"]),
      output: object({ accepted: { type: "boolean" }, revision: { type: "number" } }, ["accepted", "revision"]),
      errors: { stale_run: object({ runID: { type: "string" } }, ["runID"]) },
    },
    topic: {
      input: object({ sessionID: { type: "string" }, runID: { type: "string" }, text: { type: "string" } }, ["sessionID", "runID", "text"]),
      output: object({ accepted: { type: "boolean" }, revision: { type: "number" } }, ["accepted", "revision"]),
      errors: { stale_run: object({ runID: { type: "string" } }, ["runID"]) },
    },
    models: {
      input: object({ sessionID: { type: "string" } }, ["sessionID"]),
      output: object(
        {
          models: {
            type: "array",
            items: object(
              {
                providerID: { type: "string" },
                modelID: { type: "string" },
                name: { type: "string" },
                variants: { type: "array", items: { type: "string" } },
                available: { type: "boolean" },
              },
              ["providerID", "modelID", "name", "variants", "available"],
            ),
          },
        },
        ["models"],
      ),
    },
    settingsGet: {
      input: object({ sessionID: { type: "string" } }, ["sessionID"]),
      output: object(
        { sessionID: { type: "string" }, settings: { type: ["object", "null"] }, last: { type: ["object", "null"] } },
        ["sessionID", "settings"],
      ),
    },
    settingsSet: {
      input: object({ sessionID: { type: "string" }, settings }, ["sessionID", "settings"]),
      output: object({ sessionID: { type: "string" }, revision: { type: "number" } }, ["sessionID", "revision"]),
      errors: {
        invalid_settings: object({ reason: { type: "string" } }, ["reason"]),
        not_found: object({ sessionID: { type: "string" } }, ["sessionID"]),
      },
    },
    handoff: {
      input: object(
        {
          sessionID: { type: "string" },
          runID: { type: "string" },
          target: { type: "string", enum: ["plan", "build"] },
          confirm: { type: "boolean" },
        },
        ["sessionID", "runID", "target", "confirm"],
      ),
      output: object(
        {
          packet: { type: "string" },
          path: { type: "string" },
          submitted: { type: "boolean" },
        },
        ["packet", "path", "submitted"],
      ),
      errors: {
        not_confirmed: object({ packet: { type: "string" } }, ["packet"]),
        not_found: object({ runID: { type: "string" } }, ["runID"]),
      },
    },
  },
  events: {
    updated: {
      schema: object(
        {
          sessionID: { type: "string" },
          runID: { type: "string" },
          revision: { type: "number" },
          kind: {
            type: "string",
            enum: ["started", "delta", "message", "control", "transcript", "terminal", "error", "settings"],
          },
          payload: { type: "object" },
        },
        ["sessionID", "runID", "revision", "kind", "payload"],
      ),
    },
  },
})

export type DiscussRpcType = typeof DiscussRpc
