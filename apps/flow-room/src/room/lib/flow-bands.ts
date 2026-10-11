// ─── Flow room v2 — the layer view (D21; contract G1–G5) ───
//
// The canvas has a type: each layer of the plan is a shaded BAND, and the band is the
// layout guide. Bands run left → right in plan order (declared layers first, then the
// bands derived from dependency depth, hatched). Inside a band, cards stand in columns
// of at most six, in the order a person reads them — needs you, working, blocked,
// ready, drafts — and finished work is one STACK at the end (G3). A gate post stands
// between two bands and shows the gate's last real result, or "not run" (G4).
//
// Pure: same graph + same view state in, same rectangles out. The room draws exactly
// these rects, so the geometry test (card ⊂ band, G2) asserts what is on screen.

import { FACE_W, faceHeight, faceState } from "./flow-face";
import { flowLegendRequiredSize } from "./flow-derive";
import type { FlowGraph, FlowLayerInfo, FlowNode } from "./flow-types";
import type { FlowLayoutNode, FlowLayoutResult, FlowRect } from "./flow-layout";

export const BAND_MAX_ROWS = 6;
export const BAND_CARD_W = FACE_W;
export const BAND_COL_GAP = 24;
export const BAND_ROW_GAP = 16;
export const BAND_PAD = 32;
export const BAND_HEAD = 132;
export const BAND_FOOT = 92;
export const BAND_GUTTER = 64;
export const BAND_MIN_W = 440;
export const BAND_TOP = 40;
export const BOOKEND_W = 288;
export const BOOKEND_H = 300;
export const STACK_H = 150;
export const DRAFT_H = 196;
export const BATCH_H = 170;

/** G3: the reading order inside a band. Lower comes first; done goes to the stack. */
export const BAND_RANK = { you: 0, working: 1, decided: 1, blocked: 2, ready: 3, draft: 4, done: 5, closed: 5 } as const;

export interface BandDraft {
  id: string;
  band: string;
  title: string;
  kind: "follow-up" | "card";
  /** The card a follow-up comes from (`pb plan --dep <from>`). */
  from?: string;
}

export interface BandView {
  /** Bands whose done cards are spread out instead of stacked. */
  expanded?: string[];
  drafts?: BandDraft[];
}

export interface Band {
  id: string;
  name: string | null;
  about: string | null;
  source: "declared" | "derived";
  /** 0 = the lowest layer, darkest band (G1). */
  depth: number;
  gate: string | null;
  gateResult: FlowLayerInfo["gate_result"];
  human: boolean;
  /** Open cards in reading order (G3). */
  open: FlowNode[];
  /** Finished cards: stacked unless the band is expanded. */
  done: FlowNode[];
  provenDone: number;
  drafts: BandDraft[];
  live: number;
  needsYou: number;
}

export interface BandRect extends FlowRect {
  id: string;
  band: Band;
}

export interface GatePost {
  id: string;
  /** The band whose gate this is — the post stands at its right edge. */
  band: string;
  x: number;
  y: number;
  height: number;
  text: string;
  state: FlowLayerInfo["gate_result"]["state"];
  title: string;
}

export interface StackNode extends FlowNode {
  kind: "stack";
  stack: { band: string; ids: string[]; proven: number };
}

export interface DraftNode extends FlowNode {
  kind: "draft";
  draft: BandDraft;
}

export interface LayerLayout extends FlowLayoutResult {
  bands: BandRect[];
  gateposts: GatePost[];
  /** View-made nodes the room must draw (stacks and drafts). */
  extraNodes: (StackNode | DraftNode)[];
  /** Done task id → the stack that stands for it (edges are re-pointed there). */
  stackOf: Record<string, string>;
}

const isTask = (n: FlowNode) => (n.kind ?? "task") === "task";

/** The band a task belongs to: its declared layer, else a derived band by depth. */
export function bandIdFor(node: FlowNode, declared: Set<string>): string {
  if (node.declared_layer && declared.has(node.declared_layer)) return node.declared_layer;
  const d = typeof node.derived_layer === "number" ? node.derived_layer : 0;
  return declared.size ? `D${d + 1}` : `L${d + 1}`;
}

/** G3: sort a band's open cards — needs you, working, blocked, ready — then priority, then id. */
export function sortOpen(nodes: FlowNode[]): FlowNode[] {
  return [...nodes].sort((a, b) => {
    const ra = BAND_RANK[faceState(a).kind];
    const rb = BAND_RANK[faceState(b).kind];
    return ra - rb || (a.priority ?? 9) - (b.priority ?? 9) || a.id.localeCompare(b.id);
  });
}

/**
 * G1: the plan's bands. Declared layers come from `layers[]` (or, for an engine that
 * does not send it yet, from the declared layers the nodes carry); every task without a
 * declared layer lands in a hatched band derived from its dependency depth. A declared
 * layer with no tasks still gets its band — the plan says it exists.
 */
