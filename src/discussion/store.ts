import { addUsage, type StepUsage } from "./usage"
import { randomUUID } from "node:crypto"
import {
  MAX_OUTPUT_TOKENS,
  MAX_ROUNDS,
  MIN_OUTPUT_TOKENS,
  MODES,
  speakerLabel,
  type Message,
  type ModelRef,
  type Mode,
  type PartialMessage,
  type Run,
  type SessionRecord,
  type Settings,
  type Status,
  type Storage,
  type StoredState,
  type Usage,
} from "./types"
import { LEGACY_STATE_KEY, stateKey } from "./location"

const VERSION = 2

function fail(message: string): never {
  throw new Error(message)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

function modelRef(value: unknown, where: string): ModelRef {
  if (!isRecord(value)) fail(`${where} must be an object`)
  const providerID = value.providerID
  const modelID = value.modelID
  const variant = value.variant
  if (typeof providerID !== "string" || !providerID.trim()) fail(`${where}.providerID is required`)
  if (typeof modelID !== "string" || !modelID.trim()) fail(`${where}.modelID is required`)
  if (variant !== undefined && typeof variant !== "string") fail(`${where}.variant must be a string`)
  return variant === undefined ? { providerID, modelID } : { providerID, modelID, variant }
}

export function validateSettings(value: unknown): Settings {
  if (!isRecord(value)) fail("settings must be an object")
  const mode = value.mode
  if (typeof mode !== "string" || !MODES.includes(mode as Mode)) fail("settings.mode is invalid")
  const rounds = value.rounds
  if (typeof rounds !== "number" || !Number.isInteger(rounds) || rounds < 1 || rounds > MAX_ROUNDS) {
    fail(`settings.rounds must be an integer between 1 and ${MAX_ROUNDS}`)
  }
  const maxOutputTokens = value.maxOutputTokens
  if (
    typeof maxOutputTokens !== "number" ||
    !Number.isInteger(maxOutputTokens) ||
    maxOutputTokens < MIN_OUTPUT_TOKENS ||
    maxOutputTokens > MAX_OUTPUT_TOKENS
  ) {
    fail(`settings.maxOutputTokens must be an integer between ${MIN_OUTPUT_TOKENS} and ${MAX_OUTPUT_TOKENS}`)
  }
  return {
    a: modelRef(value.a, "settings.a"),
    b: modelRef(value.b, "settings.b"),
    mode: mode as Mode,
    rounds,
    maxOutputTokens,
  }
}

function message(value: unknown, where: string): Message {
  if (!isRecord(value)) fail(`${where} must be an object`)
  const { speaker, label, round, text } = value
  if (!["a", "b", "human", "topic"].includes(String(speaker))) fail(`${where}.speaker is invalid`)
  if (typeof label !== "string" || !label) fail(`${where}.label is required`)
  if (typeof round !== "number" || !Number.isInteger(round) || round < 1) fail(`${where}.round is invalid`)
  if (typeof text !== "string") fail(`${where}.text is required`)
  const seconds = value.seconds
  if (seconds !== undefined && typeof seconds !== "number") fail(`${where}.seconds is invalid`)
  return seconds === undefined
    ? { speaker: speaker as Message["speaker"], label, round, text }
    : { speaker: speaker as Message["speaker"], label, round, text, seconds }
}

function partial(value: unknown, where: string): PartialMessage | null {
  if (value === null || value === undefined) return null
  if (!isRecord(value)) fail(`${where} must be an object or null`)
  if (!["a", "b", "human", "topic"].includes(String(value.speaker))) fail(`${where}.speaker is invalid`)
  if (typeof value.label !== "string") fail(`${where}.label is required`)
  if (typeof value.round !== "number" || !Number.isInteger(value.round) || value.round < 1) fail(`${where}.round is invalid`)
  if (typeof value.text !== "string") fail(`${where}.text is required`)
  return {
    speaker: value.speaker as PartialMessage["speaker"],
    label: value.label,
    round: value.round,
    text: value.text,
  }
}

function usage(value: unknown, where: string): Usage | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) fail(`${where} must be an object`)
  const result: Usage = {}
  for (const key of ["input", "output", "reasoning", "cost", "requests"] as const) {
    const entry = value[key]
    if (entry === undefined) continue
    if (typeof entry !== "number" || !Number.isFinite(entry)) fail(`${where}.${key} is invalid`)
    result[key] = entry
  }
  return result
}

