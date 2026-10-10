// ─── Flow room — the layout adapter ───
//
// The projection carries NO coordinates (DESIGN §1.5: card positions are view
// state, never engine state). This module turns a `FlowGraph` into positions,
// left → right, exactly as the painted frames do:
//
//   START · LOOP  │ gate │  L0  │ gate │  L1  │ gate │  L2  │  END GOAL
//                            └── bottom band: orchestrator · forks · HIL ──┘
//
// What the engine is for (@dagrejs/dagre): ranking + crossing-minimised row
// order + spacing. The x axis is PB's OWN derived layering — the adapter feeds
// dagre the real dependency edges with `minlen` taken from the declared layer
// delta, then snaps every node onto its layer column. When dagre's rank
// disagrees, the declared layer wins and the disagreement is reported in
// `warnings` instead of being silently re-ranked.
//
// On top of dagre this file owns four geometric guarantees, because a build gate
// cannot see a picture and the Lead's live render found all four:
//
//   1. NO TWO NODE RECTS overlap or sit closer than FLOW_MIN_GUTTER — dagre's
//      output is de-collided until the pairwise invariant holds (pure, iterated,
//      deterministic; never a CSS nudge).
//   2. NO EDGE-LABEL BOX intersects a node rect, a gate pill, another label or
//      the reserved legend. A label that fits nowhere is SUPPRESSED (visible:
//      false) rather than clipped — a clipped label lies about what it says.
//   3. The gate pills live in a reserved top strip and the legend in a reserved
//      bottom-left rect: both are canvas-space, so the guarantee is exact.
//   4. The reserved rects are part of the layout's width/height, so `fitView`
//      maps the whole picture (labels included) into the viewport.

import dagre from "@dagrejs/dagre";
import { flowLegendRequiredSize, gateLabelText } from "./flow-derive";
import type { FlowEdge, FlowGraph, FlowNode } from "./flow-types";

/** Card geometry, measured from the painted frames (flow.css `.card`). */
export const FLOW_CARD_W = 236;
export const FLOW_CARD_H = 104;
export const FLOW_COLUMN_GAP = 36;
/** Vertical gap between two cards in a column (frame 1: 44 → 164 with h104). */
export const FLOW_ROW_GAP = 16;
/** The bottom band starts this far below the tallest column. */
export const FLOW_BAND_GAP = 40;
export const FLOW_MARGIN = 14;
/** Cards start below the gate-label strip — frame 1 puts them at y = 44. */
export const FLOW_CONTENT_TOP = 44;
/** The reserved strip the gate pills live in (frame 1: pills at y = 14). */
export const FLOW_GATE_LABEL_TOP = 14;
export const FLOW_GATE_LABEL_H = 18;

/**
 * The minimum gutter every pair of node rects must keep. The painted frames use
 * 16 px vertically and 36 px between columns; 12 is the floor this file enforces.
 */
export const FLOW_MIN_GUTTER = 12;

/**
 * The floating legend's reserve is DERIVED from the legend's own drawn content
 * (`flowLegendModel` → `flowLegendContentSize`), never a literal: the old
 * 660x104 constant was smaller than the ~105-121 px the rows actually need, so
 * the legend was clipped at the canvas bottom. `FLOW_LEGEND_GAP` is the only
 * literal left, and it is a gap, not a size.
 */
export const FLOW_LEGEND_GAP = 16;

/** The top-right status chips reserve, so a card never sits under them. */
export const FLOW_CHIPBAR_RESERVE = { width: 320, height: 28 };

/** Label box metrics: JetBrains/Geist Mono at 8.5 px, plus the pill's padding. */
export const FLOW_LABEL_CHAR_W = 5.4;
export const FLOW_LABEL_PAD = 14;
export const FLOW_LABEL_H = 16;

export const FLOW_BOOKEND_H = 300;
export const FLOW_ORCHESTRATOR_H = 140;
export const FLOW_FORK_H = 124;
export const FLOW_BATCH_H = 170;

export interface FlowSize {
  width: number;
  height: number;
}

