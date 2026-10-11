// ─── Flow room v2 — the card face (contract K1–K5, F1, F2, T3; D13, D14, D19, D20) ───
//
// Pure functions of the projection node, so the face, the layout (which needs the
// card's height before React draws it) and the tests read ONE derivation:
//
//   state + owner → title → progress bar → now / next → proof + messages     (K1)
//
// Nothing else is on the face. The task ID, the skill, the mode and the layer are
// constant chrome or machine detail: they live on the open card and on hover (K3, K4).
//
// Every field the engine may not send yet (`headline`, `now`, `live`, `human`,
// `journal[].summary`, `journal[].intent`) has the fallback proposal.html §8 names.

import { allChecksPassed, checksCount, checksOutcome, flowRail, hasRedCheck } from "./flow-derive";
import type { FlowJournalRow, FlowNode } from "./flow-types";

// ── state (C2: a word and an icon, never colour alone) ──────────────────────

export type FaceStateKind = "you" | "decided" | "working" | "blocked" | "done" | "closed" | "ready";

export interface FaceState {
  kind: FaceStateKind;
  /** The word on the chip. */
  label: string;
  /** Short form for the glance tier. */
  short: string;
  /** Icon id (FlowIcons): every state has one. */
  icon: "hand" | "check" | "block" | "led" | "circle" | "dash";
  /** F2: "Needs your decision" flashes from appearance until answered. */
  flashing: boolean;
}

/** The decision rows a person writes through `pb decide` (D17) — the answer to a HIL ask. */
export function decisionRow(node: FlowNode): FlowJournalRow | undefined {
  return [...(node.journal ?? [])].reverse().find(row => row.action === "decide");
}

/** A person is being asked right now: a manual task (or a declared human question) not yet answered. */
export function asksYou(node: FlowNode): boolean {
  if (node.status === "done") return false;
  const asked = node.manual === true || !!node.human?.question;
  return asked && !decisionRow(node);
}

/**
 * F2, the HIL state machine: you → decided → working → done. The label flashes only in
 * `you`; once answered it holds steady; when the task closes with its checks green it is
 * the green "Done" every card uses.
 */
export function faceState(node: FlowNode): FaceState {
  if (asksYou(node)) {
    return { kind: "you", label: "Needs your decision", short: "You", icon: "hand", flashing: true };
  }
  if (node.status === "done") {
    return allChecksPassed(node)
      ? { kind: "done", label: "Done", short: "Done", icon: "check", flashing: false }
      // C4: closed, but nothing proves it — never the green of a pass.
      : { kind: "closed", label: "Closed · not proven", short: "Closed", icon: "dash", flashing: false };
  }
  if ((node.manual === true || !!node.human?.question) && decisionRow(node) && node.status !== "in_progress") {
    return { kind: "decided", label: "Decided", short: "Decided", icon: "check", flashing: false };
  }
  if (node.status === "in_progress") {
    return { kind: "working", label: "Working", short: "Working", icon: "led", flashing: false };
  }
  if (node.status === "blocked") {
    return { kind: "blocked", label: "Blocked", short: "Blocked", icon: "block", flashing: false };
  }
  return { kind: "ready", label: "Ready to start", short: "Ready", icon: "circle", flashing: false };
}

// ── live (F1: flashing means live) ──────────────────────────────────────────

/** The window the engine uses for `live` (pb graph: claim held + a row within 15 min). */
export const LIVE_WINDOW_MS = 15 * 60 * 1000;

function rowTime(row: FlowJournalRow): number {
  const t = Date.parse(row.ts ?? row.at ?? "");
  return Number.isFinite(t) ? t : NaN;
}

/**
 * True only while a claim is held AND the journal moved within the window. The engine's
 * own `live` wins; a payload without it (a snapshot, an older engine) is judged by the
 * same rule against `now`, so a stale snapshot never flashes.
 */
export function isLive(node: FlowNode, now = Date.now()): boolean {
  if (typeof node.live === "boolean") return node.live;
  if (node.status !== "in_progress" || !node.claim?.by) return false;
  const rows = node.journal ?? [];
  const last = rows.length ? rowTime(rows[rows.length - 1]) : NaN;
  // a row stamped in the future is a clock problem, not evidence of work: not live
  return Number.isFinite(last) && now - last >= 0 && now - last <= LIVE_WINDOW_MS;
}

