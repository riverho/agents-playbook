// ─── Flow room — the honesty rules ───
//
// Everything here is a pure function of the projection (lib/flow-types.ts). These
// are the only derivations the room is allowed to make, and each one encodes a
// rule the painted frames state explicitly:
//
//   · the 6-segment rail is DERIVED FROM JOURNAL ROWS, never hand-set       (§2.1)
//   · "a card is never green unless its checks exited 0"                    (frame 1)
//   · `⚠ hollow` mirrors pb validate's hollow-gate warning                  (§2.1)
//   · a `manual` task or a blocked status needs a person                    (§2.2)
//
// If a value cannot be derived from the projection it is not rendered.

import {
  FLOW_CYCLE_STEPS,
  type FlowChecksOutcome,
  type FlowEdgeKind,
  type FlowGraph,
  type FlowNode,
  type FlowStatus,
  type FlowStopCondition,
} from "./flow-types";

/** The 3 px tone bar / legend dot for each task state (frame 1 legend). */
export const FLOW_TONE: Record<FlowStatus, string> = {
  done: "#2f2f2f",
  in_progress: "var(--accent-teal)",
  blocked: "var(--accent-rose)",
  todo: "var(--text-tertiary)",
};

/** The orchestrator's own tone — `note` (`#a78bfa`) in the painted frames. */
export const FLOW_NOTE = "#a78bfa";

/**
 * The minimap's tones, matching `.minimap .mm i` in flow.css: LIGHT grey rects
 * (`rgba(17,17,17,0.22)`) with only the live and human-blocked nodes accented.
 * The card's ink tone (`#2f2f2f`) must never be used here — on the minimap panel
 * it renders as a heavy black block, which is exactly what the live render
 * exposed against the painted frame.
 */
export const FLOW_MINIMAP_TONE: Record<FlowStatus, string> = {
  todo: "rgba(17, 17, 17, 0.18)",
  done: "rgba(17, 17, 17, 0.22)",
  in_progress: "var(--accent-teal)",
  blocked: "var(--accent-rose)",
};

/** The minimap panel's own background (`.minimap .mm`). */
export const FLOW_MINIMAP_BG = "#fbfaf9";

/**
 * The gate pill's text — one source for the layout (which measures it) and the
 * card (which renders it), so the asserted box is the drawn box.
 */
export function gateLabelText(node: FlowNode): string {
  const gate = node.gate;
  if (!gate) return node.title;
  const state =
    gate.evaluated === false ? " · unevaluated" : gate.passing ? " ✓" : " ✗";
  return `${node.title} · ${gate.command}${state}`;
}

// ─── the legend: ONE model, drawn by the room and measured by the layout ──
//
// The legend's reserve used to be a literal (660x104) while its drawn content is
// ~105-121 px tall, so the rows were clipped at the canvas bottom — the Lead saw
// exactly that. The fix is structural: the legend is a MODEL here, the component
// renders that model, and the layout sizes the reserve from the SAME model, so
// the panel can never be smaller than what it draws.

/** One legend row: a swatch plus its label. */
export interface FlowLegendRow {
  kind: "line" | "dot" | "glyph" | "text";
  text: string;
  /** Edge swatch only: the stroke colour, width and whether it is dashed. */
  stroke?: string;
  strokeWidth?: number;
  dash?: boolean;
  /** Dot rows only: the tone's colour. */
  color?: string;
  /** Dot rows only: pulse like a live claim. */
  live?: boolean;
  /** Glyph rows only: the character and its colour. */
  glyph?: string;
  glyphColor?: string;
}

export interface FlowLegendGroup {
  title: string;
  rows: FlowLegendRow[];
}

/** The legend's drawn metrics (px). The layout's arithmetic uses these. */
export const FLOW_LEGEND_METRICS = {
  padX: 10,
  padY: 8,
  headerH: 12,
  rowH: 13,
  rowGap: 3,
  groupGap: 18,
  swatchW: 26,
  swatchGap: 6,
  /** Inter at 9.5 px, measured conservatively. */
  charW: 5.6,
} as const;

