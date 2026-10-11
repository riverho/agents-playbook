// ─── Stage room: Flow — the backlog graph (playground) ───
//
// Room #11. Why it is not the Loop room and not the Board room: the Loop room
// draws the playbook CYCLE (phases + gates) and the Board draws tasks BY STATE
// (moving a card IS the state change). This room draws TOPOLOGY — dependencies,
// layer gates, spawn/fork routing, the human batch as a PLACE, and merge-back —
// on PB's own derived layering, left → right (DESIGN §2, D1/D2).
//
// Everything it shows arrives through ONE adapter (`lib/flow-adapter.ts`): the
// fixture today, `pb graph --json` in P3. The components read `FlowGraph` and
// never the fixture module, which is what makes the swap a one-line change.
//
// View state that deliberately lives HERE and never in the playbook (DESIGN
// §1.5): card positions (dagre, re-computed per filter), zoom/pan, selection,
// the filter, the prompt, and the animation.
//
// Effects are CSS + SVG/SMIL only and honour prefers-reduced-motion (D8, frame 4).

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  ViewportPortal,
  useNodesState,
  useReactFlow,
  useStore,
  type NodeTypes,
  type EdgeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useStageEscape } from "@/lib/stage-escape";

import {
  FLOW_MINIMAP_BG,
  FLOW_MINIMAP_TONE,
  flowLegendModel,
  hasDeclaredLayers,
  isSteerable,
  steeringPlan,
} from "@/lib/flow-derive";
import {
  DEFAULT_FLOW_ADAPTER,
  SAMPLE_LAYERED_ADAPTER,
  type FlowAdapter,
  type FlowSteeringMode,
} from "@/lib/flow-adapter";
import {
  FLOW_FIT_PADDING,
  FLOW_MARGIN,
  flowFitBounds,
  layoutNodeById,
  type FlowRect,
} from "@/lib/flow-layout";
import type { FlowGraph, FlowNode } from "@/lib/flow-types";
import {
  FlowBatchCard,
  FlowBookendCard,
  FlowForkCard,
  FlowGatepostCard,
  FlowOrchestratorCard,
  FlowSteeringCard,
  FlowTaskCard,
} from "./FlowCards";
import { FlowViewContext } from "@/lib/flow-view";
import { zoomTier } from "@/lib/flow-face";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";
import {
  STEERING_NODE_ID,
  buildLayerEdges,
  buildLayerNodes,
  spawnTargets,
  type FlowAnyNode,
  type FlowCardData,
  type FlowSteeringNode,
} from "@/lib/flow-projection";
import {
  FlowEdgeMarkers,
  FlowEdge as FlowEdgeComponent,
} from "./FlowEdges";
import { FlowInspector } from "./FlowInspector";
import { FlowBandCard, FlowDraftCard, FlowLayerGateCard, FlowStackCard } from "./FlowLayerView";
import { layoutLayers, nextBandId, type BandDraft } from "@/lib/flow-bands";
import { FlowJumpContext, type FlowJump } from "@/lib/flow-jump";
import { FlowSteeringDock, FlowSteeringToast, type SteeringToast } from "./FlowSteeringDock";

/** Node/edge component registries — module scope, so React Flow never re-creates them. */
const NODE_TYPES = {
  flowTask: FlowTaskCard,
  flowBookend: FlowBookendCard,
  flowOrchestrator: FlowOrchestratorCard,
  flowFork: FlowForkCard,
  flowBatch: FlowBatchCard,
  flowGatepost: FlowGatepostCard,
  flowSteering: FlowSteeringCard,
  flowBand: FlowBandCard,
  flowLayerGate: FlowLayerGateCard,
  flowStack: FlowStackCard,
  flowDraft: FlowDraftCard,
} as unknown as NodeTypes;

const EDGE_TYPES = { flow: FlowEdgeComponent } as unknown as EdgeTypes;

// ── filtering (view state; the layering is re-derived after it) ───────────

function matchesQuery(node: FlowNode, query: string): boolean {
  if (!query) return true;
  const needle = query.toLowerCase();
  return [node.id, node.title, node.skill ?? "", node.status, node.layer]
    .join(" ")
    .toLowerCase()
    .includes(needle);
}

