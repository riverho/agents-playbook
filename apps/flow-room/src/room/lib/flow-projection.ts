// ─── Flow room — projection → React Flow elements ───
//
// The bridge between what the adapter returns (`FlowGraph`) and what the canvas
// draws (React Flow nodes/edges). It lives in `lib/`, not in the room component,
// for two reasons:
//
//   1. it is testable without a DOM — the contract "every node has a registered
//      type, every edge points at nodes that exist, every card carries the data
//      its renderer reads" can be asserted in the node test environment;
//   2. the room component stays a pure renderer of these two lists.
//
// Nothing here is engine truth: it only copies projection fields and adds the
// view-only flags (spawn pop-in, the gate post's non-selectability).

import type { Edge, Node } from "@xyflow/react";
import type { FlowLabelBox, FlowLayoutResult, FlowRect } from "./flow-layout";
import { layoutFlow, placeEdgeLabels } from "./flow-layout";
import type {
  FlowEdgeEvidence,
  FlowEdgeKind,
  FlowGraph,
  FlowHumanBatch,
  FlowNode,
  FlowNodeKind,
} from "./flow-types";
import type { SteeringPlan } from "./flow-derive";
import { gateLabelText } from "./flow-derive";
import type { BandRect, GatePost, LayerLayout } from "./flow-bands";

/** What every flow card component receives. */
export interface FlowCardData extends Record<string, unknown> {
  node: FlowNode;
  width: number;
  height: number;
  /** True when this card is the target of a spawn edge (it pops in). */
  spawned?: boolean;
  /** The human batch entries (batch card only). */
  batch?: FlowHumanBatch[];
  /** Declared-but-unexecuted gates — labelled, never counted as blockers. */
  unevaluated?: FlowHumanBatch[];
  /** True when this goal card's fork passed its checker gate. */
  mergeBack?: { verdict: string; fork: string };
  /** Start bookend: the loop epoch and the host's cadence, from the projection. */
  loopId?: string;
  phase?: number;
  mode?: string;
  tasksClosed?: string;
  cron?: FlowNode["cron"];
  metrics?: FlowNode["metrics"];
  /** Gate posts only: the measured pill box, so the drawn box IS the tested box. */
  gateLabel?: { text: string; box: FlowRect };
  /** This node's own canvas position — components draw relative to it. */
  origin?: { x: number; y: number };
}

/**
 * The "steering will write" card is pure view state — it is not a projection
 * node, so it gets its own data shape and can never be mistaken for engine truth.
 */
export interface FlowSteeringData extends Record<string, unknown> {
  width: number;
  height: number;
  plan?: SteeringPlan;
  steeringApplied?: boolean;
}

export type FlowTaskNode = Node<FlowCardData, "flowTask">;
export type FlowBookendNode = Node<FlowCardData, "flowBookend">;
export type FlowOrchestratorNode = Node<FlowCardData, "flowOrchestrator">;
export type FlowForkNode = Node<FlowCardData, "flowFork">;
export type FlowBatchNode = Node<FlowCardData, "flowBatch">;
export type FlowGatepostNode = Node<FlowCardData, "flowGatepost">;
export type FlowSteeringNode = Node<FlowSteeringData, "flowSteering">;

export type FlowAnyNode =
  | FlowTaskNode
  | FlowBookendNode
  | FlowOrchestratorNode
  | FlowForkNode
  | FlowBatchNode
  | FlowGatepostNode
  | FlowSteeringNode
  | Node<Record<string, unknown>, "flowBand" | "flowLayerGate" | "flowStack" | "flowDraft">;

/** What an edge carries: its kind, what proves it, and where its label may go. */
export interface FlowEdgeData extends Record<string, unknown> {
  kind: FlowEdgeKind;
  /** Set only when the label's box fits free space — suppressed labels are gone. */
  label?: string;
  /** The measured label box (canvas space) when the label is visible. */
  labelBox?: FlowRect;
  /** True when the layout had to suppress a label rather than clip it. */
  labelSuppressed?: boolean;
  proven?: boolean;
  evidence?: FlowEdgeEvidence;
}

export type FlowEdgeType = Edge<FlowEdgeData, "flow">;