/** The legend's content as data — payload-dependent only in the EDGES group. */
export function flowLegendModel(graph: FlowGraph): FlowLegendGroup[] {
  const edgeRows: FlowLegendRow[] = edgeKindsInUse(graph).map(kind => {
    const style = FLOW_EDGE_STYLE[kind];
    return {
      kind: "line",
      text: FLOW_EDGE_LABEL[kind],
      stroke: style.stroke,
      strokeWidth: style.width,
      dash: !!style.dash,
    };
  });
  return [
    { title: "EDGES", rows: edgeRows },
    {
      title: "CARDS",
      rows: [
        { kind: "dot", text: "done — checks exited 0", color: FLOW_TONE.done },
        {
          kind: "dot",
          text: "in progress — claim held",
          color: FLOW_TONE.in_progress,
          live: true,
        },
        { kind: "dot", text: "blocked / human gate", color: FLOW_TONE.blocked },
        { kind: "glyph", text: "hollow gate warning", glyph: "⚠", glyphColor: "#f59e0b" },
        { kind: "dot", text: "todo — unclaimed", color: FLOW_TONE.todo },
      ],
    },
    {
      title: "CYCLE — DERIVED FROM THE JOURNAL",
      rows: [
        { kind: "text", text: "orient → select → act → verify → record → report" },
        { kind: "text", text: "the 6-step rail on each card is the step the task is on" },
        { kind: "text", text: "a card is never green unless its checks exited 0" },
      ],
    },
  ];
}

/** What the model costs to draw: the smallest panel that shows every row. */
export function flowLegendContentSize(model: FlowLegendGroup[]): {
  width: number;
  height: number;
} {
  const m = FLOW_LEGEND_METRICS;
  let height = m.padY * 2;
  let width = m.padX * 2;
  model.forEach((group, index) => {
    const rowsH =
      group.rows.length * m.rowH + Math.max(0, group.rows.length - 1) * m.rowGap;
    height = Math.max(height, m.padY * 2 + m.headerH + rowsH);
    if (index > 0) width += m.groupGap;
    const widest = group.rows.reduce((max, row) => {
      const swatch = row.kind === "line" ? m.swatchW + m.swatchGap : 0;
      return Math.max(max, swatch + row.text.length * m.charW);
    }, group.title.length * m.charW * 0.9);
    width += Math.max(widest, 80);
  });
  return { width: Math.ceil(width), height: Math.ceil(height) };
}

/** The reserve the layout must hand the legend so nothing is clipped. */
export function flowLegendRequiredSize(graph: FlowGraph): {
  width: number;
  height: number;
} {
  return flowLegendContentSize(flowLegendModel(graph));
}

export interface FlowEdgeStyle {
  stroke: string;
  width: number;
  /** stroke-dasharray, exactly as painted in flow.css. */
  dash?: string;
  marker: "dep" | "ink" | "teal" | "rose" | "none";
  /** merge-back is drawn twice: a solid 2.25 px line plus a 1 px ghost. */
  double?: boolean;
  label?: string;
}

/**
 * The edge vocabulary — five kinds plus `idle` — with the dash patterns and
 * colours measured from flow.css (`.e-dep` … `.e-hil`). Solid means the engine
 * proved it; a claim is dashed.
 */
export const FLOW_EDGE_STYLE: Record<FlowEdgeKind, FlowEdgeStyle> = {
  dep: { stroke: "#c9c3bb", width: 1.25, marker: "dep" },
  done: { stroke: "rgba(17, 17, 17, 0.3)", width: 1.25, marker: "ink" },
  spawn: { stroke: "var(--accent-teal)", width: 1.25, dash: "5 4", marker: "teal" },
  fork: { stroke: "var(--accent-teal)", width: 1.25, dash: "2 3", marker: "teal" },
  merge: { stroke: "var(--accent-teal)", width: 2.25, marker: "teal", double: true },
  hil: { stroke: "var(--accent-rose)", width: 1.25, dash: "4 3", marker: "rose" },
  idle: { stroke: "var(--surface-3)", width: 1.25, dash: "2 4", marker: "none" },
};

