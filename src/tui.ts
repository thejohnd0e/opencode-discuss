import { Plugin } from "@opencode/plugin/tui"
import type { Context, KeymapCommand } from "@opencode/plugin/tui/context"
import { createElement, insert, setProp } from "@opentui/solid"
import { createEffect, createRoot, createSignal, getOwner, on, runWithOwner, type Owner } from "solid-js"
import { DiscussRpc } from "./rpc"
import { sessionDirectory } from "./discussion/location"
import { applySettingsArgs, checkSettingsArgs, conclusionText, describeSettings, SETTINGS_USAGE } from "./ui/settings"
import { createLog, logPath, shape } from "./ui/log"
import { textBlocks } from "./ui/markdown"
import { panelStyle, speakerRole, statusRole, type PanelStyle } from "./ui/panel-style"
import { callBound, dialogueReplies, isDialogueReply, type Run, type Settings } from "./discussion/types"
import { describeUsage, ORCHESTRATOR_NOTE } from "./discussion/usage"
import { createRefresher, viewOf, type Snapshot, type View, type Views } from "./ui/view-state"
import { choiceOf, mergeSettings, parseChoice, resolveChoice, splitArgs, toOptions, type CatalogModel, type ModelOption } from "./ui/models"

/** Long enough to read a multi-line toast. */
const TOAST_MS = 10_000

/**
 * One live generation per TUI. A hot reload (`/reload`) starts a new
 * generation of this plugin; in 2.2.5 the old one kept its effects, event
 * subscription and keymap layer alive, so every reload added another copy.
 * Generations do not share `globalThis` (verified live: every generation saw
 * none before it), so the handover goes through `storage.memory`, which the
 * host documents as shared by old and new generations of one TUI.
 */
const GENERATION_KEY = "discuss.tui.generation"
type Generation = { id: number; dispose: () => void }

/** `TextAttributes.BOLD` in @opentui/core; inlined so the TUI bundle needs no extra host module. */
const BOLD = 1 << 0

function line(id: string, text: string, color?: unknown, bold = false) {
  const node = createElement("text")
  setProp(node, "id", id)
  if (color !== undefined) setProp(node, "fg", color)
  if (bold) setProp(node, "attributes", BOLD)
  insert(node, text)
  return node
}

/** A row of differently coloured pieces, e.g. "Status: " in muted + "failed" in red. */
function row(id: string, pieces: Array<[string, unknown?, boolean?]>) {
  const box = createElement("box")
  setProp(box, "id", id)
  setProp(box, "flexDirection", "row")
  setProp(box, "flexWrap", "wrap")
  pieces.forEach(([text, color, bold], index) => insert(box, line(`${id}.${index}`, text, color, bold)))
  return box
}

/**
 * One reply: a coloured bar on the left and a header naming the side, the
 * model and the round, so it is always clear who says what.
 */
function bubble(id: string, header: Header, body: string, color: unknown, style: PanelStyle, live = false) {
  const box = createElement("box")
  setProp(box, "id", id)
  setProp(box, "flexDirection", "column")
  setProp(box, "marginTop", 1)
  setProp(box, "paddingLeft", 1)
  setProp(box, "border", ["left"])
  setProp(box, "borderStyle", live ? "single" : "heavy")
  if (color !== undefined) setProp(box, "borderColor", color)
  // Who speaks in the side colour and bold; time and "writing…" in plain grey.
  insert(box, header.meta ? row(`${id}.head`, [[header.who, color, true], [header.meta, style.muted]]) : line(`${id}.head`, header.who, color, true))
  const textColor = live ? style.muted : style.body
  // Markdown headings (the conclusion's sections) show as bold lines, not "## …".
  const blocks = textBlocks(body)
  if (blocks.length <= 1 && !blocks.some((block) => block.heading)) {
    insert(box, line(`${id}.body`, body, textColor))
    return box
  }
  blocks.forEach((block, index) => {
    if (block.heading) {
      if (index > 0) insert(box, line(`${id}.gap.${index}`, " "))
      insert(box, line(`${id}.h.${index}`, block.text, color, true))
    } else {
      insert(box, line(`${id}.t.${index}`, block.text, textColor))
    }
  })
  return box
}

type Header = { who: string; meta: string }

function sideHeader(speaker: string, label: string, round: number, seconds?: number, live = false, conclusion = false): Header {
  const meta = `${seconds ? ` · ${seconds}s` : ""}${live ? " · writing…" : ""}`
  if (conclusion) return { who: `Conclusion · written by ${speaker === "a" ? "A" : "B"} · ${label}`, meta }
  const who =
    speaker === "a" ? `A · ${label}` : speaker === "b" ? `B · ${label}` : speaker === "topic" ? "Topic change" : `You · ${label}`
  return { who: `${who} · round ${round}`, meta }
}