/**
 * The layer switch and the `/` filter. The bookends, the gate posts and the
 * bottom band stay visible: they are the room's frame, not layer members.
 */
function filterGraph(graph: FlowGraph, view: string, query: string): FlowGraph {
  const keep = (node: FlowNode): boolean => {
    if (node.kind === "start" || node.kind === "goal") return true;
    if (node.kind === "gatepost" || node.kind === "orchestrator" || node.kind === "batch") {
      return true;
    }
    if (node.kind === "fork") return true;
    const inLayer = view === "all" || node.layer === view;
    return inLayer && matchesQuery(node, query);
  };
  const nodes = graph.nodes.filter(keep);
  const ids = new Set(nodes.map(node => node.id));
  const edges = graph.edges.filter(edge => ids.has(edge.from) && ids.has(edge.to));
  return { ...graph, nodes, edges };
}

// ── the room ──────────────────────────────────────────────────────────────

export interface FlowRoomProps {
  view?: string;
  query?: string;
  adapter?: FlowAdapter;
}

/**
 * `ReactFlowProvider` is required, not decoration: the canvas is seeded from the
 * projection on mount (and re-seeded whenever the layer filter changes), and the
 * viewport must then fit the graph — `fitView` on the component only fits at
 * mount, when the node list is still empty.
 */
export default function FlowRoom(props: FlowRoomProps) {
  return (
    <ReactFlowProvider>
      <FlowCanvas {...props} />
    </ReactFlowProvider>
  );
}