/**
 * The style an edge actually renders with, given its proof.
 *
 * The "never dress a claim as a fact" rule: a SPAWN edge the engine proved with
 * an `action: spawn` journal row is drawn solid; one that only a `claim` row
 * stands behind keeps the dashed `5 4` pattern. Every other kind already encodes
 * proof in its dash or its double line.
 */
export function flowEdgeStyle(kind: FlowEdgeKind, proven?: boolean): FlowEdgeStyle {
  const style = FLOW_EDGE_STYLE[kind];
  if (kind !== "spawn") return style;
  return proven === true ? { ...style, dash: undefined } : style;
}

/** Whether an edge's dash pattern is a claim rather than a fact. */
export function isClaimedEdge(kind: FlowEdgeKind, proven?: boolean): boolean {
  return proven !== true && kind !== "idle";
}

/** The dashed pillar that separates two layer columns (flow.css `.gatepost`). */
export const FLOW_GATEPOST_STYLE = {
  stroke: "var(--surface-3)",
  width: 1,
  dash: "1 5",
} as const;

/** Human-readable label per edge kind, for the legend. */
export const FLOW_EDGE_LABEL: Record<FlowEdgeKind, string> = {
  dep: "dependency",
  done: "done-through",
  spawn: "spawn",
  fork: "fork",
  merge: "merge-back",
  hil: "needs a human",
  idle: "idle",
};

/**
 * Which loop step a journal action lands on. Measured against the real journal
 * (`memory/journal.ndjson`: claim, execute, auto-execute, implement, build, fix,
 * test, release, reflect, correct …) — not invented for the mockup.
 */
const ACTION_STEP: Record<string, number> = {
  select: 2,
  claim: 2,
  act: 3,
  implement: 3,
  build: 3,
  fix: 3,
  harden: 3,
  design: 3,
  document: 3,
  "write-design-doc": 3,
  release: 3,
  triage: 3,
  "triage-correction": 3,
  spawn: 3,
  verify: 4,
  test: 4,
  checker: 4,
  record: 5,
  execute: 5,
  "auto-execute": 5,
  merge: 5,
  report: 6,
  reflect: 6,
};

/**
 * The deepest loop step this task's journal rows prove (1..6, 0 = no rows).
 * This is the "derived from journal rows" half of the rail (frame 2).
 */
export function derivedCycleIndex(node: FlowNode): number {
  let index = 0;
  for (const row of node.journal ?? []) {
    const step = ACTION_STEP[row.action.toLowerCase()] ?? 0;
    if (step > index) index = step;
  }
  return index;
}

/** True when the node carries at least one check and every one of them exited 0. */
export function allChecksPassed(node: FlowNode): boolean {
  const detail = node.checks_detail;
  if (detail && detail.length > 0) return detail.every(check => check.passed);
  return checksOutcome(node) === "passed";
}

/** True when any acceptance check is red — the card may look red and be honest. */
export function hasRedCheck(node: FlowNode): boolean {
  const detail = node.checks_detail;
  if (detail && detail.length > 0) return detail.some(check => !check.passed);
  return checksOutcome(node) === "failed";
}

/** How many acceptance checks the task declares (the engine sends a count). */
export function checksCount(node: FlowNode): number {
  return (
    node.checks ?? node.acceptance_checks?.length ?? node.checks_detail?.length ?? 0
  );
}

/**
 * The aggregate outcome of the last recorded run — from the projection's own
 * field, else from per-check detail, else from the newest journal row that
 * recorded one. `null` means no run is provable, which is NOT the same as green.
 */
export function checksOutcome(node: FlowNode): FlowChecksOutcome {
  if (node.checks_outcome !== undefined) return node.checks_outcome;
  const detail = node.checks_detail;
  if (detail && detail.length > 0) {
    return detail.every(check => check.passed) ? "passed" : "failed";
  }
  for (const row of [...(node.journal ?? [])].reverse()) {
    if (row.checks === "passed" || row.checks === "failed" || row.checks === "skipped") {
      return row.checks;
    }
  }
  return null;
}

/** True when no run is provable — the rail must not be filled past verify. */
export function checksUnproven(node: FlowNode): boolean {
  return checksOutcome(node) === null && checksCount(node) > 0;
}