// ── owner / age ─────────────────────────────────────────────────────────────

export interface FaceOwner {
  initial: string;
  name: string;
}

/** "lead" → "Lead agent"; a checker or a named agent keeps its own name. */
export function agentDisplayName(agent: string): string {
  const a = agent.trim();
  if (!a) return "an agent";
  if (/^lead$/i.test(a)) return "Lead agent";
  if (/checker/i.test(a)) return "Checker";
  return a.replace(/[-_]+/g, " ").replace(/^\w/, c => c.toUpperCase());
}

/** Who holds the card. Only a held claim has an owner; a free card shows its age instead. */
export function faceOwner(node: FlowNode): FaceOwner | null {
  const by = node.claim?.by;
  if (!by || node.status !== "in_progress") return null;
  const name = agentDisplayName(by);
  return { initial: name.charAt(0).toUpperCase(), name };
}

/** "3 days", "5 min" — how long since the card last moved. */
export function ageLabel(iso: string | null | undefined, now = Date.now()): string | null {
  const t = Date.parse(iso ?? "");
  if (!Number.isFinite(t)) return null;
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 90) return "just now";
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"}`;
}

export function lastMoved(node: FlowNode): string | null {
  const rows = node.journal ?? [];
  const last = rows.length ? rows[rows.length - 1] : undefined;
  return (last && (last.ts ?? last.at)) || node.updated_at || null;
}

// ── text: titles and one-liners that never cut a word ───────────────────────

/** Atkinson Hyperlegible Next, average advance per character (px per px of size). */
export const FACE_CHAR_EM = 0.6;
export const FACE_W = 288;
export const FACE_PAD_X = 14;
export const FACE_INNER_W = FACE_W - FACE_PAD_X * 2;
export const FACE_TITLE_PX = 16;
export const FACE_TITLE_LH = 21;
export const FACE_NOW_PX = 13;
export const FACE_NOW_LH = 19;
export const FACE_TITLE_LINES = 3;
export const FACE_NOW_LINES = 2;

export function charsPerLine(px: number, width = FACE_INNER_W): number {
  return Math.max(8, Math.floor(width / (px * FACE_CHAR_EM)));
}