function FlowCanvas({
  view = "all",
  query = "",
  adapter,
}: FlowRoomProps) {
  const reactFlow = useReactFlow();
  // The injected adapter wins (P3/tests); otherwise the room can flip between
  // this repo's live snapshot and the labelled three-layer sample.
  const [showSample, setShowSample] = useState(false);
  const active = adapter ?? (showSample ? SAMPLE_LAYERED_ADAPTER : DEFAULT_FLOW_ADAPTER);
  const graph = useMemo(() => active.load(), [active]);
  const filtered = useMemo(() => filterGraph(graph, view, query), [graph, view, query]);
  // v2 layer view (D21): bands from the plan's layers; done stacked unless expanded;
  // drafts are view state until Create (J3).
  const [expanded, setExpanded] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<BandDraft[]>([]);
  const [openPlus, setOpenPlus] = useState<string | null>(null);
  const layout = useMemo(() => layoutLayers(filtered, { expanded, drafts }), [filtered, expanded, drafts]);
  // Refit only when the GRAPH changes — never while a person types into a draft.
  const layoutKey = `${view}|${query}|${filtered.nodes.length}|${filtered.edges.length}`;
  const spawned = useMemo(() => spawnTargets(graph), [graph]);
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowAnyNode>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");

  const [toast, setToast] = useState<SteeringToast | null>(null);
  const [goalDiff, setGoalDiff] = useState<FlowGraph["goal_diff"]>(graph.goal_diff);
  const [steeredIds, setSteeredIds] = useState<string[]>([]);

  // Seed positions whenever the filter (and therefore the layering) changes,
  // then fit the viewport once the new nodes have been committed.
  useEffect(() => {
    setNodes(buildLayerNodes(filtered, layout, spawned) as FlowAnyNode[]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout]);
  useEffect(() => {
    setSelectedIds([]);
    setOpenId(null);
    const timer = window.setTimeout(() => {
      // Fit the LAYOUT's rect, not the nodes' bounding box: the legend lives in a
      // reserved band below the content, and `fitView` (nodes only) would leave it
      // off-viewport with just its top sliver showing.
      void reactFlow.fitBounds(flowFitBounds(layout), { padding: FLOW_FIT_PADDING });
    }, 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey]);

  const selection = useMemo(
    () =>
      selectedIds
        .map(id => filtered.nodes.find(node => node.id === id))
        .filter((node): node is FlowNode => !!node && isSteerable(node)),
    [selectedIds, filtered]
  );
  const plan = useMemo(() => steeringPlan(selection), [selection]);
  const multi = selection.length > 1;
  const reducedMotion = usePrefersReducedMotion();
  const viewState = useMemo(
    () => ({ goalDiff, steeredIds, reducedMotion }),
    [goalDiff, steeredIds, reducedMotion]
  );

  // The frame-3 summary card: view state, placed under the orchestrator.
  useEffect(() => {
    setNodes(current => {
      const without = current.filter(node => node.id !== STEERING_NODE_ID);
      if (!multi) return without.length === current.length ? current : without;
      const anchor =
        layoutNodeById(layout, "orchestrator") ??
        layoutNodeById(layout, "fork-a") ??
        layoutNodeById(layout, "batch");
      const steering: FlowSteeringNode = {
        id: STEERING_NODE_ID,
        type: "flowSteering",
        position: {
          x: anchor?.x ?? 0,
          y: (anchor ? anchor.y + anchor.height : 0) + 16,
        },
        width: 236,
        height: 140,
        style: { width: 236, height: 140 },
        data: { width: 236, height: 140, plan, steeringApplied: steeredIds.length > 0 },
        draggable: true,
        selectable: false,
        focusable: false,
      };
      return [...without, steering];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [multi, plan, steeredIds, layoutKey]);

  const edges = useMemo(() => buildLayerEdges(filtered, layout), [filtered, layout]);
  // A new draft may land in a band that is off screen: bring it into view, at the current zoom.
  const lastDraft = drafts[drafts.length - 1]?.id;
  useEffect(() => {
    if (!lastDraft) return;
    const placed = layout.nodes.find(n => n.id === `draft:${lastDraft}`);
    if (placed) void reactFlow.setCenter(placed.x + placed.width / 2, placed.y + placed.height / 2, { zoom: Math.max(reactFlow.getZoom(), 0.75), duration: 250 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastDraft]);
  const bands = layout.bands.map(b => b.band);
  const jump: FlowJump = useMemo(() => ({
    openPlus,
    setOpenPlus,
    addDraft: (kind, band, from) => {
      const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      setDrafts(list => [...list, { id, band, kind, from, title: "" }]);
    },
    updateDraft: (id, title) => setDrafts(list => list.map(d => (d.id === id ? { ...d, title } : d))),
    discardDraft: id => setDrafts(list => list.filter(d => d.id !== id)),
    createDraft: async draft => {
      if (!active.createTask) return { ok: false, note: "this view is a snapshot — nothing was written. Open the room against a playbook to create tasks." };
      const declared = bands.some(b => b.id === draft.band && b.source === "declared");
      const r = await active.createTask({ goal: draft.title.trim(), from: draft.kind === "follow-up" ? draft.from : undefined, layer: declared ? draft.band : undefined });
      return r;
    },
    forkCard: async id => {
      if (!active.forkTask) return { ok: false, note: "this view is a snapshot — nothing was written." };
      return active.forkTask(id);
    },
    toggleStack: band => setExpanded(list => (list.includes(band) ? list.filter(b => b !== band) : [...list, band])),
    openCard: id => setOpenId(id),
    followUpBand: taskId => {
      const node = filtered.nodes.find(n => n.id === taskId);
      const from = node ? bands.find(b => b.open.includes(node) || b.done.includes(node))?.id : undefined;
      return from ? nextBandId(bands, from) : bands[bands.length - 1]?.id ?? "L1";
    },
    isDeclared: band => bands.some(b => b.id === band && b.source === "declared"),
    readOnly: !active.createTask,
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [openPlus, active, layout, filtered]);
  const openNode = openId ? filtered.nodes.find(node => node.id === openId) : undefined;

  // Escape unwinds exactly one level: selection → inspector → the stage.
  useStageEscape(useCallback(() => {
    if (selectedIds.length > 0) {
      setNodes(current => current.map(node => ({ ...node, selected: false })));
      setSelectedIds([]);
      return true;
    }
    if (openNode) {
      setOpenId(null);
      return true;
    }
    return false;
  }, [selectedIds.length, openNode, setNodes]));

  const runSteering = useCallback(
    async (mode: FlowSteeringMode) => {
      const target = selection;
      if (target.length === 0) return;
      const text =
        prompt.trim() ||
        `Steer ${target.length} card${target.length === 1 ? "" : "s"}: ${mode}`;
      // AWAITED: the fixture answers synchronously, a live adapter talks to a server. Only
      // after it resolves can the toast report what actually landed.
      const result = await active.applySteering(target, text, mode);
      if (mode === "steer") setGoalDiff(result.goal_diff);
      setSteeredIds(
        result.rows.length > 0 ? result.rows.map(row => row.task) : target.map(node => node.id)
      );
      setToast({
        plan: result.wrote,
        goalEdited: mode === "steer" && !!result.goal_diff,
        persisted: result.persisted,
        note: result.note,
      });
    },
    [active, prompt, selection]
  );

  /** A single card's inspector actions steer just that card. */
  const runForOne = useCallback(
    async (node: FlowNode, mode: FlowSteeringMode) => {
      const result = await active.applySteering([node], prompt.trim() || node.title, mode);
      if (mode === "steer") setGoalDiff(result.goal_diff);
      setSteeredIds([node.id]);
      setToast({
        plan: result.wrote,
        goalEdited: mode === "steer" && !!result.goal_diff,
        persisted: result.persisted,
        note: result.note,
      });
    },
    [active, prompt]
  );

  // The browser gate's seam (scripts/check-room-browser.mjs): drive the zoom from outside
  // and read it back. Read-only apart from the viewport, which is view state anyway.
  useEffect(() => {
    // only when asked for (?gate): a production build does not expose it by default
    if (!/[?&]gate\b/.test(window.location.search)) return;
    const w = window as unknown as { __flowRoom?: unknown };
    w.__flowRoom = { setViewport: reactFlow.setViewport, getZoom: reactFlow.getZoom };
    return () => { delete w.__flowRoom; };
  }, [reactFlow]);

  // T3: the zoom tier decides what text exists at all, so nothing renders under 9px.
  const zoom = useStore(state => state.transform[2]);
  const tier = zoomTier(zoom);

  const counts = {
    hil: graph.human.batch.length,
    forks: graph.nodes.filter(node => node.kind === "fork").length,
  };

  return (
    <div
      className="flow-room"
      data-tier={tier}
      style={{ ["--inv" as string]: (1 / Math.max(zoom, 0.01)).toFixed(3) }}
    >
      <FlowJumpContext.Provider value={jump}>
      <FlowViewContext.Provider value={viewState}>
        <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        onNodesChange={onNodesChange}
        onNodeClick={(_event, node) => {
          if (node.id === STEERING_NODE_ID) return;
          // bands, gate posts, stacks and drafts are places and view state, not cards to open
          if (node.type === "flowBand" || node.type === "flowLayerGate" || node.type === "flowStack" || node.type === "flowDraft") return;
          setOpenId(node.id);
        }}
        onPaneClick={() => { setOpenId(null); setOpenPlus(null); }}
        onSelectionChange={({ nodes: selected }) =>
          setSelectedIds(selected.map(node => node.id))
        }
        // No `fitView` prop: the fit happens in the seed effect below, because it
        // must fit the layout rect (legend included) rather than the node box.
        // 5% is the overview the layer view is designed for (D22, G5)
        minZoom={0.05}
        maxZoom={1.6}
        nodesConnectable={false}
        edgesFocusable={false}
        edgesReconnectable={false}
        deleteKeyCode={null}
        // Left drag = the frame's rubber band; middle/right drag pans.
        panOnDrag={[1, 2]}
        selectionOnDrag
        selectionMode={SelectionMode.Partial}
        multiSelectionKeyCode={["Meta", "Control"]}
        onlyRenderVisibleElements
        proOptions={{ hideAttribution: true }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={16}
          size={1}
          color="rgba(17, 17, 17, 0.09)"
        />
        <FlowEdgeMarkers />
        {/* The legend is canvas-space, drawn at the rect the layout reserved for
            it — so it can never sit on top of a card (frame 1's floating panel). */}
        <ViewportPortal>
          <FlowLegend graph={graph} rect={layout.chrome.legend} />
        </ViewportPortal>
        <Controls position="bottom-left" showInteractive={false} />
        <MiniMap
          position="bottom-right"
          pannable
          zoomable
          maskColor="rgba(246, 244, 242, 0.55)"
          nodeColor={node => {
            const data = node.data as FlowCardData;
            return data?.node ? FLOW_MINIMAP_TONE[data.node.status] : FLOW_MINIMAP_TONE.todo;
          }}
          nodeStrokeColor="rgba(17, 17, 17, 0.25)"
          nodeBorderRadius={2}
          style={{
            width: 176,
            height: 104,
            background: FLOW_MINIMAP_BG,
            border: "1px solid var(--surface-3)",
          }}
        />
        </ReactFlow>
      </FlowViewContext.Provider>
      </FlowJumpContext.Provider>

      {/* the room's own status chips — the shared top strip has no slot for them.
          They live in the chipbar rect the layout reserves. */}
      <div
        className="flow-chipbar"
        style={{
          top: layout.chrome.chipbar.y,
          right: FLOW_MARGIN,
        }}
      >
        <span className={`flow-chip${counts.hil > 0 ? " flow-chip--hil" : ""}`}>
          🧑 HIL {counts.hil}
        </span>
        {graph.nodes.find(node => node.kind === "start")?.cron && (
          <span className="flow-chip">
            ⏱ {graph.nodes.find(node => node.kind === "start")?.cron?.every}
          </span>
        )}
        <span className="flow-chip">{view === "all" ? "all layers" : `layer ${view}`}</span>
        {query && <span className="flow-chip flow-chip--on">filter: {query}</span>}
        {/* Truth about the source: a payload with no declared layers gets ONE
            column, and the room says so instead of implying strata. */}
        <span
          className={`flow-chip${active.kind === "sample" ? " flow-chip--on" : ""}`}
          title={active.label}
        >
          {active.kind === "sample" ? "sample · unprovable detail" : "snapshot · pb graph --json"}
        </span>
        {!hasDeclaredLayers(graph) && (
          <span className="flow-chip flow-chip--ghost">no layers declared — flat view</span>
        )}
        {!adapter && (
          <button
            className="flow-chip"
            onClick={() => setShowSample(value => !value)}
            title="Switch between this repo's live projection and the painted frame's layered sample"
          >
            {showSample ? "← back to the snapshot" : "view the 3-layer sample"}
          </button>
        )}
      </div>

      {multi && (
        <FlowSteeringDock
          selection={selection}
          prompt={prompt}
          onPrompt={setPrompt}
          onSteer={() => runSteering("steer")}
          onComment={() => runSteering("comment")}
          onFork={() => runSteering("fork")}
          onAttach={() => runSteering("attach")}
        />
      )}

      {toast && <FlowSteeringToast toast={toast} onDismiss={() => setToast(null)} />}

      {openNode && openNode.kind !== "gatepost" && (
        <FlowInspector
          node={openNode}
          onClose={() => setOpenId(null)}
          onComment={text => {
            setPrompt(text);
            runForOne(openNode, "comment");
          }}
          onSteer={() => runForOne(openNode, "steer")}
          onFork={() => runForOne(openNode, "fork")}
        />
      )}
    </div>
  );
}

// ── the legend (frame 1, bottom-left, canvas space) ───────────────────────
//
// Rendered FROM `flowLegendModel(graph)` — the same model the layout measures to
// size the reserve — so a row can never be added here without the panel growing.

function FlowLegend({ graph, rect }: { graph: FlowGraph; rect: FlowRect }) {
  const groups = flowLegendModel(graph);
  return (
    <div
      className="flow-legend"
      style={{
        left: rect.x,
        top: rect.y,
        width: rect.width,
        height: rect.height,
        boxSizing: "border-box",
      }}
    >
      {groups.map(group => (
        <div className="flow-legend__grp" key={group.title}>
          <span className="flow-legend__h">{group.title}</span>
          {group.rows.map(row => (
            <span className="flow-legend__row" key={`${group.title}:${row.text}`}>
              {row.kind === "line" && (
                <i
                  style={{
                    borderTopColor: row.stroke,
                    borderTopWidth: row.strokeWidth,
                    borderTopStyle: row.dash ? "dashed" : "solid",
                  }}
                />
              )}
              {row.kind === "dot" && (
                <i
                  className={`flow-legend__dot${row.live ? " flow-legend__dot--live" : ""}`}
                  style={{ background: row.color }}
                />
              )}
              {row.kind === "glyph" && (
                <span style={{ color: row.glyphColor, fontWeight: 600 }}>{row.glyph}</span>
              )}
              {row.text}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}