/** The rail's caption line in the inspector, in one place. */
export function checksOutcomeLabel(node: FlowNode): string {
  const outcome = checksOutcome(node);
  if (outcome === "passed") return "✓ passed (aggregate)";
  if (outcome === "failed") return "✗ failed (aggregate)";
  if (outcome === "skipped") return "— skipped";
  return "— not run / not recorded";
}

export interface RailState {
  /** Filled segments (1..6). 0 = nothing has happened yet. */
  filled: number;
  /** The step the card is ON: 1..6, or 0 when no step is current. */
  current: number;
  step: (typeof FLOW_CYCLE_STEPS)[number] | null;
  /** True when the current segment pulses (`.cycle i.act`). */
  pulsing: boolean;
  /** True when the rail was derived from journal rows rather than a hint. */
  derived: boolean;
}

/**
 * The 6-segment cycle rail, derived — never hand-set.
 *
 * `done` fills all six ONLY when a run is provably green (`checks` passed). A red
 * check stops it at `verify`; an UNPROVABLE outcome also stops there, because "a
 * card is never green unless its checks exited 0" and no run is not a pass. A
 * blocked or todo card has not started: nothing fills.
 */
export function flowRail(node: FlowNode): RailState {
  const derivedIndex = derivedCycleIndex(node);
  const hint = node.cycle?.index != null ? node.cycle.index + 1 : 0;
  const base = derivedIndex > 0 ? derivedIndex : hint;
  const derived = derivedIndex > 0;
  const blockedFromGreen = hasRedCheck(node) || checksUnproven(node);

  if (node.status === "done") {
    const filled = allChecksPassed(node) ? 6 : Math.min(base || 4, 4);
    return {
      filled,
      current: filled,
      step: FLOW_CYCLE_STEPS[filled - 1] ?? null,
      // A finished card is not "in progress" — no pulsing on a done card.
      pulsing: false,
      derived,
    };
  }
  if (node.status === "in_progress") {
    const filled = Math.min(Math.max(base, 1), 6);
    const current = blockedFromGreen ? Math.min(filled, 4) : filled;
    return {
      filled: current,
      current,
      step: FLOW_CYCLE_STEPS[current - 1] ?? null,
      pulsing: true,
      derived,
    };
  }
  // blocked / todo: the task has not started. Nothing on the rail is filled.
  return { filled: 0, current: 0, step: null, pulsing: false, derived };
}

/** "verify · step 4/6" — the rail's caption, only where a step is current. */
export function flowStepLabel(node: FlowNode): string | null {
  const rail = flowRail(node);
  if (!rail.step || node.status !== "in_progress") return null;
  return `${rail.step} · step ${rail.current}/6`;
}

/** A person is required: the task is manual, or it is blocked on a human gate. */
export function needsHuman(node: FlowNode): boolean {
  return (
    node.manual === true ||
    node.status === "blocked" ||
    node.kind === "batch" ||
    node.kind === "gatepost"
  );
}

/**
 * `⚠ hollow` — pb validate's hollow-gate warning. The engine sends a DECORATED
 * string (`"⚠hollow"` / `"✓verified"`), so this tests for the word rather than
 * an exact value; the first version compared to `"hollow"` and could never fire.
 */
export function isHollow(node: FlowNode): boolean {
  return (node.gate_quality ?? "").toLowerCase().includes("hollow");
}

export function attachmentCount(node: FlowNode): number {
  return node.docs?.length ?? 0;
}

/** A journal row's timestamp, whichever field the payload used. */
export function journalTime(row: { ts?: string; at?: string }): string | undefined {
  return row.ts ?? row.at;
}

/**
 * A stop condition may only be ticked when something executable backs it.
 * `met: null` is prose PB cannot evaluate (P1 emits `null` for every clause of a
 * prose stop condition) and renders as an OPEN clause — the painted frame's two
 * ticks were the design's optimism, not engine truth.
 */
export function isProvenCondition(condition: FlowStopCondition): boolean {
  return condition.met === true;
}

export function isOpenCondition(condition: FlowStopCondition): boolean {
  return condition.met !== true;
}

