// ─── Flow room — refresh and freshness (D25; contract S2, S3, S4) ───
//
// The room re-reads pb every 5 minutes by default (1, 5, 15 or off — a viewing preference,
// kept in this browser's storage, never in the project), pauses while the tab is hidden and
// catches up when it comes back, and marks its data stale after twice the interval. A poll
// asks /api/state with the change token it last saw, so an unchanged journal costs one
// small 304 and no graph rebuild. Nothing here writes: refresh adds no write path (S3).
//
// Pure where it can be: the poller takes its clock, timers and visibility as arguments so
// the S2 test drives it with a fake clock.

import type { FlowGraph, FlowNode } from "./flow-types";

export const REFRESH_CHOICES = [1, 5, 15, 0] as const; // minutes; 0 = off
export type RefreshMinutes = (typeof REFRESH_CHOICES)[number];
export const DEFAULT_REFRESH: RefreshMinutes = 5;
const PREF_KEY = "flow-room:refresh-minutes";

/** The viewer's interval, from this browser's storage (any failure → the default). */
export function readRefreshPref(storage: Pick<Storage, "getItem"> | null | undefined): RefreshMinutes {
  try {
    const raw = storage?.getItem(PREF_KEY);
    const n = raw === null || raw === undefined ? NaN : Number(raw);
    return (REFRESH_CHOICES as readonly number[]).includes(n) ? (n as RefreshMinutes) : DEFAULT_REFRESH;
  } catch {
    return DEFAULT_REFRESH;
  }
}
export function writeRefreshPref(storage: Pick<Storage, "setItem"> | null | undefined, minutes: RefreshMinutes): void {
  try { storage?.setItem(PREF_KEY, String(minutes)); } catch { /* a private window: the choice lasts this visit */ }
}

/** S2: data older than twice the interval is stale. With refresh off, nothing is "stale" by schedule. */
export function isStale(lastOkAt: number | null, now: number, minutes: RefreshMinutes): boolean {
  if (!minutes || lastOkAt === null) return false;
  return now - lastOkAt > 2 * minutes * 60_000;
}

/** "just now", "3 min ago", "2 h ago". */
export function ageText(at: number | null, now: number): string {
  if (at === null) return "never";
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 36 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

export interface Poller {
  /** Call when the viewer changes the interval. */
  setMinutes(m: RefreshMinutes): void;
  /** Call on `visibilitychange`. */
  visibilityChanged(): void;
  /** The Refresh button: poll now, and restart the interval from now. */
  now(): void;
  stop(): void;
}
export interface PollerDeps {
  poll: () => void;
  isHidden: () => boolean;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (id: unknown) => void;
  clock: () => number;
}
/**
 * S2's schedule. Polls every `minutes` while visible; while hidden it does not poll, and on
 * becoming visible it polls at once if a poll fell due while it was away.
 */
export function createPoller(minutes: RefreshMinutes, deps: PollerDeps): Poller {
  let m = minutes;
  let timer: unknown = null;
  let lastPoll = deps.clock();
  let missed = false;
  const clear = () => { if (timer !== null) deps.clearTimer(timer); timer = null; };
  const arm = () => {
    clear();
    if (!m) return;
    const due = Math.max(0, lastPoll + m * 60_000 - deps.clock());
    timer = deps.setTimer(fire, due);
  };
  const fire = () => {
    timer = null;
    if (deps.isHidden()) { missed = true; return; }
    lastPoll = deps.clock();
    deps.poll();
    arm();
  };
  arm();
  return {
    // turning refresh off forgets a poll missed while hidden: off means no poll on return either
    setMinutes(next) { m = next; if (!m) missed = false; arm(); },
    visibilityChanged() {
      if (deps.isHidden()) return;
      if (m && (missed || deps.clock() - lastPoll >= m * 60_000)) { missed = false; fire(); }
      else arm();
    },
    now() { lastPoll = deps.clock(); missed = false; deps.poll(); arm(); },
    stop: clear,
  };
}

/** What a card's "has it moved?" fingerprint is: status, journal length, last update. */
function fingerprint(n: FlowNode): string {
  return `${n.status}|${(n.journal ?? []).length}|${n.updated_at ?? ""}`;
}
/** Cards that changed (or arrived) between two reads — they glow once so you see what moved. */
export function changedCards(before: FlowGraph | null, after: FlowGraph): string[] {
  if (!before) return [];
  const old = new Map(before.nodes.map(n => [n.id, fingerprint(n)]));
  return after.nodes
    .filter(n => (n.kind ?? "task") === "task" && old.get(n.id) !== fingerprint(n))
    .map(n => n.id);
}