export function validateRun(value: unknown, where = "run"): Run {
  if (!isRecord(value)) fail(`${where} must be an object`)
  if (typeof value.runID !== "string" || !value.runID) fail(`${where}.runID is required`)
  if (typeof value.topic !== "string") fail(`${where}.topic is required`)
  if (typeof value.createdAt !== "number") fail(`${where}.createdAt is required`)
  const status = value.status
  if (!["idle", "running", "completed", "cancelled", "failed"].includes(String(status))) {
    fail(`${where}.status is invalid`)
  }
  if (!Array.isArray(value.messages)) fail(`${where}.messages must be an array`)
  const errorKind = value.errorKind
  if (
    errorKind !== undefined &&
    !["provider", "python", "timeout", "cancelled", "restart"].includes(String(errorKind))
  ) {
    fail(`${where}.errorKind is invalid`)
  }
  const transcript = value.transcript
  if (transcript !== undefined && typeof transcript !== "string") fail(`${where}.transcript must be a string`)
  const error = value.error
  if (error !== undefined && typeof error !== "string") fail(`${where}.error must be a string`)
  const finishedAt = value.finishedAt
  if (finishedAt !== undefined && typeof finishedAt !== "number") fail(`${where}.finishedAt is invalid`)

  return {
    runID: value.runID,
    topic: value.topic,
    settings: validateSettings(value.settings),
    status: status as Status,
    createdAt: value.createdAt,
    ...(finishedAt === undefined ? {} : { finishedAt }),
    messages: value.messages.map((entry, index) => message(entry, `${where}.messages[${index}]`)),
    partial: partial(value.partial, `${where}.partial`),
    ...(transcript === undefined ? {} : { transcript }),
    ...(error === undefined ? {} : { error }),
    ...(errorKind === undefined ? {} : { errorKind: errorKind as Run["errorKind"] }),
    ...(usage(value.usage, `${where}.usage`) === undefined ? {} : { usage: value.usage as Usage }),
  }
}

export function parseState(value: unknown): StoredState {
  if (!isRecord(value)) fail("state must be an object")
  if (value.version !== VERSION) fail(`unsupported state version: ${String(value.version)}`)
  if (value.settings !== undefined && value.settings !== null) validateSettings(value.settings)
  if (typeof value.revision !== "number" || !Number.isFinite(value.revision) || value.revision < 0) {
    fail("state.revision is required")
  }
  if (!isRecord(value.sessions)) fail("state.sessions must be an object")

  const sessions: Record<string, SessionRecord> = {}
  for (const [key, raw] of Object.entries(value.sessions)) {
    if (!isRecord(raw)) fail(`session ${key} must be an object`)
    if (typeof raw.location !== "string" || !raw.location) fail(`session ${key}.location is required`)
    if (typeof raw.sessionID !== "string" || !raw.sessionID) fail(`session ${key}.sessionID is required`)
    if (raw.settings !== null && raw.settings !== undefined && typeof raw.settings !== "object") {
      fail(`session ${key}.settings is invalid`)
    }
    if (!Array.isArray(raw.runs)) fail(`session ${key}.runs must be an array`)
    sessions[key] = {
      location: raw.location,
      sessionID: raw.sessionID,
      settings: raw.settings == null ? null : validateSettings(raw.settings),
      runs: raw.runs.map((run, index) => validateRun(run, `session ${key}.runs[${index}]`)),
    }
  }

  let last: Settings | null = null
  try {
    last = value.last == null ? null : validateSettings(value.last)
  } catch {
    last = null // a bad suggestion is dropped, it never blocks loading
  }
  return { version: VERSION, revision: value.revision, sessions, ...(last ? { last } : {}) }
}

export function emptyState(): StoredState {
  return { version: VERSION, revision: 0, sessions: {} }
}

export type OpenResult =
  | { state: StoredState; corrupt: false }
  | { state: StoredState; corrupt: true; error: string; raw: unknown }

export async function openState(storage: Storage, key = LEGACY_STATE_KEY): Promise<OpenResult & { missing: boolean }> {
  let raw: unknown
  try {
    raw = await storage.get(key)
  } catch (error) {
    return { state: emptyState(), corrupt: true, error: `storage read failed: ${String(error)}`, raw: undefined, missing: false }
  }
  if (raw === undefined || raw === null) return { state: emptyState(), corrupt: false, missing: true }
  try {
    return { state: parseState(raw), corrupt: false, missing: false }
  } catch (error) {
    return { state: emptyState(), corrupt: true, error: String((error as Error)?.message ?? error), raw, missing: false }
  }
}