export interface FlowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Conservative pill width from the label text (no DOM available here). */
export function estimateLabelWidth(text: string): number {
  return Math.round(text.length * FLOW_LABEL_CHAR_W) + FLOW_LABEL_PAD;
}

/** True when two rects touch or overlap, allowing `pad` of slack on each side. */
export function rectsIntersect(a: FlowRect, b: FlowRect, pad = 0): boolean {
  return (
    a.x - pad < b.x + b.width &&
    b.x - pad < a.x + a.width &&
    a.y - pad < b.y + b.height &&
    b.y - pad < a.y + a.height
  );
}

/** True when two rects are closer than `gutter` on both axes. */
export function rectsCrowd(a: FlowRect, b: FlowRect, gutter: number): boolean {
  return rectsIntersect(a, b, gutter);
}

/** Card size per node kind — the frames draw five different card heights. */
export function flowNodeSize(node: FlowNode): FlowSize {
  switch (node.kind) {
    case "start":
      return { width: FLOW_CARD_W, height: FLOW_BOOKEND_H };
    case "goal":
      return { width: 246, height: FLOW_BOOKEND_H };
    case "orchestrator":
      return { width: FLOW_CARD_W, height: FLOW_ORCHESTRATOR_H };
    case "fork":
      return { width: FLOW_CARD_W, height: FLOW_FORK_H };
    case "batch":
      return { width: FLOW_CARD_W, height: FLOW_BATCH_H };
    default:
      return { width: FLOW_CARD_W, height: FLOW_CARD_H };
  }
}

/** The column order of the room: the loop, three layers, the goal. */
export const FLOW_LAYER_ORDER = ["START", "L0", "L1", "L2", "GOAL"] as const;

export type FlowLayer = (typeof FLOW_LAYER_ORDER)[number];

/** `START` → 0, `L0` → 1 … `GOAL` → 4; an unlisted `Ln` follows the same rule. */
export function flowLayerIndex(layer: string): number {
  const index = (FLOW_LAYER_ORDER as readonly string[]).indexOf(layer);
  if (index >= 0) return index;
  const match = /^L(\d+)$/.exec(layer);
  return match ? 1 + Number(match[1]) : 1;
}

/** The bottom band: a place under the columns, not a layer. */
export function isBandNode(node: FlowNode): boolean {
  return (
    node.kind === "orchestrator" || node.kind === "fork" || node.kind === "batch"
  );
}

export interface FlowLayoutNode extends FlowRect {
  id: string;
  kind: FlowNode["kind"];
  layer: string;
  /** The column's ordinal position, from the DECLARED layer (0 = START). */
  column: number;
  /** dagre's raw rank — opaque numbers, kept for the cross-check only. */
  rank: number;
  band: boolean;
  gatepost: boolean;
}

export interface FlowLayoutColumn {
  layer: string;
  index: number;
  x: number;
  width: number;
  /** The gate post that guards this column's right edge, if the graph has one. */
  gateId?: string;
}

/** A gate pill's canvas-space box — asserted against node rects. */
export interface FlowGateLabel extends FlowRect {
  id: string;
  text: string;
}

/** Where one edge label goes, or that it was suppressed. */
export interface FlowLabelBox extends FlowRect {
  edgeKey: string;
  text: string;
  visible: boolean;
  /** Why it was suppressed, for the test and the report. */
  reason?: string;
}

export interface FlowLayoutResult {
  nodes: FlowLayoutNode[];
  columns: FlowLayoutColumn[];
  gateLabels: FlowGateLabel[];
  /** Chrome the layout reserves in canvas space. */
  chrome: { legend: FlowRect; chipbar: FlowRect };
  width: number;
  height: number;
  /** The layout engine, named so the bundle cost is attributable. */
  engine: "dagre";
  /** dagre's raw rank per node. */
  ranks: Record<string, number>;
  /** A declared layer that disagreed with the dependency graph's depth. */
  warnings: string[];
  /** How many nodes the de-collision pass had to move (0 = dagre was clean). */
  declutterMoved: number;
}

/**
 * Push rects apart until no pair crowds another. Pure and deterministic: the
 * lower rect of a crowding pair moves down, and anything crowding a reserved
 * rect moves below it. Iterates because moving one node can crowd the next.
 */
