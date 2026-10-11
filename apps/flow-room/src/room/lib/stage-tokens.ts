// ─── Stage Layer — tone tokens ───
//
// Five tones carry every state the stage rooms need. Each text tone is a CSS token
// measured at >= 4.5:1 on every painted surface (v2 contract C1); "block" is a
// failure red, never the human colour, which is --you (C3).

export type Tone = "ok" | "risk" | "block" | "muted" | "note";

export const TONE_COLOR: Record<Tone, string> = {
  ok: "var(--tone-ok)",
  risk: "var(--tone-risk)",
  block: "var(--tone-bad)",
  muted: "var(--tone-muted)",
  note: "var(--tone-note)",
};

export const TONE_WASH: Record<Tone, string> = {
  ok: "rgba(0, 134, 115, 0.10)",
  risk: "rgba(245, 158, 11, 0.12)",
  block: "rgba(179, 38, 30, 0.10)",
  muted: "rgba(100, 116, 139, 0.10)",
  note: "rgba(167, 139, 250, 0.12)",
};
