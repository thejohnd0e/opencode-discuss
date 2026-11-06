import { describe, expect, test } from "bun:test"
import { panelStyle, speakerRole, statusRole } from "../../src/ui/panel-style"

const scale = (name: string) => ({ 300: `${name}300`, 400: `${name}400`, 500: `${name}500`, 600: `${name}600`, 700: `${name}700` })

const theme = {
  text: {
    base: "base",
    muted: "muted",
    faint: "faint",
    feedback: {
      error: { base: "error" },
      warning: { base: "warning" },
      success: { base: "success" },
      info: { base: "info" },
    },
  },
  categorical: [scale("cat0-"), scale("cat1-")],
  hue: { accent: scale("accent-"), interactive: scale("interactive-") },
}

describe("panel colours", () => {
  test("participants get two distinct categorical colours, lighter in dark mode", () => {
    const dark = panelStyle(theme, "dark")
    expect(dark.a).toBe("cat0-400")
    expect(dark.b).toBe("cat1-400")
    const light = panelStyle(theme, "light")
    expect(light.a).toBe("cat0-600")
    expect(light.b).toBe("cat1-600")
  })

  test("statuses, errors and service lines use feedback and muted text", () => {
    const style = panelStyle(theme)
    expect(style[statusRole("completed")]).toBe("success")
    expect(style[statusRole("failed")]).toBe("error")
    expect(style[statusRole("cancelled")]).toBe("warning")
    expect(style[statusRole("running")]).toBe("info")
    expect(style[statusRole(undefined)]).toBe("muted")
    expect(style.faint).toBe("faint")
    expect(style.body).toBe("base")
  })

  test("falls back to semantic hues, then feedback, when categorical colours are missing", () => {
    const style = panelStyle({ ...theme, categorical: [] })
    expect(style.a).toBe("accent-400")
    expect(style.b).toBe("interactive-400")
    const bare = panelStyle({ text: theme.text })
    expect(bare.a).toBe("info")
    expect(bare.b).toBe("success")
  })

  test("an empty or missing theme never throws and leaves colours to the host", () => {
    expect(() => panelStyle(undefined)).not.toThrow()
    const style = panelStyle({})
    expect(style.a).toBeUndefined()
    expect(style.body).toBeUndefined()
  })

  test("speakers map to roles", () => {
    expect(speakerRole("a")).toBe("a")
    expect(speakerRole("b")).toBe("b")
    expect(speakerRole("topic")).toBe("topic")
    expect(speakerRole("human")).toBe("human")
  })
})