export function declutterRects(
  nodes: FlowLayoutNode[],
  gutter: number,
  reserved: FlowRect[] = []
): number {
  let moved = 0;
  for (let pass = 0; pass < 64; pass += 1) {
    let changed = false;
    const ordered = [...nodes].sort((a, b) => a.y - b.y || a.x - b.x);
    for (let i = 0; i < ordered.length; i += 1) {
      for (let j = i + 1; j < ordered.length; j += 1) {
        const a = ordered[i];
        const b = ordered[j];
        if (!rectsCrowd(a, b, gutter)) continue;
        const [upper, lower] = a.y <= b.y ? [a, b] : [b, a];
        const needed = upper.y + upper.height + gutter - lower.y;
        if (needed > 0) {
          lower.y += needed;
          moved += 1;
          changed = true;
        }
      }
    }
    for (const rect of reserved) {
      for (const node of nodes) {
        if (!rectsCrowd(node, rect, gutter)) continue;
        node.y = rect.y + rect.height + gutter;
        moved += 1;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return moved;
}

/** Lay a projection out left → right. Pure: same graph in, same coordinates out. */
export function layoutFlow(graph: FlowGraph): FlowLayoutResult {
  const nodes = graph.nodes;
  const byId = new Map(nodes.map(node => [node.id, node]));
  const warnings: string[] = [];

  // ── the layered graph ─────────────────────────────────────────────────
  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir: "LR",
    ranksep: FLOW_COLUMN_GAP,
    nodesep: FLOW_ROW_GAP,
    edgesep: 12,
    marginx: FLOW_MARGIN,
    marginy: 0,
  });
  g.setDefaultEdgeLabel(() => ({}));

  const layoutNodes = nodes.filter(node => node.kind !== "gatepost");
  for (const node of layoutNodes) {
    const size = flowNodeSize(node);
    g.setNode(node.id, { width: size.width, height: size.height });
  }
  for (const edge of graph.edges) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) continue;
    if (from.kind === "gatepost" || to.kind === "gatepost") continue;
    // minlen = the layer steps this edge must span, so dagre's rank IS PB's
    // derived layering rather than a second opinion about it.
    const minlen = Math.max(1, flowLayerIndex(to.layer) - flowLayerIndex(from.layer));
    g.setEdge(edge.from, edge.to, { minlen, weight: 1 });
  }

  dagre.layout(g);

  const ranks: Record<string, number> = {};
  const rawRankX = new Map<number, number>();
  for (const node of layoutNodes) {
    const dagreNode = g.node(node.id) as { x: number; rank: number } | undefined;
    if (!dagreNode) continue;
    ranks[node.id] = dagreNode.rank;
    const size = flowNodeSize(node);
    const left = dagreNode.x - size.width / 2;
    const current = rawRankX.get(dagreNode.rank);
    rawRankX.set(dagreNode.rank, current === undefined ? left : Math.min(current, left));
  }

  // ── the declared layers own the axis ──────────────────────────────────
  const dagreY = (id: string): number =>
    (g.node(id) as { y?: number } | undefined)?.y ?? 0;

  const layerIndexes = [
    ...new Set(layoutNodes.map(node => flowLayerIndex(node.layer))),
  ].sort((a, b) => a - b);

  const layerRank = new Map<number, number>();
  const rankToLayer = new Map<number, number>();
  for (const layer of layerIndexes) {
    const layerNodes = layoutNodes.filter(node => flowLayerIndex(node.layer) === layer);
    const rawRanks = [...new Set(layerNodes.map(node => ranks[node.id]))].sort(
      (a, b) => a - b
    );
    if (rawRanks.length > 1) {
      warnings.push(
        `layer ${layerNodes[0].layer}: nodes land on ${rawRanks.length} different depths in the dependency graph`
      );
    }
    const rank = rawRanks[0];
    layerRank.set(layer, rank);
    if (rank !== undefined) {
      const clash = rankToLayer.get(rank);
      if (clash !== undefined) {
        warnings.push(
          `layers ${clash} and ${layer} sit at the same depth in the dependency graph`
        );
      } else {
        rankToLayer.set(rank, layer);
      }
    }
  }
  for (let i = 1; i < layerIndexes.length; i += 1) {
    const previous = layerRank.get(layerIndexes[i - 1]);
    const current = layerRank.get(layerIndexes[i]);
    if (previous === undefined || current === undefined) continue;
    if (current < previous) {
      warnings.push(
        `layer order contradicts the dependency graph (layer index ${layerIndexes[i]} ranks before ${layerIndexes[i - 1]})`
      );
    }
  }

  /**
   * The column x comes from the DECLARED layer's ordinal on a uniform grid at the
   * painted pitch (236 + 36 = 272). Dagre's raw ranks are used for the warning
   * cross-check and for row order, never as the axis: with a flat payload its
   * ranks collapse (nodes without edges rank 0), which would put the task column
   * on top of the START bookend.
   */
  const columnXFor = (layer: number): number =>
    FLOW_MARGIN + layerIndexes.indexOf(layer) * (FLOW_CARD_W + FLOW_COLUMN_GAP);
  const layerName = (index: number): string =>
    layoutNodes.find(node => flowLayerIndex(node.layer) === index)?.layer ?? `L${index - 1}`;

  const sortByEngine = (list: FlowNode[]) =>
    [...list].sort((a, b) => dagreY(a.id) - dagreY(b.id));

  // ── rows: dagre orders, this file stacks ──────────────────────────────
  const placed: FlowLayoutNode[] = [];
  let mainBottom = FLOW_CONTENT_TOP;
  for (const layer of layerIndexes) {
    const inColumn = layoutNodes.filter(node => flowLayerIndex(node.layer) === layer);
    const main = sortByEngine(inColumn.filter(node => !isBandNode(node)));
    const band = sortByEngine(inColumn.filter(node => isBandNode(node)));
    const anchor = main[0] ?? band[0];
    if (!anchor) continue;
    const x = columnXFor(layer);
    let y = FLOW_CONTENT_TOP;

    for (const node of main) {
      const size = flowNodeSize(node);
      placed.push({
        id: node.id,
        kind: node.kind,
        x,
        y,
        width: size.width,
        height: size.height,
        layer: node.layer,
        column: layerIndexes.indexOf(layer),
        rank: ranks[node.id],
        band: false,
        gatepost: false,
      });
      y += size.height + FLOW_ROW_GAP;
    }
    if (main.length > 0) mainBottom = Math.max(mainBottom, y - FLOW_ROW_GAP);

    // The band keeps dagre's row order inside its column; its shared top is
    // resolved in the second pass below.
    let bandY = 0;
    for (const node of band) {
      const size = flowNodeSize(node);
      placed.push({
        id: node.id,
        kind: node.kind,
        x,
        y: bandY,
        width: size.width,
        height: size.height,
        layer: node.layer,
        column: layerIndexes.indexOf(layer),
        rank: ranks[node.id],
        band: true,
        gatepost: false,
      });
      bandY += size.height + FLOW_ROW_GAP;
    }
  }

  // The band is ONE row shared by every column, starting under the tallest main
  // column — that is what keeps the orchestrator, both forks and the human batch
  // on the same line (frame 1).
  const bandTop = mainBottom + FLOW_BAND_GAP;
  for (const layer of layerIndexes) {
    const bandHere = placed
      .filter(node => node.band && node.column === layerIndexes.indexOf(layer))
      .sort((a, b) => a.y - b.y);
    let offset = 0;
    for (const node of bandHere) {
      node.y = bandTop + offset;
      offset += node.height + FLOW_ROW_GAP;
    }
  }

  // Bookends are tall: centre them on the task block, not on the band.
  const taskBlocks = placed.filter(
    node => node.kind === "task" || node.kind === "fork" || node.kind === "orchestrator"
  );
  const taskTop = FLOW_CONTENT_TOP;
  const taskBottom = Math.max(
    ...taskBlocks.map(node => node.y + node.height),
    taskTop + FLOW_CARD_H
  );
  for (const node of placed) {
    if (node.kind !== "start" && node.kind !== "goal") continue;
    node.y = Math.max(
      FLOW_CONTENT_TOP,
      Math.round(taskTop + (taskBottom - taskTop - node.height) / 2)
    );
  }

  // ── reserved chrome, in canvas space ──────────────────────────────────
  const contentBottom = Math.max(...placed.map(node => node.y + node.height));
  // The legend's size is its drawn content, so the panel can never clip a row.
  const legendSize = flowLegendRequiredSize(graph);
  const legend: FlowRect = {
    x: FLOW_MARGIN,
    y: contentBottom + FLOW_LEGEND_GAP,
    width: legendSize.width,
    height: legendSize.height,
  };

  // ── de-collision: the pairwise gutter invariant, enforced ─────────────
  const declutterMoved = declutterRects(placed, FLOW_MIN_GUTTER, [legend]);

  // ── gate pills: a reserved top strip nobody else may enter ────────────
  const gateposts = nodes.filter(node => node.kind === "gatepost");
  const gateLabels: FlowGateLabel[] = [];
  for (const gate of gateposts) {
    const guardLayer = flowLayerIndex(gate.layer);
    const guardX = columnXFor(guardLayer);
    const pillarX = Math.round(guardX + FLOW_CARD_W + FLOW_COLUMN_GAP / 2);
    const text = gateLabelText(gate);
    const width = estimateLabelWidth(text);
    gateLabels.push({
      id: gate.id,
      text,
      x: Math.round(pillarX - width / 2),
      y: FLOW_GATE_LABEL_TOP,
      width,
      height: FLOW_GATE_LABEL_H,
    });
    placed.push({
      id: gate.id,
      kind: gate.kind,
      x: pillarX,
      y: FLOW_CONTENT_TOP,
      width: 1,
      height: Math.max(FLOW_CARD_H, mainBottom - FLOW_CONTENT_TOP),
      layer: gate.layer,
      column: layerIndexes.indexOf(guardLayer),
      rank: layerRank.get(guardLayer) ?? 0,
      band: false,
      gatepost: true,
    });
  }

  const columns: FlowLayoutColumn[] = layerIndexes.map(layer => {
    const inColumn = layoutNodes.filter(node => flowLayerIndex(node.layer) === layer);
    const width = inColumn.reduce(
      (max, node) => Math.max(max, flowNodeSize(node).width),
      FLOW_CARD_W
    );
    const gate = gateposts.find(post => flowLayerIndex(post.layer) === layer);
    return {
      layer: layerName(layer),
      index: layer,
      x: columnXFor(layer),
      width,
      gateId: gate?.id,
    };
  });

  const width =
    Math.max(
      ...placed.map(node => node.x + node.width),
      legend.x + legend.width,
      FLOW_CARD_W
    ) + FLOW_MARGIN;
  const height =
    Math.max(
      ...placed.map(node => node.y + node.height),
      legend.y + legend.height,
      FLOW_CARD_H
    ) + FLOW_MARGIN;

  const chipbar: FlowRect = {
    x: width - FLOW_CHIPBAR_RESERVE.width - FLOW_MARGIN,
    y: FLOW_MARGIN,
    width: FLOW_CHIPBAR_RESERVE.width,
    height: FLOW_CHIPBAR_RESERVE.height,
  };

  return {
    nodes: placed,
    columns,
    gateLabels,
    chrome: { legend, chipbar },
    width: Math.round(width),
    height: Math.round(height),
    engine: "dagre",
    ranks,
    warnings,
    declutterMoved,
  };
}

