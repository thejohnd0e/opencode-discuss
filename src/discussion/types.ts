export type Status = "idle" | "running" | "completed" | "cancelled" | "failed"
export type Mode = "cooperative" | "critical" | "debate"

export type ModelRef = {
  providerID: string
  modelID: string
  variant?: string
}

export type Settings = {
  a: ModelRef
  b: ModelRef
  mode: Mode
  rounds: number
  maxOutputTokens: number
}

export type Speaker = "a" | "b" | "human" | "topic"

export type Message = {
  speaker: Speaker
  /** Display label captured when the message was produced. */
  label: string
  round: number
  text: string
  seconds?: number
}

export type PartialMessage = {
  speaker: Speaker
  label: string
  round: number
  text: string
}

export type Usage = {
  input?: number
  output?: number
  /** Reasoning tokens, reported by the host separately from `output`. */
  reasoning?: number
  cost?: number
  /** Model requests actually made for the run, including failed ones. */
  requests?: number
}

export type Run = {
  runID: string
  topic: string
  settings: Settings
  status: Status
  createdAt: number
  finishedAt?: number
  messages: Message[]
  partial: PartialMessage | null
  transcript?: string
  error?: string
  errorKind?: "provider" | "python" | "timeout" | "cancelled" | "restart"
  usage?: Usage
  /** Set once the result was sent to Plan/Build; it is never sent twice, even after a restart. */
  handoff?: Handoff
}

export type Handoff = { target: "plan" | "build"; at: number }

export type SessionRecord = {
  location: string
  sessionID: string
  settings: Settings | null
  runs: Run[]
}

export type StoredState = {
  version: 2
  revision: number
  sessions: Record<string, SessionRecord>
  /**
   * The settings most recently saved in this location. Offered to a new
   * session as an explicit choice; never applied without the user picking it.
   */
  last?: Settings | null
}

export type Storage = {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
}

export const MODES: readonly Mode[] = ["cooperative", "critical", "debate"]
export const MAX_ROUNDS = 12
export const MIN_OUTPUT_TOKENS = 16
export const MAX_OUTPUT_TOKENS = 32_000

export function modelLabel(model: ModelRef): string {
  return `${model.providerID}/${model.modelID}${model.variant ? `#${model.variant}` : ""}`
}

export function speakerLabel(speaker: Speaker, settings: Settings): string {
  if (speaker === "a") return modelLabel(settings.a)
  if (speaker === "b") return modelLabel(settings.b)
  if (speaker === "human") return "human"
  return "topic"
}

/** Worst-case participant calls and output tokens; input and orchestrator calls are extra. */
export function callBound(settings: Settings): { participantCalls: number; worstCaseOutputTokens: number } {
  const participantCalls = settings.rounds * 2
  return { participantCalls, worstCaseOutputTokens: participantCalls * settings.maxOutputTokens }
}
