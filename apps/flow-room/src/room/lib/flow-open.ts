// ─── Flow room v2 — what the open card and the presence strip say (D15, D16; M1–M3) ───
//
// Pure functions of the projection, so the open card, the header and the tests read
// one derivation. Every engine field the design needs is optional; each has the
// fallback proposal.html §8 documents.

import { checksOutcome, flowRail } from "./flow-derive";
import { agentDisplayName, faceOwner, faceState, isLive, rowSummary } from "./flow-face";
import type { FlowGraph, FlowJournalRow, FlowNode } from "./flow-types";

/** The engine's loop steps in plain words; hovering a step shows the engine word. */
export const PLAIN_STEPS = [
  { engine: "orient", plain: "Read plan" },
  { engine: "select", plain: "Pick up" },
  { engine: "act", plain: "Do work" },
  { engine: "verify", plain: "Run checks" },
  { engine: "record", plain: "Record" },
  { engine: "report", plain: "Report" },
] as const;

/** M2: a message longer than this is folded under its one-line summary. */
export const FOLD_AT = 280;

export type MessageIntent = "comment" | "steer" | "question" | "finding" | "decision";

/** What this is: the first two sentences of the title; the rest is "the full brief". */
export function brief(node: FlowNode): { short: string; more: boolean } {
  const t = node.title.replace(/\s+/g, " ").trim();
  // a sentence ends at . ! ? followed by a space and a capital (or the end) — never at the
  // dot inside "0.6.2", "pb.mjs" or "e.g."
  const sentences = t.split(/(?<=[.!?])\s+(?=[A-Z(“"])/);
  let short = "";
  for (const s of sentences) {
    if ((short + " " + s).length > 320 && short) break;
    short = short ? `${short} ${s}` : s;
    if (short.length > 160) break;
  }
  short = short.trim();
  if (short.length > 340) short = `${short.slice(0, short.lastIndexOf(" ", 330))}…`;
  return { short, more: short.length < t.length };
}

/** One sentence: what happens next, and who does it. A person's turn is the HIL style. */
export function nextLine(node: FlowNode): { text: string; you: boolean } {
  const s = faceState(node);
  const owner = faceOwner(node);
  const rail = flowRail(node);
  if (s.kind === "you") {
    const waiting = node.human?.waiting_on?.length ?? 0;
    return { text: `Next: your decision.${waiting ? ` ${waiting} task${waiting === 1 ? " waits" : "s wait"} on it.` : ""}`, you: true };
  }
  if (s.kind === "decided") return { text: "Next: an agent acts on your decision and records the result.", you: false };
  if (s.kind === "done") return { text: "Done: every check exited 0.", you: false };
  if (s.kind === "closed") return { text: "Closed, but no passing check is recorded — this is not proof it works.", you: false };
  if (s.kind === "blocked") return { text: `Next: unblock it.${node.now ? ` Waiting on: ${node.now}` : ""}`, you: false };
  if (s.kind === "working") {
    const step = PLAIN_STEPS[Math.min(rail.current, 5)]?.plain ?? "Record";
    const who = owner?.name ?? "the agent";
    return { text: isLive(node) ? `Next: ${step.toLowerCase()}, by ${who}.` : `Next: ${step.toLowerCase()}, by ${who} — who has not written anything for a while.`, you: false };
  }
  return { text: "Next: an agent picks it up with pb next.", you: false };
}

export interface ProofRow {
  name: string;
  command: string;
  result: "passed" | "failed" | "skipped" | "not-run";
  word: string;
}

/** Each check by name with its command; "not run" never reads like a pass (C4). */
export function proofRows(node: FlowNode): ProofRow[] {
  const commands = node.acceptance_checks ?? [];
  const names = node.check_names ?? [];
  const detail = node.checks_detail;
  const outcome = checksOutcome(node);
  return commands.map((command, i) => {
    const d = detail?.find(x => x.command === command);
    const result: ProofRow["result"] = d ? (d.passed ? "passed" : "failed") : outcome === "passed" ? "passed" : outcome === "failed" ? "failed" : outcome === "skipped" ? "skipped" : "not-run";
    const word = result === "passed" ? (d ? `passed (exit ${d.exit_code})` : "passed") : result === "failed" ? (d ? `failed (exit ${d.exit_code})` : "failed") : result === "skipped" ? "skipped — not proof" : "not run";
    return { name: names[i] ?? scriptName(command), command, result, word };
  });
}

/** The room's own fallback when the engine sends no check_names: the script, in words. */
export function scriptName(command: string): string {
  const tokens = command.trim().split(/\s+/);
  const script = tokens.find(t => /\.(mjs|cjs|js|ts|sh|py|ps1)$/i.test(t));
  if (script) return script.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, "").replace(/[-_.]+/g, " ").trim();
  return tokens.slice(0, 4).join(" ");
}

export interface Message {
  seq?: number;
  ts?: string;
  author: string;
  intent: string;
  summary: string;
  /** The full note, only when it says more than the summary (M2: folded). */
  full: string | null;
}

/** Rows that are conversation: messages, decisions, and the work notes agents leave. */
const SILENT = new Set(["claim", "release", "spawn"]);
/** S8: what the orchestrator did to a card is conversation, in its own voice, with the reason —
 *  including a release, which is silent bookkeeping when an agent lets go of its own claim. */
const ORCHESTRATOR = "orchestrator";
const ORCHESTRATOR_INTENT: Record<string, string> = { release: "released", defer: "deferred", ask: "question", tick: "tick" };
export function conversation(node: FlowNode): Message[] {
  return (node.journal ?? [])
    .filter(r => (r.agent === ORCHESTRATOR || !SILENT.has(r.action)) && (r.notes ?? "").trim())
    .map((r: FlowJournalRow) => {
      const summary = rowSummary(r);
      const notes = (r.notes ?? "").trim();
      const folded = notes.length > FOLD_AT || notes.replace(/\s+/g, " ").toLowerCase() !== summary.toLowerCase();
      return {
        seq: r.seq,
        ts: r.ts ?? r.at,
        author: agentDisplayName(r.agent ?? "agent"),
        intent: r.intent ?? (r.agent === ORCHESTRATOR ? ORCHESTRATOR_INTENT[r.action] : undefined) ?? (r.action === "decide" ? "decision" : r.action === "checker" ? "review" : r.action === "comment" ? "comment" : "work"),
        summary: summary.length > FOLD_AT ? `${summary.slice(0, summary.lastIndexOf(" ", FOLD_AT - 1))}…` : summary,
        full: folded ? notes : null,
      };
    });
}

export interface Presence {
  agent: string;
  name: string;
  task: string;
  taskTitle: string;
  lastSpoke: string | null;
  live: boolean;
}

/** M1: each active agent — what it is on, when it last spoke. From claims + latest rows. */
export function presence(graph: FlowGraph): Presence[] {
  const out: Presence[] = [];
  for (const n of graph.nodes) {
    if ((n.kind ?? "task") !== "task" || n.status !== "in_progress" || !n.claim?.by) continue;
    const rows = (n.journal ?? []).filter(r => r.agent === n.claim?.by);
    const last = rows[rows.length - 1];
    out.push({
      agent: n.claim.by,
      name: agentDisplayName(n.claim.by),
      task: n.id,
      taskTitle: n.headline ?? n.title,
      lastSpoke: last ? (last.ts ?? last.at ?? null) : null,
      live: isLive(n),
    });
  }
  return out.sort((a, b) => (b.lastSpoke ?? "").localeCompare(a.lastSpoke ?? ""));
}