// ── what the room fits, so the reserved legend is on screen ──────────────

/** The fit padding the room uses (React Flow applies it inside the viewport). */
export const FLOW_FIT_PADDING = 0.06;

/**
 * What the room hands `fitBounds`: the LAYOUT's own rect, legend reserve included.
 *
 * Fitting the nodes' bounding box instead (React Flow's default `fitView`) leaves
 * the reserved legend band below the fold — exactly how the legend ended up
 * off-viewport with only its top sliver showing at the canvas bottom.
 */
export function flowFitBounds(layout: FlowLayoutResult): FlowRect {
  return { x: 0, y: 0, width: layout.width, height: layout.height };
}

/** True when the legend's reserved rect lies inside the rect the room fits. */
export function legendInsideFitBounds(layout: FlowLayoutResult): boolean {
  const fit = flowFitBounds(layout);
  const legend = layout.chrome.legend;
  return (
    legend.x >= fit.x &&
    legend.y >= fit.y &&
    legend.x + legend.width <= fit.x + fit.width &&
    legend.y + legend.height <= fit.y + fit.height
  );
}

// ── edge labels: placed where they fit, suppressed where they do not ─────

/** Where a node sits in a layout result. */
export function layoutNodeById(
  layout: FlowLayoutResult,
  id: string
): FlowLayoutNode | undefined {
  return layout.nodes.find(node => node.id === id);
}