export function bandsFor(graph: FlowGraph, view: BandView = {}): Band[] {
  const tasks = graph.nodes.filter(isTask);
  const infos = (graph.layers ?? []).filter(l => l.source === "declared");
  const declaredIds = infos.length
    ? infos.map(l => l.id)
    : [...new Set(tasks.map(t => t.declared_layer).filter((x): x is string => !!x))].sort();
  const declared = new Set(declaredIds);
  const derivedInfo = new Map((graph.layers ?? []).filter(l => l.source === "derived").map(l => [l.id, l]));
  const members = new Map<string, FlowNode[]>();
  for (const t of tasks) {
    const id = bandIdFor(t, declared);
    if (!members.has(id)) members.set(id, []);
    members.get(id)!.push(t);
  }
  const derivedIds = [...members.keys()].filter(id => !declared.has(id)).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  const drafts = view.drafts ?? [];
  // a follow-up drafted past the last band opens a new (derived) band for itself
  for (const d of drafts) if (!declared.has(d.band) && !derivedIds.includes(d.band)) derivedIds.push(d.band);
  const order = [...declaredIds, ...derivedIds];
  return order.map((id, depth) => {
    const info = infos.find(l => l.id === id) ?? derivedInfo.get(id);
    const isDeclared = declared.has(id);
    const all = members.get(id) ?? [];
    const done = all.filter(n => n.status === "done").sort((a, b) => a.id.localeCompare(b.id));
    const open = sortOpen(all.filter(n => n.status !== "done"));
    return {
      id,
      name: info?.name ?? null,
      about: info?.about ?? (isDeclared ? null : `derived from dependencies · depth ${id.slice(1)}`),
      source: isDeclared ? "declared" : "derived",
      depth,
      gate: info?.gate ?? null,
      gateResult: info?.gate_result ?? { state: info?.gate ? "not-run" : "no-gate" },
      human: !!info?.human,
      open,
      done,
      provenDone: done.filter(n => faceState(n).kind === "done").length,
      drafts: drafts.filter(d => d.band === id),
      live: open.filter(n => faceState(n).kind === "working").length,
      needsYou: open.filter(n => faceState(n).kind === "you").length,
    };
  });
}

/** G4: the gate post's words come from the gate's last real result — never a guess. */
export function gatePostText(band: Band): { text: string; state: GatePost["state"]; title: string } {
  const r = band.gateResult;
  if (!band.gate) return { text: "no gate", state: "no-gate", title: `${band.id} declares no gate` };
  const when = r.at ? ` (${r.at.slice(0, 16).replace("T", " ")})` : "";
  if (r.state === "pass") return { text: `${band.id} gate: pass`, state: "pass", title: `${band.gate}\nlast run passed${when}` };
  // a gate past its limit reached no verdict: not a pass, and never called a failure
  if (r.state === "timeout") return { text: `${band.id} gate: timed out`, state: "timeout", title: `${band.gate}
the last run passed its time limit${r.limit_ms ? ` (${r.limit_ms}ms)` : ""}${when} — no verdict, the layers above stay blocked` };
  if (r.state === "output-limit") return { text: `${band.id} gate: output limit`, state: "output-limit", title: `${band.gate}
the last run printed more than the runner accepts${when} — no verdict` };
  if (r.state === "fail") return { text: `${band.id} gate: fail`, state: "fail", title: `${band.gate}\nlast run failed${when}${r.output ? `\n${r.output}` : ""}` };
  return { text: `${band.id} gate: not run`, state: "not-run", title: `${band.gate}\n${r.reason ?? "no claim has evaluated this gate yet"}` };
}

function stackNodeFor(band: Band): StackNode {
  const proven = band.provenDone;
  const n = band.done.length;
  return {
    id: `stack:${band.id}`,
    kind: "stack",
    title: `${n} finished in ${band.id}`,
    status: "done",
    layer: band.id,
    stack: { band: band.id, ids: band.done.map(d => d.id), proven },
  };
}

function draftNodeFor(d: BandDraft): DraftNode {
  return { id: `draft:${d.id}`, kind: "draft", title: d.title, status: "todo", layer: d.band, draft: d };
}