/** Greedy word wrap; a single word longer than a line is broken (never lost). */
export function wrapWords(text: string, perLine: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (next.length <= perLine) { line = next; continue; }
    if (line) lines.push(line);
    line = w.length > perLine ? w.slice(0, perLine) : w;
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Fit text into `maxLines` without cutting a word (K2). A sentence or clause boundary
 * inside the budget wins (". ", ": ", " - ", " — ", "; ", ", "); otherwise the last whole
 * word that fits, followed by "…".
 */
export function fitText(text: string, perLine: number, maxLines: number): { text: string; cut: boolean; lines: number } {
  const clean = text.replace(/\s+/g, " ").trim();
  const all = wrapWords(clean, perLine);
  if (all.length <= maxLines) return { text: clean, cut: false, lines: Math.max(1, all.length) };
  const budget = perLine * maxLines - 2;
  const head = clean.slice(0, budget);
  const boundary = Math.max(
    ...[". ", ": ", " - ", " — ", "; ", " (", ", "].map(b => {
      const i = head.lastIndexOf(b);
      return i >= budget * 0.45 ? i + (b.trim() === "." || b.trim() === ":" || b.trim() === ";" ? 1 : 0) : -1;
    })
  );
  let out: string;
  if (boundary > 0) {
    out = head.slice(0, boundary).replace(/[\s,;:(—-]+$/, "");
  } else {
    const lastSpace = head.lastIndexOf(" ");
    out = (lastSpace > 0 ? head.slice(0, lastSpace) : head).replace(/[\s,;:(—-]+$/, "");
  }
  const withEllipsis = /[.!?]$/.test(out) ? out : `${out}…`;
  // re-wrap: the ellipsis may need its own line
  let fitted = withEllipsis;
  while (wrapWords(fitted, perLine).length > maxLines && fitted.includes(" ")) {
    fitted = `${fitted.slice(0, fitted.lastIndexOf(" ")).replace(/[\s,;:(—-]+$/, "")}…`;
  }
  return { text: fitted, cut: true, lines: Math.min(maxLines, wrapWords(fitted, perLine).length) };
}

/** The face title: the engine's `headline` when it sends one, else the title, fitted (K2). */
export function faceTitle(node: FlowNode, perLine = charsPerLine(FACE_TITLE_PX)): { text: string; cut: boolean; lines: number; full: string } {
  // K4: a title that quotes its own ID does not put the ID on the face
  const source = ((node.headline && node.headline.trim()) || node.title)
    .split(`[${node.id}]`).join("this task").split(node.id).join("this task");
  const fit = fitText(source, perLine, FACE_TITLE_LINES);
  return { ...fit, full: node.title };
}

// ── now / next (D14) ────────────────────────────────────────────────────────

export interface FaceNow {
  label: string;
  text: string;
}

/** A row's human summary: the engine's `summary`, else the first sentence of its notes. */
const KEEP_CAPS = new Set(["POSIX", "ASCII", "HTTPS", "JSONL", "NDJSON", "OAUTH", "WSL2"]);

export function rowSummary(row: FlowJournalRow): string {
  const s = (row.summary ?? "").trim();
  if (s) return s;
  const notes = (row.notes ?? "").replace(/\s+/g, " ").trim();
  const m = /^(.{12,}?[.!?])(\s|$)/.exec(notes);
  const first = m ? m[1] : notes;
  // the same fallback as the engine: a shouted word reads as a word (proposal §8)
  // …but an acronym is not shouting: words of four letters or fewer (YAML, JSON, CSRF,
  // WCAG) and a few longer ones keep their capitals
  const calm = first.replace(/\b([A-Z][A-Z'-]{4,})\b/g, w => (KEEP_CAPS.has(w) ? w : w.toLowerCase()));
  return calm.charAt(0).toUpperCase() + calm.slice(1);
}

/** The one line under the bar: what is happening, or what this waits on, or what is next. */
export function faceNow(node: FlowNode): FaceNow | null {
  const state = faceState(node);
  const perLine = charsPerLine(FACE_NOW_PX);
  // K4: the card's own ID never reaches the face, even quoted inside a journal note
  const fit = (t: string) => fitText(t.split(`[${node.id}]`).join("this task").split(node.id).join("this task"), perLine, FACE_NOW_LINES).text;
  if (node.now && node.now.trim()) {
    const label = state.kind === "blocked" ? "Waiting on" : state.kind === "ready" ? "Next" : "Now";
    return { label, text: fit(node.now) };
  }
  if (state.kind === "you") {
    const q = node.human?.question?.trim();
    const waiting = node.human?.waiting_on?.length;
    if (q) return { label: "Asks", text: fit(q) };
    return { label: "Asks", text: waiting ? `a person to decide · holds up ${waiting} task${waiting === 1 ? "" : "s"}` : "a person to act — only a human can close this" };
  }
  const rows = (node.journal ?? []).filter(row => row.action !== "claim" || state.kind === "working");
  const last = rows.length ? rows[rows.length - 1] : undefined;
  if (!last) return state.kind === "ready" ? null : null;
  const text = rowSummary(last);
  if (!text) return null;
  const label = state.kind === "working" ? "Now" : state.kind === "blocked" ? "Waiting on" : state.kind === "ready" ? "Last" : "Result";
  return { label, text: fit(text) };
}

// ── proof + messages (the foot) ─────────────────────────────────────────────

export type ProofCell = "ok" | "no" | "none";

export interface FaceProof {
  cells: ProofCell[];
  text: string;
}

export function faceProof(node: FlowNode): FaceProof {
  const total = checksCount(node);
  if (total === 0) return { cells: [], text: "No checks declared" };
  const shown = Math.min(total, 6);
  const detail = node.checks_detail;
  if (detail && detail.length) {
    const passed = detail.filter(c => c.passed).length;
    return {
      cells: detail.slice(0, 6).map(c => (c.passed ? "ok" : "no")),
      text: `${passed} of ${detail.length} passing`,
    };
  }
  const outcome = checksOutcome(node);
  if (outcome === "passed") return { cells: Array(shown).fill("ok"), text: `${total} of ${total} passing` };
  if (outcome === "failed" || hasRedCheck(node)) return { cells: Array(shown).fill("no"), text: "Checks failing" };
  if (outcome === "skipped") return { cells: Array(shown).fill("none"), text: "Checks skipped" };
  return { cells: Array(shown).fill("none"), text: total === 1 ? "Check not run yet" : `${total} checks not run yet` };
}

/** Rows that are conversation, not work: comments, steers and questions (M3). */
export function messageRows(node: FlowNode): FlowJournalRow[] {
  return (node.journal ?? []).filter(row => row.action === "comment" || !!row.intent);
}

// ── the rail on the face (C5, D19) ──────────────────────────────────────────

/** `working` drives the bar's sweep, so it is LIVE, not in_progress: a quiet claim is still (F1). */
export function faceBar(node: FlowNode, now = Date.now()): { filled: number; current: number; working: boolean } {
  const rail = flowRail(node);
  return { filled: rail.filled, current: rail.current, working: isLive(node, now) };
}

// ── height (K5: 120–220, follows content) ───────────────────────────────────

export const FACE_MIN_H = 120;
export const FACE_MAX_H = 220;

/** How many lines the now slot is given (the CSS clamps to exactly this, so no line is half cut). */
export function faceNowLines(node: FlowNode): number {
  const now = faceNow(node);
  return now ? Math.min(FACE_NOW_LINES, wrapWords(`${now.label}: ${now.text}`, charsPerLine(FACE_NOW_PX)).length) : 0;
}

/** The card's height from what it will draw; the layout uses this before React renders. */
export function faceHeight(node: FlowNode): number {
  const title = faceTitle(node);
  const nowLines = faceNowLines(node);
  const PAD = 14 + 12;
  const TOP = 22;
  const BAR = 6;
  const FOOT = 8 + 20;
  const GAP = 8;
  const rows = [TOP, title.lines * FACE_TITLE_LH, BAR, nowLines ? nowLines * FACE_NOW_LH : 0, FOOT].filter(Boolean);
  const h = PAD + rows.reduce((a, b) => a + b, 0) + GAP * (rows.length - 1) + 2;
  return Math.max(FACE_MIN_H, Math.min(FACE_MAX_H, Math.ceil(h)));
}

// ── zoom tiers (T3) ─────────────────────────────────────────────────────────

export type ZoomTier = "full" | "glance" | "overview";

/** Full ≥ 75%; glance 40–75%; overview below 40%. */
export const TIER_GLANCE_AT = 0.75;
export const TIER_OVERVIEW_AT = 0.4;

export function zoomTier(zoom: number): ZoomTier {
  if (zoom >= TIER_GLANCE_AT) return "full";
  if (zoom >= TIER_OVERVIEW_AT) return "glance";
  return "overview";
}

/** The beacon an overview shows for a card (G5): only states a person must see from far away. */
export type Beacon = "you" | "work" | "held" | "block" | "done" | "closed" | "ready";

/**
 * The overview dot. Only a LIVE card pulses ("work", F1); a held but quiet claim is a still
 * "held" dot. Only a proven done is the green "done" (C4): a card closed without a passing
 * check, or a decision not yet worked, is a neutral "closed".
 */
export function beaconFor(node: FlowNode, now = Date.now()): Beacon {
  const s = faceState(node);
  if (s.kind === "you") return "you";
  if (isLive(node, now)) return "work";
  if (s.kind === "working") return "held";
  if (s.kind === "blocked") return "block";
  if (s.kind === "done") return "done";
  if (s.kind === "closed" || s.kind === "decided") return "closed";
  return "ready";
}

/** K1: the slots of the face, in order. The component renders exactly these. */
export const FACE_SLOTS = ["state", "title", "bar", "now", "foot"] as const;
