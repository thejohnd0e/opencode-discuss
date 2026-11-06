import { Plugin } from "@opencode/plugin/tui"
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { activate } from "../../dist/tui.js"

let currentRun: { cancel: () => void } | null = null

export default Plugin.define({
  id: "opencode-discuss-live",
  async setup(context) {
    const output = process.env.DISCUSS_LOG
    const directory = process.env.DISCUSS_DIRECTORY
    const probe = process.env.DISCUSS_PROBE ?? "main"
    if (!output || !directory) throw new Error("Isolated runner required")

    currentRun?.cancel()
    const run = { cancelled: false }
    currentRun = { cancel: () => { run.cancelled = true } }

    let disposed = false
    let sessionA: string | undefined
    let sessionB: string | undefined
    const log = (stage: string, details: Record<string, unknown> = {}) =>
      appendFileSync(output, JSON.stringify({ stage, ...details }) + "\n")
    const pause = async (ms = 80) => {
      await new Promise((resolve) => setTimeout(resolve, ms))
      if (disposed || run.cancelled) throw new Error("cancelled")
    }
    const wait = async (predicate: () => boolean, label: string, tries = 600) => {
      for (let i = 0; i < tries; i++) {
        if (predicate()) return
        await pause(100)
      }
      throw new Error(`timeout: ${label}`)
    }
    const node = (id: string) => context.renderer.root.findDescendantById(id)
    const frame = () => {
      try {
        return context.renderer.currentRenderBuffer.getSpanLines()
          .map((line) => line.spans.map((span) => span.text).join("")).join("\n")
      } catch { return "" }
    }
    const deadline = setTimeout(() => { log("timeout", { sessionA, sessionB, probe }); process.exit(2) }, 260000)

    void (async () => {
      log("loaded", { version: context.app.version, probe })
      await pause(1500)
      context.renderer.resize(160, 60)

      const rendererReady = () => { try { return !!context.renderer.root } catch { return false } }
      await wait(rendererReady, "renderer ready")
      const core = activate(context, log)

      const createSession = async (title: string) => {
        const created = await context.client.session.create({ title, location: { directory } })
        await context.data.session.sync(created.id)
        return created.id
      }

      sessionA = await createSession("Discuss e2e A (temporary)")
      context.ui.router.navigate({ type: "session", sessionID: sessionA })
      await pause(300)
      log("session-created", { sessionA, probe })

      // restart probe only checks that persisted state came back
      if (probe === "restart") {
        const restored = core.current(sessionA)
        let persisted: any = null
        try {
          const dir = join(process.env.LOCALAPPDATA ?? process.env.XDG_STATE_HOME ?? "/tmp", "opencode-discuss")
          const raw = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"))
          persisted = Object.entries(raw.sessions ?? {}).map(([id, value]: [string, any]) => ({
            id: id.slice(0, 10), status: value.status, messages: (value.messages ?? []).length,
            topic: (value.topic ?? "").slice(0, 24), hasTranscript: !!value.transcript,
          }))
        } catch (error) { persisted = { error: String(error) } }
        log("restored", {
          newSessionStatus: restored.status,
          persistedSessions: core.count(),
          models: core.models(),
          stored: persisted,
        })
        if (sessionA) await context.client.session.remove({ sessionID: sessionA })
        core.dispose()
        log("passed")
        clearTimeout(deadline)
        process.exit(0)
      }

      if (probe === "isolated") {
        const second = await createSession("Discuss e2e B (temporary)")
        sessionB = second
        const aState = core.current(sessionA)
        const bState = core.current(second)
        context.ui.router.navigate({ type: "session", sessionID: second })
        context.ui.panel.open("discuss.panel")
        await wait(() => !!node("discuss.panel"), "panel on B")
        const emptyOnB = !node("discuss.msg.0")
        log("isolation", {
          aMessages: aState.messages.length,
          bMessages: bState.messages.length,
          bPanelEmpty: emptyOnB,
        })
        if (sessionA) await context.client.session.remove({ sessionID: sessionA })
        if (sessionB) await context.client.session.remove({ sessionID: sessionB })
        core.dispose()
        log("passed")
        clearTimeout(deadline)
        process.exit(0)
      }

      if (probe === "error") {
        context.ui.panel.open("discuss.panel")
        await wait(() => !!node("discuss.panel"), "panel")
        core.start(sessionA, "Error probe", 1)
        await wait(() => core.current(sessionA).status !== "running", "error run settled", 400)
        const value = core.current(sessionA)
        log("error-handled", { status: value.status, error: value.error ?? null, messages: value.messages.length })
        if (sessionA) await context.client.session.remove({ sessionID: sessionA })
        core.dispose()
        log("passed")
        clearTimeout(deadline)
        process.exit(0)
      }

      // main probe: real discussion, streaming, responsiveness, statuses, handoff, isolation
      context.keymap.dispatch("discuss.open")
      await wait(() => !!node("discuss.panel"), "panel visible")

      const started = Date.now()
      context.keymap.dispatch("discuss.start", "Нужна ли локальная модель для кодинга?")
      await wait(() => core.current(sessionA).status === "running", "run started")

      // 3) streaming: a partial reply must appear before the final one
      let sawPartial = false
      let sawLiveLine = false
      for (let i = 0; i < 200 && !sawPartial; i++) {
        if (core.current(sessionA).partial) {
          sawPartial = true
          sawLiveLine = !!node("discuss.msg.0.live") || !!node("discuss.msg.1.live")
          break
        }
        await pause(100)
      }
      log("streaming", { sawPartial, sawLiveLine })

      // 4) responsiveness while the run is active
      const frameA = frame()
      const dispatchStart = Date.now()
      for (let i = 0; i < 5; i++) context.keymap.dispatch("discuss.open")
      const dispatchMs = Date.now() - dispatchStart
      await pause(700)
      const frameB = frame()
      log("responsive", { dispatchMs, frameChanged: frameA !== frameB, stillRunning: core.current(sessionA).status === "running" })

      await wait(() => core.current(sessionA).status === "completed", "run completed", 900)
      const done = core.current(sessionA)
      const elapsed = Math.round((Date.now() - started) / 1000)
      log("completed", {
        status: done.status,
        messages: done.messages.length,
        speakers: done.messages.map((m) => m.speaker),
        transcript: done.transcript ?? null,
        seconds: elapsed,
        onScreen: !!node("discuss.msg.0") && !!node("discuss.msg.1"),
      })

      // 6) handoff summary
      const summaryPath = core.handoff(sessionA)
      await pause(200)
      log("handoff", { path: summaryPath ?? null, exists: summaryPath ? existsSync(summaryPath) : false,
                       onScreen: !!node("discuss.summary") })
      writeFileSync(output + ".frame.txt", frame())

      // 1) isolation: a second session starts empty
      const second = await createSession("Discuss e2e B (temporary)")
      sessionB = second
      context.ui.router.navigate({ type: "session", sessionID: second })
      context.ui.panel.open("discuss.panel")
      await wait(() => !!node("discuss.panel"), "panel on B")
      const bMessages = core.current(second).messages.length
      const bEmpty = !node("discuss.msg.0")
      context.ui.router.navigate({ type: "session", sessionID: sessionA })
      await pause(250)
      const aKept = core.current(sessionA).messages.length
      log("isolation", { bMessages, bPanelEmpty: bEmpty, aKept })

      // 2) cancelled status
      core.start(sessionA, "Cancellation probe", 2)
      await wait(() => core.current(sessionA).status === "running", "cancel run started")
      await pause(2500)
      context.keymap.dispatch("discuss.stop")
      await wait(() => core.current(sessionA).status !== "running", "cancel settled", 300)
      log("cancelled", { status: core.current(sessionA).status, messages: core.current(sessionA).messages.length })

      // 7) cost bound: rounds x sides x maxTokens
      const rounds = Number(context.options.rounds ?? 2)
      const maxTokens = Number(context.options.maxTokens ?? 1200)
      log("cost-bound", { rounds, maxTokens, worstCaseTokens: rounds * 2 * maxTokens })

      if (sessionA) { await context.client.session.remove({ sessionID: sessionA }); sessionA = undefined }
      if (sessionB) { await context.client.session.remove({ sessionID: sessionB }); sessionB = undefined }
      core.dispose()
      log("passed")
      clearTimeout(deadline)
      process.exit(0)
    })().catch((error) => {
      if (disposed || run.cancelled) return
      log("failed", { message: String((error as any)?.message ?? error), sessionA, sessionB, probe })
      try { writeFileSync(output + ".failure.txt", frame()) } catch { /* ignore */ }
      clearTimeout(deadline)
      process.exit(1)
    })

    return () => { disposed = true; clearTimeout(deadline) }
  },
})