/** True when a human gate is declared but its command has not been executed. */
export function isUnevaluatedGate(node: FlowNode): boolean {
  return node.kind === "gatepost" && node.gate?.evaluated === false;
}

/** The card's micro-row checks summary: count first, red only when provable. */
export function checksSummary(node: FlowNode): string {
  const count = checksCount(node);
  if (count === 0) return "no checks";
  if (hasRedCheck(node)) return `checks ${count} · red`;
  if (checksUnproven(node)) return `checks ${count} · not run`;
  return `checks ${count}`;
}

// ─── the bottom-strip counts (never hard-coded) ───

/**
 * Whether the payload actually declares layers. This playbook declares none, so
 * every node arrives at `L1`: the room then draws ONE column (plus the bookends)
 * and says "no layers declared — flat view" instead of implying strata that do
 * not exist.
 */
export function hasDeclaredLayers(graph: FlowGraph): boolean {
  const tasks = graph.nodes.filter(node => (node.kind ?? "task") === "task");
  if (tasks.some(node => node.declared_layer != null)) return true;
  return new Set(tasks.map(node => node.layer)).size > 1;
}

export interface FlowCounts {
  tasks: number;
  inProgress: number;
  blocked: number;
  done: number;
  /** Human hand-offs (batch NODES) — several gates share one hand-off. */
  batches: number;
  /** Gates collected into those hand-offs (`pb plan --layers --check-gates`). */
  gates: number;
  /** Declared gates whose command has not run: not blockers, not ticks. */
  unevaluatedGates: number;
  forks: number;
}

export function flowCounts(graph: FlowGraph): FlowCounts {
  const tasks = graph.nodes.filter(node => node.kind === "task");
  return {
    tasks: tasks.length,
    inProgress: tasks.filter(node => node.status === "in_progress").length,
    blocked: tasks.filter(node => node.status === "blocked").length,
    done: tasks.filter(node => node.status === "done").length,
    batches: graph.nodes.filter(node => node.kind === "batch").length,
    gates: graph.human.batch.length,
    unevaluatedGates: graph.human.unevaluated_gates?.length ?? 0,
    forks: graph.nodes.filter(node => node.kind === "fork").length,
  };
}

/** "9 tasks · 1 in progress · 2 blocked · 6 done · 1 HIL batch · 2 forks" */
export function flowCountsLine(graph: FlowGraph): string {
  const c = flowCounts(graph);
  const parts = [
    `${c.tasks} tasks`,
    `${c.inProgress} in progress`,
    `${c.blocked} blocked`,
    `${c.done} done`,
  ];
  if (c.batches > 0) parts.push(`${c.batches} HIL batch`);
  if (c.forks > 0) parts.push(`${c.forks} forks`);
  return parts.join(" · ");
}

// ─── frame 3: what steering a selection will actually write ───

export interface SteeringPlan {
  cards: number;
  rows: string;
  goal: string;
  statuses: string;
}

/**
 * The dock states exactly what will be written before it is (DESIGN §2.4):
 * journal rows only, zero status changes.
 */
export function steeringPlan(selected: FlowNode[]): SteeringPlan {
  return {
    cards: selected.length,
    rows: `${selected.length} row${selected.length === 1 ? "" : "s"} · action: comment`,
    goal: "1 cycle-brief edit",
    statuses: "0 — steering never claims work",
  };
}

/** Nodes that the steering dock can act on. */
export function isSteerable(node: FlowNode): boolean {
  return node.kind === "task" || node.kind === "fork";
}

/** The gate posts sit between layer columns; they are places, not tasks. */
export function isGatepost(node: FlowNode): boolean {
  return node.kind === "gatepost";
}

/**
 * The edge the legend should show: every kind present in the graph, in the
 * painted order. Nothing is listed that the projection does not use.
 */
export function edgeKindsInUse(graph: FlowGraph): FlowEdgeKind[] {
  const order: FlowEdgeKind[] = ["dep", "done", "spawn", "fork", "merge", "hil", "idle"];
  const used = new Set(graph.edges.map(edge => edge.kind));
  return order.filter(kind => used.has(kind));
}
