// ─── Stage Layer — tone tokens ───
//
// Five tones carry every state the stage rooms need. Teal and rose come from
// the product palette; amber and violet are the same accents the sidecar feed
// already uses for warnings and narration, so the layer reads as one system.

export type Tone = "ok" | "risk" | "block" | "muted" | "note";

export const TONE_COLOR: Record<Tone, string> = {
  ok: "var(--accent-teal)",
  risk: "#f59e0b",
  block: "var(--accent-rose)",
  muted: "var(--text-tertiary)",
  note: "#a78bfa",
};

export const TONE_WASH: Record<Tone, string> = {
  ok: "rgba(0, 134, 115, 0.10)",
  risk: "rgba(245, 158, 11, 0.12)",
  block: "rgba(194, 74, 74, 0.10)",
  muted: "rgba(100, 116, 139, 0.10)",
  note: "rgba(167, 139, 250, 0.12)",
};