function modelText(settings: Settings | null): string {
  if (!settings) return "no models selected"
  return `${choiceOf(settings.a)} vs ${choiceOf(settings.b)}`
}

function packetFrom(error: unknown): string {
  const data = (error as { data?: unknown })?.data
  if (data && typeof data === "object" && "packet" in data) return String((data as { packet: unknown }).packet)
  if (data && typeof data === "string") return data
  return String((error as Error)?.message ?? error)
}

export default Plugin.define({
  id: "discuss",
  async setup(context) {
    const journal = logPath()
    const write = createLog(journal)
    let disposed = false
    const [generations, setGenerations] = context.storage.memory<{ current?: Generation; count: number }>(GENERATION_KEY, {
      initial: { count: 0 },
    })
    const previous = generations.current
    const generation = generations.count + 1
    setGenerations((draft) => {
      draft.count = generation
    })
    // Every line names its process and generation: several OpenCode windows
    // share this journal. A disposed generation stays silent.
    const log: typeof write = (stage, details) => {
      if (!disposed) write(stage, { pid: process.pid, gen: generation, ...details })
    }
    const replaced = previous?.id ?? null
    if (previous) {
      try {
        previous.dispose()
      } catch {
        /* a broken old generation must not stop the new one */
      }
    }
    log("setup", { journal, location: context.location?.directory ?? null, replaced })

    // Our effects are owned by this root, so disposing the generation stops
    // them. The panel slot and the keymap layer stay in the host's own owner:
    // `keymap.layer` needs the host's Keymap.Provider (setup failed with
    // "Keymap.Provider is missing" under our root). The slot is removed through
    // its returned function, and a disposed generation's commands return false
    // so the live generation handles them.
    let disposeRoot = () => {}
    const owner = createRoot((dispose) => {
      disposeRoot = dispose
      return getOwner()
    }) as Owner
    const owned = <T>(fn: () => T): T => runWithOwner(owner, fn) as T

    // Registered before anything else is created: if setup throws half way,
    // the next generation can still dispose what this one already started
    // (a failed setup at 12:00Z left its effects running until restart).
    const cleanups: Array<() => void> = []
    const dispose = () => {
      if (disposed) return
      log("dispose")
      disposed = true
      for (const cleanup of cleanups.splice(0).reverse()) {
        try {
          cleanup()
        } catch {
          /* already gone */
        }
      }
      disposeRoot()
      if (generations.current?.id === generation) {
        setGenerations((draft) => {
          draft.current = undefined
        })
      }
    }
    setGenerations((draft) => {
      draft.current = { id: generation, dispose }
    })
    const rpc = context.client.rpc(DiscussRpc)

    // OpenCode runs one server plugin instance per location. Without an explicit
    // location an RPC lands in the TUI's default instance (which may be the home
    // directory), while the discuss_* tools run in the session's own location,
    // so the two would see different state. Every call is therefore sent to the
    // location the session lives in.
    const locations = new Map<string, string>()
    const remember = (sessionID: string, info: unknown) => {
      const directory = sessionDirectory(info)
      if (directory) locations.set(sessionID, directory)
      return directory
    }
    const where = async (sessionID: unknown): Promise<{ location: { directory: string } } | undefined> => {
      if (typeof sessionID !== "string" || !sessionID) return undefined
      let directory = locations.get(sessionID) ?? remember(sessionID, context.data.session.get(sessionID))
      if (!directory) {
        try {
          directory = remember(sessionID, await context.client.session.get({ sessionID } as never))
        } catch (error) {
          log("location-lookup-failed", { sessionID, error: String((error as Error)?.message ?? error) })
        }
      }
      return directory ? { location: { directory } } : undefined
    }
    const discuss = new Proxy(rpc, {
      get(target, name, receiver) {
        const value = Reflect.get(target, name, receiver)
        if (name === "events" || typeof value !== "function") return value
        return async (input: { sessionID?: unknown }) => {
          const options = await where(input?.sessionID)
          const started = Date.now()
          try {
            const result = await (value as (input: unknown, options?: unknown) => Promise<unknown>).call(target, input, options)
            log("rpc", { method: String(name), sessionID: input?.sessionID ?? null, location: options?.location.directory ?? null, ok: true, ms: Date.now() - started })
            return result
          } catch (error) {
            log("rpc", {
              method: String(name),
              sessionID: input?.sessionID ?? null,
              location: options?.location.directory ?? null,
              ok: false,
              ms: Date.now() - started,
              code: (error as { code?: unknown })?.code ?? null,
              error: String((error as Error)?.message ?? error),
            })
            throw error
          }
        }
      },
    }) as typeof rpc
    const host = context.ui.dialog
    const dialog = {
      prompt: (async (options: Parameters<typeof host.prompt>[0]) => {
        log("dialog-open", { kind: "prompt", title: options.title })
        const result = await host.prompt(options)
        log("dialog-close", { kind: "prompt", title: options.title, result: shape(result) })
        return result
      }) as typeof host.prompt,
      select: (async (options: Parameters<typeof host.select>[0]) => {
        log("dialog-open", { kind: "select", title: options.title })
        const result = await host.select(options)
        log("dialog-close", { kind: "select", title: options.title, result: result ? String(result) : "none" })
        return result
      }) as typeof host.select,
      confirm: (async (options: Parameters<typeof host.confirm>[0]) => {
        log("dialog-open", { kind: "confirm", title: options.title })
        const result = await host.confirm(options)
        log("dialog-close", { kind: "confirm", title: options.title, result: Boolean(result) })
        return result
      }) as typeof host.confirm,
    }

    const show = (options: { title?: string; message: string; variant?: "info" | "success" | "warning" | "error"; duration?: number }) => {
      log("toast", { variant: options.variant ?? "info", message: options.message })
      context.ui.toast.show({ duration: TOAST_MS, ...options })
    }

    const [views, setViews] = createSignal<Views>({})

    const view = (sessionID: string): View => viewOf(views(), sessionID)

    const refresher = createRefresher({
      fetch: async (sessionID) => (await discuss.snapshot({ sessionID })) as unknown as Snapshot,
      get: views,
      set: setViews,
      isDisposed: () => disposed,
      onError: (sessionID, error) => log("refresh-failed", { sessionID, error: String((error as Error)?.message ?? error) }),
    })
    const refresh = refresher.refresh

    const sessionOf = (): string | undefined => {
      const route = context.ui.router.current() as { sessionID?: string } | undefined
      return typeof route?.sessionID === "string" ? route.sessionID : undefined
    }

    // Setup commands (panel, models, start) work from the home screen: they
    // create an empty Discuss session and open it. Creating a session sends no
    // message and makes no model call. If that fails, the user is told why
    // instead of the command silently doing nothing.
    const ensureSession = async (): Promise<string | undefined> => {
      const existing = sessionOf()
      if (existing) return existing
      try {
        const model = context.ui.model.current()
        const created = await context.client.session.create({
          title: "Discuss",
          agent: "discuss",
          ...(model ? { model: { providerID: model.providerID, id: model.modelID, ...(model.variant ? { variant: model.variant } : {}) } } : {}),
          ...(context.location ? { location: context.location } : {}),
        } as Parameters<typeof context.client.session.create>[0])
        const sessionID = (created as { id: string }).id
        remember(sessionID, created)
        context.ui.router.navigate({ type: "session", sessionID })
        log("session-created", { sessionID })
        return sessionID
      } catch (error) {
        toast(`Open or start a session first (could not create one: ${String((error as Error)?.message ?? error)})`, "warning")
        return undefined
      }
    }

    // The session panel can only open once the router shows the new session.
    const openPanel = async (sessionID: string) => {
      for (let attempt = 0; attempt < 10; attempt++) {
        const route = sessionOf()
        const opened = route === sessionID && context.ui.panel.open("discuss.panel")
        if (opened || attempt === 0 || attempt === 9) log("panel-open", { sessionID, route: route ?? null, attempt, opened })
        if (opened) return
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      toast("The Discuss panel could not be opened; run /discuss again", "warning")
    }

    owned(() => createEffect(
      on(
        () => (context.ui.router.current() as { sessionID?: string } | undefined)?.sessionID,
        (sessionID) => {
          if (sessionID) void refresh(sessionID)
        },
        { defer: true },
      ),
    ))

    owned(() => createEffect(
      on(
        () => {
          const current = context.ui.panel.current()
          return current ? `${current.name}\u0000${current.sessionID}` : ""
        },
        (value, previous) => {
          if (value === previous) return
          const [name, sessionID] = value ? value.split("\u0000") : [null, null]
          log("panel-current", { name, sessionID })
        },
      ),
    ))
    owned(() => createEffect(
      on(
        () => JSON.stringify(context.ui.router.current() ?? null),
        (route) => log("route", { route: JSON.parse(route) }),
      ),
    ))

    cleanups.push(() => {
      refresher.cancel()
    })
    const stopEvents = discuss.events.on("updated", (event) => {
      const data = event.data as { sessionID?: string; revision?: number }
      refresher.onUpdated(data?.sessionID, data?.revision)
    })

    cleanups.push(() => stopEvents())
    const removeSlot = context.ui.slot({
      append: "session.panel",
      render: (panel) => {
        if (panel.name !== "discuss.panel") return null
        const value = view(panel.sessionID)
        const run = value.run
        const style = panelStyle(context.theme, context.themeMode)
        const box = createElement("scrollbox")
        setProp(box, "id", "discuss.panel")
        setProp(box, "flexDirection", "column")
        setProp(box, "paddingLeft", 1)
        setProp(box, "paddingRight", 1)
        setProp(box, "flexGrow", 1)

        const settings = run?.settings ?? value.settings
        const expected = settings ? dialogueReplies(settings) : 0
        const replies = run ? run.messages.filter(isDialogueReply).length : 0
        insert(
          box,
          row("discuss.header", [
            ["Discuss", style.title, true],
            ["  ", undefined],
            [run?.status ?? "idle", style[statusRole(run?.status)], true],
            [settings ? `  ${replies}/${expected} replies` : "  no models", style.muted],
          ]),
        )
        insert(box, row("discuss.topic", [["Topic  ", style.label], [run?.topic ?? "—", style.value]]))
        if (settings) {
          insert(box, row("discuss.model-a", [["A  ", style.a, true], [choiceOf(settings.a), style.a]]))
          insert(box, row("discuss.model-b", [["B  ", style.b, true], [choiceOf(settings.b), style.b]]))
          insert(
            box,
            line(
              "discuss.settings",
              `${settings.mode} · ${settings.rounds} round${settings.rounds === 1 ? "" : "s"} · max ${settings.maxOutputTokens} tokens per reply${settings.conclusion === "a" || settings.conclusion === "b" ? ` · ${conclusionText(settings)}` : ""}`,
              style.muted,
            ),
          )
        } else {
          insert(box, line("discuss.settings", "Choose a pair: /discuss-models", style.warning))
        }

        if (!run || (!run.messages.length && !run.partial)) {
          insert(box, line("discuss.empty", "No replies yet. Start with /discuss-start <topic>.", style.faint))
        }
        run?.messages.forEach((message, index) => {
          const conclusion = message.kind === "conclusion"
          const color = conclusion ? style.success : style[speakerRole(message.speaker)]
          insert(box, bubble(`discuss.msg.${index}`, sideHeader(message.speaker, message.label, message.round, message.seconds, false, conclusion), message.text, color, style))
        })
        if (run?.partial) {
          const conclusion = run.partial.kind === "conclusion"
          const color = conclusion ? style.success : style[speakerRole(run.partial.speaker)]
          insert(box, bubble("discuss.msg.live", sideHeader(run.partial.speaker, run.partial.label, run.partial.round, undefined, true, conclusion), run.partial.text, color, style, true))
        }

        const footer: Array<unknown> = []
        if (run?.usage?.requests) {
          const planned = callBound(run.settings).participantCalls
          const over = run.usage.requests > planned
          footer.push(line("discuss.requests", `Model requests: ${run.usage.requests} of ${planned} planned${over ? " — more than planned" : ""}`, over ? style.warning : style.muted))
        }
        if (run) {
          const known = describeUsage(run.usage)
          // While a run is in progress, "unknown" only means no turn has finished yet.
          if (known !== "unknown" || run.status !== "running") {
            footer.push(row("discuss.usage", [["Usage  ", style.label], [known, style.muted]]))
            footer.push(line("discuss.usage.note", ORCHESTRATOR_NOTE, style.faint))
          }
        }
        if (run?.error) footer.push(row("discuss.error", [["Error  ", style.error, true], [run.error, style.error]]))
        if (run?.transcript) footer.push(row("discuss.transcript", [["Transcript  ", style.label], [run.transcript, style.faint]]))
        if (value.runs.length > 1) footer.push(line("discuss.history", `Earlier runs: ${value.runs.length - 1}`, style.faint))
        if (footer.length) {
          const spacer = line("discuss.spacer", " ")
          insert(box, spacer)
          for (const node of footer) insert(box, node as never)
        }
        insert(box, line("discuss.footer.spacer", " "))
        insert(
          box,
          line(
            "discuss.footer",
            run?.status === "running"
              ? "/discuss-stop · /discuss-interject <text> · /discuss-topic <text> · /discuss closes this panel"
              : "/discuss-start <topic> · /discuss-restart · /discuss-handoff · /discuss-models · /discuss-settings · /discuss closes this panel",
            style.faint,
          ),
        )
        return box
      },
    })
    cleanups.push(() => removeSlot())

    const toast = (message: string, variant: "error" | "warning" | "success" = "error") =>
      show({ title: "Discuss", message, variant })

    const catalog = async (sessionID: string): Promise<ModelOption[] | undefined> => {
      try {
        const listed = (await discuss.models({ sessionID })) as unknown as { models: CatalogModel[] }
        const options = toOptions(listed.models)
        if (options.length === 0) {
          toast("No chat models are available", "warning")
          return undefined
        }
        return options
      } catch (error) {
        toast(String((error as Error)?.message ?? error))
        return undefined
      }
    }

    // A typed reference resolves directly; an ambiguous one opens the selector
    // narrowed to its matches; no reference opens the full selector.
    const chooseSide = async (side: "A" | "B", options: ModelOption[], query?: string): Promise<string | undefined> => {
      const title = `Discuss: model ${side}`
      if (!query) return (await dialog.select({ title, options })) || undefined
      const found = resolveChoice(query, options)
      if (found.ok) return found.value
      if (found.reason === "ambiguous") {
        return (await dialog.select({ title: `${title} · “${query}”: ${found.matches.length} matches`, options: found.matches })) || undefined
      }
      toast(
        found.reason === "unavailable"
          ? `Model ${side}: “${query}” is disabled or not a chat model`
          : `Model ${side}: nothing matches “${query}”. Use provider/model[#variant]; /discuss-models opens the list.`,
      )
      return undefined
    }

    // A new session has no pair. If this location has one from before, offer it
    // as an explicit first choice; nothing is applied unless the user picks it.
    const offerLast = async (sessionID: string): Promise<"saved" | "used" | "choose" | "cancel"> => {
      let got: { settings: Settings | null; last?: Settings | null }
      try {
        got = (await discuss.settingsGet({ sessionID })) as unknown as { settings: Settings | null; last?: Settings | null }
      } catch (error) {
        toast(String((error as Error)?.message ?? error))
        return "cancel"
      }
      if (got.settings) return "saved"
      if (!got.last) return "choose"
      const last = got.last
      const choice = await dialog.select({
        title: "Discuss: models for this session",
        options: [
          { title: `Use previous pair: ${modelText(last)}`, value: "last", description: describeSettings(last) },
          { title: "Choose models…", value: "choose", description: "Pick model A, then model B" },
        ],
      })
      if (!choice) return "cancel"
      if (choice !== "last") return "choose"
      try {
        await discuss.settingsSet({ sessionID, settings: last })
        await refresh(sessionID)
        toast(`Models: ${modelText(last)}\n${describeSettings(last)}`, "success")
        return "used"
      } catch (error) {
        toast(String((error as Error)?.message ?? error))
        return "cancel"
      }
    }

    // Typed arguments are the user's explicit choice and are saved directly.
    // Any step that went through a selector ends with a confirmation.
    const pickModels = async (sessionID: string, queries: { a?: string; b?: string; keep?: "a" | "b" } = {}) => {
      const options = await catalog(sessionID)
      if (!options) return
      const saved = view(sessionID).settings ?? ((await discuss.settingsGet({ sessionID })) as unknown as { settings: Settings | null }).settings

      // Keeping a side only works when a pair is already saved; otherwise that
      // side is chosen in the selector.
      const keepA = queries.keep === "a" && saved
      const keepB = queries.keep === "b" && saved
      const first = keepA ? choiceOf(saved.a) : await chooseSide("A", options, queries.a)
      if (!first) return
      const second = keepB ? choiceOf(saved.b) : await chooseSide("B", options, queries.b)
      if (!second) return
      const typed = Boolean(keepA || queries.a) && Boolean(keepB || queries.b)

      const current: Settings = saved ?? {
        a: parseChoice(first),
        b: parseChoice(second),
        mode: "cooperative",
        rounds: 2,
        maxOutputTokens: 1200,
      }
      const merged = mergeSettings(current, parseChoice(first), parseChoice(second))
      const summary = [
        `A: ${choiceOf(merged.a)}`,
        `B: ${choiceOf(merged.b)}`,
        `Mode: ${merged.mode} · rounds: ${merged.rounds} · max output: ${merged.maxOutputTokens}`,
        "Both participants see the topic and each other's replies.",
        `Hard ceiling: ${callBound(merged).participantCalls} participant calls, ${callBound(merged).worstCaseOutputTokens} output tokens. Input, reasoning and this conversation cost extra.`,
      ].join("\n")
      if (!typed) {
        const confirmed = await dialog.confirm({
          title: "Discuss models",
          message: summary,
          label: { confirm: "Use pair", cancel: "Cancel" },
        })
        if (!confirmed) return
      }
      try {
        await discuss.settingsSet({ sessionID, settings: merged })
        await refresh(sessionID)
        show({ title: "Discuss", message: `Models: ${modelText(merged)}`, variant: "success" })
      } catch (error) {
        show({ title: "Discuss", message: String((error as Error)?.message ?? error), variant: "error" })
      }
    }

    const start = async (sessionID: string, topic: string) => {
      try {
        const result = (await discuss.start({
          sessionID,
          topic,
          requestID: `tui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        })) as unknown as { runID: string }
        await refresh(sessionID)
        log("started", { runID: result.runID })
        // A run with the panel closed looks like nothing happened (live, run 31b91540):
        // show it, and say so.
        const current = context.ui.panel.current()
        if (!current || current.name !== "discuss.panel" || current.sessionID !== sessionID) await openPanel(sessionID)
        toast("Discussion started. /discuss-stop stops it, /discuss closes the panel.", "success")
      } catch (error) {
        show({ title: "Discuss", message: String((error as Error)?.message ?? error), variant: "error" })
      }
    }

    // The view can lag behind by a refresh; controls read the server's state.
    const currentRun = async (sessionID: string) => {
      await refresh(sessionID)
      return view(sessionID).run
    }
    const activeRun = async (sessionID: string) => {
      const run = await currentRun(sessionID)
      if (run && run.status === "running") return run
      toast("No discussion is running in this session", "warning")
      return undefined
    }

    const journaled = (command: KeymapCommand): KeymapCommand => ({
      ...command,
      run: (input, event) => {
        if (disposed) return false
        log("command", { id: command.id, args: shape(input), route: sessionOf() ?? "home" })
        try {
          const result = command.run(input, event)
          if (result instanceof Promise) {
            return result.catch((error: unknown) => {
              log("command-failed", { id: command.id, error: String((error as Error)?.message ?? error) })
              throw error
            })
          }
          return result
        } catch (error) {
          log("command-failed", { id: command.id, error: String((error as Error)?.message ?? error) })
          throw error
        }
      },
    })

    context.keymap.layer(() => ({
      mode: "global",
      commands: ([
        {
          id: "discuss.open",
          title: "Discuss: open or close the panel",
          group: "Discuss",
          palette: true,
          slash: { name: "discuss" },
          run: async () => {
            if (context.ui.panel.current()?.name === "discuss.panel") {
              context.ui.panel.close()
              log("panel-close", { via: "toggle" })
              return
            }
            const sessionID = await ensureSession()
            if (!sessionID) return
            void refresh(sessionID)
            await openPanel(sessionID)
          },
        },
        {
          id: "discuss.close",
          title: "Discuss: close the panel",
          group: "Discuss",
          palette: true,
          slash: { name: "discuss-close" },
          run: () => {
            if (context.ui.panel.current()?.name !== "discuss.panel") return void toast("The Discuss panel is not open", "warning")
            context.ui.panel.close()
            log("panel-close", { via: "command" })
          },
        },
        {
          id: "discuss.models",
          title: "Discuss: choose the two models",
          group: "Discuss",
          palette: true,
          slash: { name: "discuss-models", arguments: true },
          // /discuss-models               → selector for A, then B, then confirm
          // /discuss-models <A>           → A typed, selector for B
          // /discuss-models <A> <B>       → both typed, saved directly
          run: async (input) => {
            const args = splitArgs(input)
            if (args.length > 2) {
              toast("Usage: /discuss-models [<A> [<B>]] — e.g. /discuss-models provider/model provider/other#high", "warning")
              return
            }
            const sessionID = await ensureSession()
            if (!sessionID) return
            if (args.length === 0) {
              const offered = await offerLast(sessionID)
              if (offered === "used" || offered === "cancel") return
            }
            await pickModels(sessionID, { a: args[0], b: args[1] })
          },
        },
        {
          id: "discuss.model-a",
          title: "Discuss: change model A only",
          group: "Discuss",
          palette: true,
          slash: { name: "discuss-model-a", arguments: true },
          run: async (input) => {
            const args = splitArgs(input)
            if (args.length > 1) return void toast("Usage: /discuss-model-a <provider/model[#variant]>", "warning")
            const sessionID = await ensureSession()
            if (!sessionID) return
            await pickModels(sessionID, { a: args[0], keep: "b" })
          },
        },
        {
          id: "discuss.model-b",
          title: "Discuss: change model B only",
          group: "Discuss",
          palette: true,
          slash: { name: "discuss-model-b", arguments: true },
          run: async (input) => {
            const args = splitArgs(input)
            if (args.length > 1) return void toast("Usage: /discuss-model-b <provider/model[#variant]>", "warning")
            const sessionID = await ensureSession()
            if (!sessionID) return
            await pickModels(sessionID, { b: args[0], keep: "a" })
          },
        },
        {
          id: "discuss.settings",
          title: "Discuss: rounds, output limit and mode",
          group: "Discuss",
          palette: true,
          slash: { name: "discuss-settings", arguments: true },
          // /discuss-settings                       → show current settings
          // /discuss-settings rounds=1 tokens=300   → change, keep models
          run: async (input) => {
            const args = splitArgs(input)
            const sessionID = await ensureSession()
            if (!sessionID) return
            let saved: Settings | null
            try {
              saved = ((await discuss.settingsGet({ sessionID })) as unknown as { settings: Settings | null }).settings
            } catch (error) {
              return void toast(String((error as Error)?.message ?? error))
            }
            if (!saved) {
              // No pair in this session yet (e.g. a new session after a restart).
              // Check the arguments first, then get a pair the usual way (offer
              // the previous pair, or choose), and apply the arguments on top, so
              // the typed rounds/tokens are not lost (live finding 2026-11-06).
              if (args.length > 0) {
                const problem = checkSettingsArgs(args)
                if (problem) return void toast(problem, "warning")
              }
              const offered = await offerLast(sessionID)
              if (offered === "cancel") return void toast("Settings not changed: no models chosen for this session.", "warning")
              if (offered === "choose") await pickModels(sessionID)
              try {
                saved = ((await discuss.settingsGet({ sessionID })) as unknown as { settings: Settings | null }).settings
              } catch (error) {
                return void toast(String((error as Error)?.message ?? error))
              }
              if (!saved) return void toast("Settings not changed: no models chosen for this session.", "warning")
            }
            if (args.length === 0) {
              return void toast(`${modelText(saved)}\n${describeSettings(saved)}\n${SETTINGS_USAGE}`, "success")
            }
            const change = applySettingsArgs(args, saved)
            if (!change.ok) return void toast(change.reason, "warning")
            try {
              await discuss.settingsSet({ sessionID, settings: change.settings })
              await refresh(sessionID)
              toast(`Discuss: ${change.changed.join(", ")}\n${describeSettings(change.settings)}`, "success")
            } catch (error) {
              toast(String((error as Error)?.message ?? error))
            }
          },
        },
        {
          id: "discuss.start",
          title: "Discuss: start a discussion",
          group: "Discuss",
          palette: true,
          slash: { name: "discuss-start", arguments: true },
          run: async (input) => {
            // Ask for the topic first so cancelling on the home screen leaves no empty session.
            const topic = (typeof input === "string" && input.trim()) || (await dialog.prompt({ title: "Discussion topic", placeholder: "What should the two agents discuss?" }))
            if (!topic) return void toast("Not started: no topic entered. Try /discuss-start <topic>.", "warning")
            const sessionID = await ensureSession()
            if (!sessionID) return
            const read = async () =>
              ((await discuss.settingsGet({ sessionID })) as unknown as { settings: Settings | null }).settings
            let settings = view(sessionID).settings ?? (await read())
            if (!settings) {
              const offered = await offerLast(sessionID)
              if (offered === "cancel") return
              if (offered === "choose") await pickModels(sessionID)
              settings = await read()
              if (!settings) return
            }
            const confirmed = await dialog.confirm({
              title: "Start discussion",
              message: [
                `Topic: ${topic}`,
                `A: ${choiceOf(settings.a)}`,
                `B: ${choiceOf(settings.b)}`,
                `Mode: ${settings.mode} · rounds: ${settings.rounds} · max output: ${settings.maxOutputTokens} · ${conclusionText(settings)}`,
                `Ceiling: ${callBound(settings).participantCalls} participant calls, ${callBound(settings).worstCaseOutputTokens} output tokens.`,
                "Both participants see the topic and each other's replies.",
              ].join("\n"),
              label: { confirm: "Start", cancel: "Cancel" },
            })
            if (confirmed) await start(sessionID, topic)
            else toast("Not started.", "warning")
          },
        },
        {
          id: "discuss.stop",
          title: "Discuss: stop the running discussion",
          group: "Discuss",
          palette: true,
          slash: { name: "discuss-stop" },
          bind: "ctrl+shift+x",
          run: async () => {
            const sessionID = sessionOf()
            if (!sessionID) return void toast("Open the Discuss session first", "warning")
            const run = await activeRun(sessionID)
            if (!run) return
            try {
              await discuss.stop({ sessionID, runID: run.runID })
              toast("Stopping the discussion…", "success")
            } catch (error) {
              toast(String((error as Error)?.message ?? error))
            }
          },
        },
        {
          id: "discuss.interject",
          title: "Discuss: add a remark both participants will see",
          group: "Discuss",
          palette: true,
          slash: { name: "discuss-interject", arguments: true },
          bind: "ctrl+shift+i",
          run: async (input) => {
            const sessionID = sessionOf()
            if (!sessionID) return void toast("Open the Discuss session first", "warning")
            const run = await activeRun(sessionID)
            if (!run) return
            const text = (typeof input === "string" && input.trim()) || (await dialog.prompt({ title: "Interject", placeholder: "A remark both agents will see" }))
            if (!text) return void toast("Nothing sent: no text entered", "warning")
            try {
              await discuss.interject({ sessionID, runID: run.runID, text })
              toast("Remark sent; the next speaker will see it", "success")
            } catch (error) {
              toast(String((error as Error)?.message ?? error))
            }
          },
        },
        {
          id: "discuss.topic",
          title: "Discuss: change the topic of the running discussion",
          group: "Discuss",
          palette: true,
          slash: { name: "discuss-topic", arguments: true },
          bind: "ctrl+shift+t",
          run: async (input) => {
            const sessionID = sessionOf()
            if (!sessionID) return void toast("Open the Discuss session first", "warning")
            const run = await activeRun(sessionID)
            if (!run) return
            const text = (typeof input === "string" && input.trim()) || (await dialog.prompt({ title: "New topic", placeholder: "Next topic" }))
            if (!text) return void toast("Topic unchanged: no text entered", "warning")
            try {
              await discuss.topic({ sessionID, runID: run.runID, text })
              toast("Topic changed; the next speaker will see it", "success")
            } catch (error) {
              toast(String((error as Error)?.message ?? error))
            }
          },
        },
        {
          id: "discuss.restart",
          title: "Discuss: start a new run on the same topic",
          group: "Discuss",
          palette: true,
          slash: { name: "discuss-restart" },
          bind: "ctrl+shift+r",
          run: async () => {
            const sessionID = sessionOf()
            if (!sessionID) return void toast("Open the Discuss session first", "warning")
            const run = await currentRun(sessionID)
            if (!run) return void toast("No earlier discussion in this session to restart", "warning")
            if (run.status === "running") return void toast("A discussion is still running; /discuss-stop first", "warning")
            const confirmed = await dialog.confirm({
              title: "New discussion",
              message: `Start a new run about “${run.topic}”? The previous run stays in history.`,
              label: { confirm: "Start", cancel: "Cancel" },
            })
            if (confirmed) await start(sessionID, run.topic)
          },
        },
        {
          id: "discuss.handoff",
          title: "Discuss: prepare the result for Plan or Build",
          group: "Discuss",
          palette: true,
          slash: { name: "discuss-handoff" },
          bind: "ctrl+shift+h",
          run: async () => {
            const sessionID = sessionOf()
            if (!sessionID) return void toast("Open the Discuss session first", "warning")
            const run = await currentRun(sessionID)
            if (!run) return void toast("No discussion in this session to hand off", "warning")
            if (run.status === "running") {
              show({ title: "Discuss", message: "Stop the discussion before handing it off", variant: "warning" })
              return
            }
            if (run.handoff) {
              return void toast(`This result was already sent to ${run.handoff.target}; it is not sent twice. Start a new discussion to hand off again.`, "warning")
            }
            const target = await dialog.select({
              title: "Hand off discussion to",
              options: [
                { title: "Plan", value: "plan", description: "Planning agent" },
                { title: "Build", value: "build", description: "Coding agent" },
              ],
            })
            if (!target) return

            let packet = ""
            try {
              const preview = (await discuss.handoff({
                sessionID,
                runID: run.runID,
                target: target as "plan" | "build",
                confirm: false,
              })) as unknown as { packet: string }
              packet = preview.packet
            } catch (error) {
              packet = packetFrom(error)
            }

            const confirmed = await dialog.confirm({
              title: `Send to ${target}`,
              message: `Preview:\n\n${packet.slice(0, 1500)}${packet.length > 1500 ? "\n…" : ""}`,
              label: { confirm: "Send", cancel: "Cancel" },
            })
            if (!confirmed) return
            try {
              const sent = (await discuss.handoff({
                sessionID,
                runID: run.runID,
                target: target as "plan" | "build",
                confirm: true,
              })) as unknown as { path: string; submitted: boolean }
              show({
                title: "Discuss",
                message: sent.submitted
                  ? `Sent to ${target}. Saved: ${sent.path}`
                  : `Already sent earlier; not sent again. Saved: ${sent.path}`,
                variant: sent.submitted ? "success" : "warning",
                duration: TOAST_MS,
              })
            } catch (error) {
              show({ title: "Discuss", message: String((error as Error)?.message ?? error), variant: "error" })
            }
          },
        },
      ] satisfies KeymapCommand[]).map(journaled),
    }))

    log("ready")
    return dispose
  },
})