export type OpenOptions = {
  /**
   * The plugin instance's location. When given, state lives under a key of
   * its own (see `stateKey`). When omitted, the legacy shared key is used.
   */
  location?: string
  /**
   * Whether a session really belongs to `location`. Used once, when the
   * per-location key does not exist yet, to adopt records from the legacy
   * shared key, including records saved under the wrong location.
   */
  belongs?: (sessionID: string) => Promise<boolean>
}

const keyOf = (location: string, sessionID: string) => `${location}\u0000${sessionID}`

export type LegacyImport = {
  sessionID: string
  topic: string
  models: { a: string; b: string }
  status: string
  messages: Array<{ speaker: string; round: number; text: string; seconds?: number }>
  transcript?: string
  finishedAt?: number
}

/** Reads the pre-server snapshot shape without trusting it. Never throws. */
export function legacyCandidates(raw: unknown): LegacyImport[] {
  if (!isRecord(raw) || !isRecord(raw.sessions)) return []
  const result: LegacyImport[] = []
  for (const [sessionID, value] of Object.entries(raw.sessions)) {
    if (!isRecord(value) || !isRecord(value.models)) continue
    const models = value.models
    if (typeof models.a !== "string" || typeof models.b !== "string") continue
    if (typeof value.topic !== "string" || !value.topic.trim()) continue
    if (!Array.isArray(value.messages)) continue
    const messages = value.messages
      .filter(isRecord)
      .filter((entry) => typeof entry.text === "string" && typeof entry.round === "number")
      .map((entry) => ({
        speaker: String(entry.speaker ?? ""),
        round: entry.round as number,
        text: entry.text as string,
        ...(typeof entry.seconds === "number" ? { seconds: entry.seconds } : {}),
      }))
    result.push({
      sessionID,
      topic: value.topic,
      models: { a: models.a, b: models.b },
      status: String(value.status ?? "completed"),
      messages,
      ...(typeof value.transcript === "string" ? { transcript: value.transcript } : {}),
      ...(typeof value.finishedAt === "number" ? { finishedAt: value.finishedAt } : {}),
    })
  }
  return result
}

function legacyModel(spec: string): ModelRef | null {
  const index = spec.indexOf(":")
  if (index <= 0 || index === spec.length - 1) return null
  return { providerID: spec.slice(0, index), modelID: spec.slice(index + 1) }
}

export class DiscussionStore {
  #storage: Storage
  #key: string
  #state: StoredState
  #queue: Promise<void> = Promise.resolve()
  readonly corrupt: boolean
  readonly corruptReason?: string
  recoveredRuns = 0
  migratedSessions = 0

  private constructor(storage: Storage, key: string, state: StoredState, corrupt: boolean, reason?: string) {
    this.#storage = storage
    this.#key = key
    this.#state = state
    this.corrupt = corrupt
    this.corruptReason = reason
  }

  static async open(storage: Storage, options: OpenOptions = {}): Promise<DiscussionStore> {
    const key = options.location ? stateKey(options.location) : LEGACY_STATE_KEY
    const opened = await openState(storage, key)
    const store = new DiscussionStore(storage, key, opened.state, opened.corrupt, opened.corrupt ? opened.error : undefined)

    if (opened.missing && options.location && options.belongs) {
      await store.#adoptLegacy(options.location, options.belongs)
    }

    if (opened.corrupt && opened.raw !== undefined) {
      // Keep the unreadable snapshot under a separate key; the original is only
      // replaced after a successful user action.
      try {
        await storage.set(`${key}.corrupt-${Date.now()}`, opened.raw)
      } catch {
        /* best effort; the original key is still untouched */
      }
    }

    const now = Date.now()
    for (const record of Object.values(store.#state.sessions)) {
      for (const run of record.runs) {
        if (run.status !== "running") continue
        run.status = "cancelled"
        run.error = "interrupted by restart"
        run.errorKind = "restart"
        run.finishedAt = now
        run.partial = null
        store.recoveredRuns += 1
      }
    }
    if (store.recoveredRuns > 0 || store.migratedSessions > 0) {
      store.#state.revision += 1
      store.#schedule()
    }
    return store
  }

  /**
   * Copies this location's sessions out of the legacy shared key. A record is
   * adopted when the host confirms the session lives here, whatever location
   * the record itself claims (earlier builds could file a session under the
   * wrong one). The legacy key is read only and stays as a backup.
   */
  async #adoptLegacy(location: string, belongs: (sessionID: string) => Promise<boolean>): Promise<void> {
    let legacy: StoredState
    try {
      const raw = await this.#storage.get(LEGACY_STATE_KEY)
      if (raw === undefined || raw === null) return
      legacy = parseState(raw)
    } catch {
      return
    }
    for (const record of Object.values(legacy.sessions)) {
      let mine = false
      try {
        mine = await belongs(record.sessionID)
      } catch {
        mine = false
      }
      if (!mine) continue
      const target = this.#record(location, record.sessionID)
      if (!target.settings && record.settings) target.settings = record.settings
      if (record.settings) this.#state.last = structuredClone(record.settings)
      const known = new Set(target.runs.map((run) => run.runID))
      for (const run of record.runs) if (!known.has(run.runID)) target.runs.push(run)
      target.runs.sort((left, right) => left.createdAt - right.createdAt)
      this.migratedSessions += 1
    }
  }