/** Node kind → the registered React Flow node type. */
export const NODE_TYPE_BY_KIND: Record<FlowNodeKind, string> = {
  task: "flowTask",
  start: "flowBookend",
  goal: "flowBookend",
  orchestrator: "flowOrchestrator",
  fork: "flowFork",
  batch: "flowBatch",
  gatepost: "flowGatepost",
  stack: "flowStack",
  draft: "flowDraft",
};

/** Every node type the room registers (the steering card is view-only). */
export const FLOW_NODE_TYPES = [
  "flowTask",
  "flowBookend",
  "flowOrchestrator",
  "flowFork",
  "flowBatch",
  "flowGatepost",
  "flowSteering",
  "flowStack",
  "flowDraft",
  "flowBand",
  "flowLayerGate",
] as const;

/** View-only card id for the frame-3 summary; never a projection node. */
export const STEERING_NODE_ID = "__steering-will-write";

/** Targets of spawn edges — the cards that pop in (frame 4A). */
export function spawnTargets(graph: FlowGraph): Set<string> {
  return new Set(graph.edges.filter(edge => edge.kind === "spawn").map(edge => edge.to));
}

/** Projection + layout → the canvas node list. */
export function buildNodes(
  graph: FlowGraph,
  layout: FlowLayoutResult,
  spawned: Set<string>
): FlowAnyNode[] {
  const byId = new Map(graph.nodes.map(node => [node.id, node]));
  const nodes: FlowAnyNode[] = [];

  for (const placed of layout.nodes) {
    const projection = byId.get(placed.id);
    if (!projection) continue;
    const data: FlowCardData = {
      node: projection,
      width: placed.width,
      height: placed.height,
      spawned: spawned.has(placed.id),
      metrics: projection.metrics,
      cron: projection.cron,
      origin: { x: placed.x, y: placed.y },
    };
    if (projection.kind === "start") {
      data.loopId = graph.start.loop;
      data.phase = graph.start.phase;
      data.mode = graph.start.mode;
      data.tasksClosed = graph.start.tasks_closed;
    }
    if (projection.kind === "goal") data.mergeBack = graph.goal.merge_back;
    if (projection.kind === "batch") {
      data.batch = graph.human.batch;
      data.unevaluated = graph.human.unevaluated_gates ?? [];
    }
    if (projection.kind === "gatepost") {
      const label = layout.gateLabels.find(entry => entry.id === projection.id);
      data.gateLabel = {
        text: label?.text ?? gateLabelText(projection),
        box: label
          ? { x: label.x, y: label.y, width: label.width, height: label.height }
          : { x: placed.x, y: 0, width: 0, height: 0 },
      };
    }

    nodes.push({
      id: placed.id,
      type: NODE_TYPE_BY_KIND[projection.kind ?? "task"],
      position: { x: placed.x, y: placed.y },
      width: placed.width,
      height: placed.height,
      style: { width: placed.width, height: placed.height },
      data,
      draggable: !placed.gatepost,
      selectable: !placed.gatepost,
      focusable: false,
    } as FlowAnyNode);
  }
  return nodes;
}

/**
 * Projection → the canvas edge list. Gate posts never carry edges.
 *
 * Edge labels are placed by the LAYOUT (`placeEdgeLabels`), not by the edge
 * component: a label whose box would sit under a card is dropped here, so a
 * clipped label can never be drawn (the Lead's render found exactly that).
 */
export function buildEdges(graph: FlowGraph, layout: FlowLayoutResult): FlowEdgeType[] {
  const labels = new Map<string, FlowLabelBox>(
    placeEdgeLabels(graph.edges, layout).map(box => [box.edgeKey, box])
  );
  return graph.edges.map((edge, index) => {
    const key = `${edge.from}->${edge.to}:${edge.kind}:${index}`;
    const box = labels.get(key);
    return {
      id: key,
      source: edge.from,
      target: edge.to,
      type: "flow",
      data: {
        kind: edge.kind,
        label: box?.visible ? box.text : undefined,
        labelBox: box?.visible
          ? { x: box.x, y: box.y, width: box.width, height: box.height }
          : undefined,
        labelSuppressed: !!edge.label && !!box && !box.visible,
        proven: edge.proven,
        evidence: edge.evidence,
      },
      zIndex: edge.kind === "merge" ? 1 : 0,
    };
  });
}