/** The layer view's geometry. Bookends stand outside the bands; the HIL batch under the start. */
export function layoutLayers(graph: FlowGraph, view: BandView = {}): LayerLayout {
  const bands = bandsFor(graph, view);
  const expanded = new Set(view.expanded ?? []);
  const placed: FlowLayoutNode[] = [];
  const extraNodes: (StackNode | DraftNode)[] = [];
  const stackOf: Record<string, string> = {};
  const lists = bands.map(band => {
    const items: { node: FlowNode; h: number }[] = band.open.map(n => ({ node: n, h: faceHeight(n) }));
    for (const d of band.drafts) items.push({ node: draftNodeFor(d), h: DRAFT_H });
    if (band.done.length) {
      if (expanded.has(band.id)) for (const n of band.done) items.push({ node: n, h: faceHeight(n) });
      else {
        const s = stackNodeFor(band);
        items.push({ node: s, h: STACK_H });
        for (const id of s.stack.ids) stackOf[id] = s.id;
      }
    }
    const columns: { node: FlowNode; h: number }[][] = [];
    items.forEach((it, k) => { (columns[Math.floor(k / BAND_MAX_ROWS)] ??= []).push(it); });
    const colH = columns.map(col => col.reduce((sum, it) => sum + it.h, 0) + Math.max(0, col.length - 1) * BAND_ROW_GAP);
    return { band, columns, tallest: Math.max(0, ...colH) };
  });
  const innerH = Math.max(STACK_H, ...lists.map(l => l.tallest));
  const bandH = BAND_HEAD + innerH + BAND_FOOT;

  let x = 0;
  const start = graph.nodes.find(n => n.kind === "start");
  const goal = graph.nodes.find(n => n.kind === "goal");
  const batch = graph.nodes.find(n => n.kind === "batch");
  const push = (n: FlowNode, rx: number, ry: number, w: number, h: number, column: number) =>
    placed.push({ id: n.id, kind: n.kind, layer: n.layer, x: rx, y: ry, width: w, height: h, column, rank: column, band: false, gatepost: false });
  if (start) {
    push(start, x, BAND_TOP + BAND_HEAD, BOOKEND_W, BOOKEND_H, 0);
    if (batch) push(batch, x, BAND_TOP + BAND_HEAD + BOOKEND_H + BAND_ROW_GAP * 2, BOOKEND_W, BATCH_H, 0);
    x += BOOKEND_W + BAND_GUTTER;
  }
  const bandRects: BandRect[] = [];
  const gateposts: GatePost[] = [];
  lists.forEach(({ band, columns }, i) => {
    const cols = Math.max(1, columns.length);
    const inner = cols * BAND_CARD_W + (cols - 1) * BAND_COL_GAP;
    const w = Math.max(inner + 2 * BAND_PAD, BAND_MIN_W);
    const off = (w - inner) / 2;
    bandRects.push({ id: `band:${band.id}`, band, x, y: BAND_TOP, width: w, height: bandH });
    columns.forEach((col, c) => {
      let y = BAND_TOP + BAND_HEAD;
      for (const it of col) {
        const nx = x + off + c * (BAND_CARD_W + BAND_COL_GAP);
        push(it.node, nx, y, BAND_CARD_W, it.h, i + 1);
        if (it.node.kind === "stack" || it.node.kind === "draft") extraNodes.push(it.node as StackNode | DraftNode);
        y += it.h + BAND_ROW_GAP;
      }
    });
    x += w;
    const g = gatePostText(band);
    // a post only where the plan declares a gate: "no gate" between derived bands is noise
    if (band.gate) {
      gateposts.push({ id: `gate:${band.id}`, band: band.id, x: x + BAND_GUTTER / 2, y: BAND_TOP - 30, height: bandH + 30, ...g });
    }
    x += BAND_GUTTER;
  });
  if (goal) push(goal, x, BAND_TOP + BAND_HEAD, BOOKEND_W + 10, BOOKEND_H, lists.length + 1);
  const right = goal ? x + BOOKEND_W + 10 : x - BAND_GUTTER;
  const bottom = BAND_TOP + bandH;
  const legendSize = flowLegendRequiredSize(graph);
  const legend: FlowRect = { x: 0, y: bottom + 24, width: legendSize.width, height: legendSize.height };
  const width = Math.max(right, legend.width) + 16;
  const height = legend.y + legend.height + 16;
  return {
    nodes: placed,
    columns: [],
    gateLabels: [],
    chrome: { legend, chipbar: { x: width - 336, y: 14, width: 320, height: 28 } },
    width,
    height,
    engine: "dagre",
    ranks: {},
    warnings: [],
    declutterMoved: 0,
    bands: bandRects,
    gateposts,
    extraNodes,
    stackOf,
  };
}

/** The draft's engine command, said out loud before anything is written (J3). */
export function draftCommand(d: BandDraft, declared: boolean): string {
  const goal = JSON.stringify(d.title || "…");
  if (d.kind === "follow-up") return `pb plan --goal ${goal} --dep ${d.from}${declared ? ` --layer ${d.band}` : ""}`;
  return `pb plan --goal ${goal}${declared ? ` --layer ${d.band}` : ""}`;
}

/** J2: a follow-up lands one band later than its card (a new derived band if it is the last). */
export function nextBandId(bands: Band[], from: string): string {
  const i = bands.findIndex(b => b.id === from);
  if (i >= 0 && i < bands.length - 1) return bands[i + 1].id;
  const derived = bands.filter(b => b.source === "derived").length;
  const anyDeclared = bands.some(b => b.source === "declared");
  return anyDeclared ? `D${derived + 1}` : `L${bands.length + 1}`;
}
