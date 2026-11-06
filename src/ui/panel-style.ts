/**
 * Colours for the Discuss panel, taken from the active OpenCode theme so the
 * panel follows light/dark and custom themes. Every lookup has a fallback:
 * a theme without a token yields `undefined`, which leaves the host default.
 */

export type Color = unknown

export type PanelRole =
  | "title"
  | "label"
  | "value"
  | "muted"
  | "faint"
  | "body"
  | "a"
  | "b"
  | "human"
  | "topic"
  | "error"
  | "warning"
  | "success"
  | "info"

export type PanelStyle = Readonly<Record<PanelRole, Color | undefined>>

type Scale = Readonly<Record<number, Color>> | undefined
type ThemeLike = {
  text?: {
    base?: Color
    muted?: Color
    faint?: Color
    feedback?: Readonly<Record<string, { base?: Color; muted?: Color } | undefined>>
  }
  categorical?: ReadonlyArray<Scale>
  hue?: Readonly<Record<string, Scale>>
}

const step = (scale: Scale, ...steps: number[]): Color | undefined => {
  if (!scale) return undefined
  for (const value of steps) if (scale[value] !== undefined) return scale[value]
  return undefined
}

export function panelStyle(theme: unknown, mode: "dark" | "light" = "dark"): PanelStyle {
  const t = (theme ?? {}) as ThemeLike
  const text = t.text ?? {}
  const feedback = text.feedback ?? {}
  // Mid steps read well on both backgrounds; lighter in dark mode, darker in light.
  const steps = mode === "dark" ? [400, 500, 300, 600] : [600, 500, 700, 400]
  const categorical = t.categorical ?? []
  const accent = step(t.hue?.accent, ...steps)
  const interactive = step(t.hue?.interactive, ...steps)
  return {
    title: text.base,
    label: text.muted,
    value: text.base,
    muted: text.muted,
    faint: text.faint ?? text.muted,
    body: text.base,
    a: step(categorical[0], ...steps) ?? accent ?? feedback.info?.base,
    b: step(categorical[1], ...steps) ?? interactive ?? feedback.success?.base,
    human: feedback.warning?.base ?? text.muted,
    topic: feedback.info?.base ?? text.muted,
    error: feedback.error?.base,
    warning: feedback.warning?.base,
    success: feedback.success?.base,
    info: feedback.info?.base,
  }
}

/** Colour role for a run status. */
export function statusRole(status: string | undefined): PanelRole {
  switch (status) {
    case "completed":
      return "success"
    case "failed":
      return "error"
    case "cancelled":
      return "warning"
    case "running":
      return "info"
    default:
      return "muted"
  }
}

/** Colour role for a message speaker. */
export function speakerRole(speaker: string): PanelRole {
  if (speaker === "a") return "a"
  if (speaker === "b") return "b"
  if (speaker === "topic") return "topic"
  return "human"
}