/** One call the room uses: graph in, canvas-ready nodes and edges out. */
export function projectToCanvas(graph: FlowGraph): {
  nodes: FlowAnyNode[];
  edges: FlowEdgeType[];
  layout: FlowLayoutResult;
} {
  const layout = layoutFlow(graph);
  return {
    nodes: buildNodes(graph, layout, spawnTargets(graph)),
    edges: buildEdges(graph, layout),
    layout,
  };
}

// ─── v2 layer view (D21, D22): bands, gate posts, stacks and drafts ───

export interface FlowBandData extends Record<string, unknown> {
  band: BandRect;
  width: number;
  height: number;
}
export interface FlowLayerGateData extends Record<string, unknown> {
  post: GatePost;
  width: number;
  height: number;
}
export type FlowBandNode = Node<FlowBandData, "flowBand">;
export type FlowLayerGateNode = Node<FlowLayerGateData, "flowLayerGate">;
export type FlowStackNode = Node<FlowCardData, "flowStack">;
export type FlowDraftNode = Node<FlowCardData, "flowDraft">;

/** Projection + layer layout → the canvas node list, bands first so they sit underneath. */
export function buildLayerNodes(graph: FlowGraph, layout: LayerLayout, spawned: Set<string>): Node[] {
  const out: Node[] = [];
  for (const b of layout.bands) {
    out.push({
      id: b.id, type: "flowBand", position: { x: b.x, y: b.y }, width: b.width, height: b.height,
      style: { width: b.width, height: b.height }, zIndex: -1,
      data: { band: b, width: b.width, height: b.height },
      draggable: false, selectable: false, focusable: false,
    });
  }
  for (const g of layout.gateposts) {
    out.push({
      id: g.id, type: "flowLayerGate", position: { x: g.x, y: g.y }, width: 1, height: g.height,
      style: { width: 1, height: g.height }, zIndex: 0,
      data: { post: g, width: 1, height: g.height },
      draggable: false, selectable: false, focusable: false,
    });
  }
  const byId = new Map<string, FlowNode>(graph.nodes.map(n => [n.id, n]));
  for (const extra of layout.extraNodes) byId.set(extra.id, extra);
  const asLayout: FlowLayoutResult = layout;
  for (const n of buildNodes({ ...graph, nodes: [...byId.values()] }, asLayout, spawned)) {
    const kind = (n.data as FlowCardData).node.kind;
    // stacks and drafts are view state: a person may open them, never drag them
    if (kind === "stack" || kind === "draft") Object.assign(n, { draggable: false });
    out.push(n);
  }
  return out;
}

/**
 * Edges for the layer view: an edge to or from a stacked done card is drawn to its
 * stack, duplicates collapse, and an edge whose end is not on the canvas is dropped.
 */
export function buildLayerEdges(graph: FlowGraph, layout: LayerLayout): FlowEdgeType[] {
  const onCanvas = new Set(layout.nodes.map(n => n.id));
  const seen = new Set<string>();
  const out: FlowEdgeType[] = [];
  graph.edges.forEach((edge, index) => {
    const from = layout.stackOf[edge.from] ?? edge.from;
    const to = layout.stackOf[edge.to] ?? edge.to;
    if (from === to || !onCanvas.has(from) || !onCanvas.has(to)) return;
    // the bands already say where work sits: the bookends' spawn fan-out is noise here
    if (from === "start" || to === "goal") return;
    const key = `${from}->${to}:${edge.kind}`;
    if (seen.has(key)) {
      // a merged edge is only as proven as the weakest edge it stands for
      const merged = out.find(e => e.id.startsWith(`${key}:`));
      if (merged?.data && edge.proven !== true) merged.data.proven = false;
      return;
    }
    seen.add(key);
    out.push({
      id: `${key}:${index}`, source: from, target: to, type: "flow",
      data: { kind: edge.kind, proven: edge.proven, evidence: edge.evidence },
      zIndex: edge.kind === "merge" ? 1 : 0,
    });
  });
  return out;
}