  get revision(): number {
    return this.#state.revision
  }

  session(location: string, sessionID: string): SessionRecord {
    return (
      this.#state.sessions[keyOf(location, sessionID)] ?? {
        location,
        sessionID,
        settings: null,
        runs: [],
      }
    )
  }

  run(location: string, sessionID: string, runID: string): Run | undefined {
    return this.session(location, sessionID).runs.find((run) => run.runID === runID)
  }

  activeRun(location: string, sessionID: string): Run | undefined {
    return this.session(location, sessionID).runs.find((run) => run.status === "running")
  }

  setSettings(location: string, sessionID: string, settings: Settings): number {
    const checked = validateSettings(settings)
    const record = this.#record(location, sessionID)
    record.settings = checked
    this.#state.last = structuredClone(checked)
    return this.#touch()
  }

  /** The last settings saved in this location, to offer to a new session. */
  lastSettings(): Settings | null {
    if (this.#state.last) return structuredClone(this.#state.last)
    // State written before `last` existed: fall back to the newest run's settings.
    let newest: Run | undefined
    for (const record of Object.values(this.#state.sessions)) {
      for (const run of record.runs) if (!newest || run.createdAt > newest.createdAt) newest = run
    }
    return newest ? structuredClone(newest.settings) : null
  }

  startRun(location: string, sessionID: string, topic: string): Run {
    const record = this.#record(location, sessionID)
    const settings = record.settings
    if (!settings) fail("invalid_settings: no models selected")
    if (!topic.trim()) fail("invalid_settings: a topic is required")
    const run: Run = {
      runID: randomUUID(),
      topic: topic.trim(),
      settings,
      status: "running",
      createdAt: Date.now(),
      messages: [],
      partial: null,
    }
    record.runs.push(run)
    this.#touch()
    return run
  }

  appendMessage(location: string, sessionID: string, runID: string, entry: Omit<Message, "label">): number {
    const run = this.#requireRun(location, sessionID, runID)
    run.messages.push({ ...entry, label: speakerLabel(entry.speaker, run.settings) })
    run.partial = null
    return this.#touch()
  }

  setPartial(location: string, sessionID: string, runID: string, value: PartialMessage | null): number {
    const run = this.#requireRun(location, sessionID, runID)
    run.partial = value
    return this.#touch()
  }

  setTranscript(location: string, sessionID: string, runID: string, path: string): number {
    const run = this.#requireRun(location, sessionID, runID)
    run.transcript = path
    return this.#touch()
  }

  /** Records a non-terminal problem while the run continues. */
  setError(location: string, sessionID: string, runID: string, error: string, kind: Run["errorKind"] = "provider"): number {
    const run = this.#requireRun(location, sessionID, runID)
    run.error = error
    run.errorKind = kind
    return this.#touch()
  }

  setUsage(location: string, sessionID: string, runID: string, value: Usage): number {
    const run = this.#requireRun(location, sessionID, runID)
    run.usage = { ...run.usage, ...value }
    return this.#touch()
  }

  /** Adds one turn's tokens and cost to the run's totals. */
  addUsage(location: string, sessionID: string, runID: string, value: StepUsage): number {
    const run = this.#requireRun(location, sessionID, runID)
    run.usage = addUsage(run.usage, value)
    return this.#touch()
  }

  /** Adds model requests to the run's count; unlike setUsage this sums. */
  addRequests(location: string, sessionID: string, runID: string, count: number): number {
    if (!Number.isInteger(count) || count <= 0) return this.#state.revision
    const run = this.#requireRun(location, sessionID, runID)
    run.usage = { ...run.usage, requests: (run.usage?.requests ?? 0) + count }
    return this.#touch()
  }

  failRun(location: string, sessionID: string, runID: string, error: string, kind: Run["errorKind"] = "provider"): number {
    const run = this.#requireRun(location, sessionID, runID)
    run.status = "failed"
    run.error = error
    run.errorKind = kind
    run.partial = null
    run.finishedAt = Date.now()
    return this.#touch()
  }

  finishRun(location: string, sessionID: string, runID: string, status: Exclude<Status, "idle" | "running">): number {
    const run = this.#requireRun(location, sessionID, runID)
    if (run.status !== "running") return this.#state.revision
    run.status = status
    if (status !== "cancelled") run.partial = null
    run.finishedAt = Date.now()
    if (status === "cancelled" && !run.error) {
      run.error = "stopped by user"
      run.errorKind = "cancelled"
    }
    return this.#touch()
  }

  async flush(): Promise<void> {
    await this.#queue
  }

  /**
   * Imports the pre-server snapshot for sessions the caller can verify. Read-only
   * with respect to the legacy source: the caller keeps its own backup.
   */
  importLegacy(
    raw: unknown,
    verify: (sessionID: string) => string | null,
    rounds = 2,
    maxOutputTokens = 1200,
  ): { imported: number; skipped: number } {
    let imported = 0
    let skipped = 0
    for (const candidate of legacyCandidates(raw)) {
      const location = verify(candidate.sessionID)
      if (!location) {
        skipped += 1
        continue
      }
      const existing = this.session(location, candidate.sessionID)
      if (
        existing.runs.some(
          (run) => run.runID.startsWith(`legacy-${candidate.sessionID}-`) && run.topic === candidate.topic,
        )
      ) {
        skipped += 1
        continue
      }
      const a = legacyModel(candidate.models.a)
      const b = legacyModel(candidate.models.b)
      if (!a || !b) {
        skipped += 1
        continue
      }
      const labels = { a: candidate.models.a, b: candidate.models.b }
      const roster = candidate.messages
        .map((entry) => entry.speaker)
        .filter((speaker) => speaker !== "Тема" && speaker !== "Человек" && speaker.trim() !== "")
      const order = [...new Set(roster)]
      const messages = candidate.messages.map((entry) => {
        const index = entry.speaker === "Тема" ? -2 : entry.speaker === "Человек" ? -1 : order.indexOf(entry.speaker)
        const speaker =
          index === 0 ? ("a" as const)
          : index === 1 ? ("b" as const)
          : index === -2 ? ("topic" as const)
          : ("human" as const)
        return {
          speaker,
          label:
            speaker === "a" ? labels.a
            : speaker === "b" ? labels.b
            : speaker === "human" && entry.speaker !== "Человек" ? entry.speaker
            : speaker,
          round: entry.round,
          text: entry.text,
          ...(entry.seconds === undefined ? {} : { seconds: entry.seconds }),
        }
      })
      const settings: Settings = { a, b, mode: "cooperative", rounds, maxOutputTokens }
      const record = this.#record(location, candidate.sessionID)
      record.runs.push({
        runID: `legacy-${candidate.sessionID}-${record.runs.length}`,
        topic: candidate.topic,
        settings,
        status: candidate.status === "cancelled" || candidate.status === "failed" ? candidate.status : "completed",
        createdAt: candidate.finishedAt ?? Date.now(),
        finishedAt: candidate.finishedAt ?? Date.now(),
        messages,
        partial: null,
        ...(candidate.transcript ? { transcript: candidate.transcript } : {}),
      })
      imported += 1
    }
    if (imported > 0) this.#touch()
    return { imported, skipped }
  }

  #record(location: string, sessionID: string): SessionRecord {
    const key = keyOf(location, sessionID)
    const existing = this.#state.sessions[key]
    if (existing) return existing
    const created: SessionRecord = { location, sessionID, settings: null, runs: [] }
    this.#state.sessions[key] = created
    return created
  }

  #requireRun(location: string, sessionID: string, runID: string): Run {
    const run = this.run(location, sessionID, runID)
    if (!run) fail(`not_found: run ${runID}`)
    return run
  }

  #touch(): number {
    this.#state.revision += 1
    this.#schedule()
    return this.#state.revision
  }

  #schedule(): void {
    const snapshot = structuredClone(this.#state)
    this.#queue = this.#queue
      .then(() => this.#storage.set(this.#key, snapshot))
      .catch(() => {
        /* persistence is retried by the next write; the service reports failures separately */
      })
  }
}