export function edgeKeyOf(edge: FlowEdge, index: number): string {
  return `${edge.from}->${edge.to}:${edge.kind}:${index}`;
}

/**
 * Place every edge label. A label is only drawn when its box fits in free canvas
 * space: it must not intersect a node rect, a gate pill, another label or the
 * reserved legend. Candidates are tried in order (gutter → midpoint, above →
 * below) and the label is SUPPRESSED when none fits — never clipped.
 */
export function placeEdgeLabels(
  edges: FlowEdge[],
  layout: FlowLayoutResult
): FlowLabelBox[] {
  const rectOf = (id: string): FlowLayoutNode | undefined =>
    layout.nodes.find(node => node.id === id);
  const obstacles: FlowRect[] = [
    ...layout.nodes.map(node => ({
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
    })),
    ...layout.gateLabels.map(label => ({
      x: label.x,
      y: label.y,
      width: label.width,
      height: label.height,
    })),
    layout.chrome.legend,
  ];

  const boxes: FlowLabelBox[] = [];
  const placedLabels: FlowRect[] = [];

  edges.forEach((edge, index) => {
    const key = edgeKeyOf(edge, index);
    if (!edge.label) return;
    const from = rectOf(edge.from);
    const to = rectOf(edge.to);
    if (!from || !to) return;

    const width = estimateLabelWidth(edge.label);
    const height = FLOW_LABEL_H;
    const sourceX = from.x + from.width;
    const sourceY = from.y + from.height / 2;
    const targetX = to.x;
    const targetY = to.y + to.height / 2;
    const midX = (sourceX + targetX) / 2;
    void sourceY;
    void targetY;
    // A vertical corridor between the two columns (where a gate post stands).
    const gutterX =
      layout.gateLabels
        .map(label => label.x + label.width / 2)
        .filter(x => x > Math.min(sourceX, targetX) && x < Math.max(sourceX, targetX))
        .sort((a, b) => Math.abs(a - midX) - Math.abs(b - midX))[0] ?? midX;
    const aboveY = Math.min(from.y, to.y) - 12;
    const belowY = Math.max(from.y + from.height, to.y + to.height) + 14;

    const candidates: { x: number; y: number }[] = [
      { x: gutterX, y: aboveY },
      { x: midX, y: aboveY },
      { x: gutterX, y: belowY },
      { x: midX, y: belowY },
    ];

    let chosen = false;
    let reason = "no candidate cleared the nodes";
    for (const candidate of candidates) {
      const box: FlowRect = {
        x: Math.round(candidate.x - width / 2),
        y: Math.round(candidate.y - height / 2),
        width,
        height,
      };
      if (box.x < FLOW_MARGIN || box.y < FLOW_GATE_LABEL_TOP) {
        reason = "outside the canvas margin";
        continue;
      }
      const hits = [...obstacles, ...placedLabels].some(obstacle =>
        rectsIntersect(box, obstacle, 2)
      );
      if (hits) {
        reason = "would sit under a card, a gate pill or another label";
        continue;
      }
      chosen = true;
      placedLabels.push(box);
      boxes.push({ edgeKey: key, text: edge.label, ...box, visible: true });
      break;
    }
    if (!chosen) {
      boxes.push({
        edgeKey: key,
        text: edge.label,
        x: Math.round(midX - width / 2),
        y: Math.round(aboveY - height / 2),
        width,
        height,
        visible: false,
        reason,
      });
    }
  });

  return boxes;
}
