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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  ControlButton,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  useNodesState,
  useReactFlow,
  useStore,
  type NodeTypes,
  type EdgeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { ChevronDown, LayoutGrid, ListTree, Undo2 } from "lucide-react";
import { movedSince, pushHistory, restore, snapshot, type Positions } from "@/lib/flow-moves";
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
  sourceChipText,
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
import { agoLabel, zoomTier } from "@/lib/flow-face";
import { presence } from "@/lib/flow-open";
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
import { FlowDecisions } from "./FlowDecisions";
import { decisionItems, type DecisionRow } from "@/lib/flow-decisions";
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
  /** Ids of cards that moved since the host's last refresh: they glow once. */
  changed?: string[];
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
  changed,
}: FlowRoomProps) {
  const reactFlow = useReactFlow();
  // The injected adapter wins (P3/tests); otherwise the room can flip between
  // this repo's live snapshot and the labelled three-layer sample.
  const [showSample, setShowSample] = useState(false);
  const active = adapter ?? (showSample ? SAMPLE_LAYERED_ADAPTER : DEFAULT_FLOW_ADAPTER);
  const sourceGraph = useMemo(() => active.load(), [active]);
  const [recorded, setRecorded] = useState<Record<string, DecisionRow>>({});
  const graph = useMemo(() => ({ ...sourceGraph, nodes: sourceGraph.nodes.map(n => recorded[n.id] ? {
    ...n, human: { ...n.human, decided: { option: recorded[n.id].option, reason: recorded[n.id].reason, by: recorded[n.id].agent, ts: recorded[n.id].ts, seq: recorded[n.id].seq } },
  } : n) }), [sourceGraph, recorded]);
  useEffect(() => { setRecorded({}); }, [active]);
  const inbox = useMemo(() => decisionItems(graph), [graph]);
  const [showDecisions, setShowDecisions] = useState(false);
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
  // card moves are view state: Undo walks them back, Reorganize returns to the layout
  const [moves, setMoves] = useState<Positions[]>([]);
  const dragFrom = useRef<Positions | null>(null);
  useEffect(() => {
    setNodes(buildLayerNodes(filtered, layout, spawned) as FlowAnyNode[]);
    setMoves([]);
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
    () => ({ goalDiff, steeredIds, reducedMotion, changedIds: changed }),
    [goalDiff, steeredIds, reducedMotion, changed]
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
  // S7: a past version is history — nothing in it is planned, claimed or followed up
  const pastVersion = graph.version?.read_only ? (graph.version.version ?? graph.version.title) : null;
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
    isExpanded: band => expanded.includes(band),
    openCard: id => setOpenId(id),
    followUpBand: taskId => {
      const node = filtered.nodes.find(n => n.id === taskId);
      const from = node ? bands.find(b => b.open.includes(node) || b.done.includes(node))?.id : undefined;
      return from ? nextBandId(bands, from) : bands[bands.length - 1]?.id ?? "L1";
    },
    isDeclared: band => bands.some(b => b.id === band && b.source === "declared"),
    readOnly: !active.createTask || !!pastVersion,
    pastVersion,
    forkIntoOpen: async id => {
      if (!active.createTask) return { ok: false, note: "this view is a snapshot — nothing was written." };
      const node = filtered.nodes.find(n => n.id === id);
      return active.createTask({ goal: node?.headline ?? node?.title ?? id, from: id, kind: "experiment" });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [openPlus, active, layout, filtered, pastVersion]);
  const openNode = openId ? filtered.nodes.find(node => node.id === openId) : undefined;

  // A1: closing a card hands focus back to it, so a keyboard user is where they were
  const closeCard = useCallback(() => {
    const id = openId;
    setOpenId(null);
    if (id) window.setTimeout(() => (document.querySelector(`.flow-face[data-id="${CSS.escape(id)}"]`) as HTMLElement | null)?.focus(), 0);
  }, [openId]);

  // Escape unwinds one level, the nearest first: the open card, then the selection.
  useStageEscape(useCallback(() => {
    // a message or a draft being written is not thrown away by Escape: the first Escape
    // only leaves the text box; the next one closes
    const typing = document.activeElement as HTMLTextAreaElement | HTMLInputElement | null;
    if (typing && (typing.tagName === "TEXTAREA" || typing.tagName === "INPUT") && typing.value.trim()) {
      typing.blur();
      return true;
    }
    // the nearest open thing first: a + menu, then the open card, then the selection
    if (openPlus) {
      setOpenPlus(null);
      return true;
    }
    if (showDecisions) { setShowDecisions(false); return true; }
    if (openNode) {
      closeCard();
      return true;
    }
    if (selectedIds.length > 0) {
      setNodes(current => current.map(node => ({ ...node, selected: false })));
      setSelectedIds([]);
      return true;
    }
    return false;
  }, [showDecisions, selectedIds.length, openNode, setNodes, closeCard, openPlus]));

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
        applied: result.applied,
        // The verb the toast reports must be the verb that ran: attach writes a card's docs:,
        // it does not comment, and saying "commented on" for it would be the same lie the
        // orchestrator used to tell about writing nothing.
        verb: mode === "attach" ? "attach" : "comment",
        note: result.note,
      });
    },
    [active, prompt, selection]
  );

  const undoMove = useCallback(() => {
    const last = moves[moves.length - 1];
    if (!last) return;
    setNodes(current => restore(current, last));
    setMoves(list => list.slice(0, -1));
  }, [moves, setNodes]);
  const reorganize = useCallback(() => {
    const fresh = buildLayerNodes(filtered, layout, spawned) as FlowAnyNode[];
    const before = snapshot(reactFlow.getNodes());
    // a reorganize that moved something is itself undoable
    if (movedSince(before, fresh)) setMoves(list => pushHistory(list, before));
    setNodes(current => restore(current, snapshot(fresh)));
    void reactFlow.fitBounds(flowFitBounds(layout), { padding: FLOW_FIT_PADDING });
  }, [filtered, layout, spawned, setNodes, reactFlow]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.key.toLowerCase() !== "z") return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      if (!moves.length) return;
      e.preventDefault();
      undoMove();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [moves.length, undoMove]);

  // The browser gate's seam (scripts/check-room-browser.mjs): drive the zoom from outside
  // and read it back. Read-only apart from the viewport, which is view state anyway.
  useEffect(() => {
    // only when asked for (?gate): a production build does not expose it by default
    if (!/[?&]gate\b/.test(window.location.search)) return;
    const w = window as unknown as { __flowRoom?: unknown };
    w.__flowRoom = { setViewport: reactFlow.setViewport, getZoom: reactFlow.getZoom, setCenter: reactFlow.setCenter, getNodes: reactFlow.getNodes };
    return () => { delete w.__flowRoom; };
  }, [reactFlow]);

  // T3: the zoom tier decides what text exists at all, so nothing renders under 9px.
  const zoom = useStore(state => state.transform[2]);
  const tier = zoomTier(zoom);

  const present = useMemo(() => presence(graph), [graph]);
  // P4b: the harness CLIs the room's server can see (none for a snapshot)
  const [harnessList, setHarnessList] = useState<{ id: string; label: string }[]>([]);
  useEffect(() => {
    let alive = true;
    if (active.listHarnesses) void active.listHarnesses().then(list => { if (alive) setHarnessList(list); }).catch(() => undefined);
    return () => { alive = false; };
  }, [active]);

  const counts = {
    hil: inbox.length,
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
        onNodeDragStart={() => { dragFrom.current = snapshot(reactFlow.getNodes()); }}
        onNodeDragStop={() => {
          const from = dragFrom.current;
          dragFrom.current = null;
          if (from && movedSince(from, reactFlow.getNodes())) setMoves(list => pushHistory(list, from));
        }}
        onNodeClick={(_event, node) => {
          if (node.id === STEERING_NODE_ID) return;
          if (node.type === "flowBatch") { setOpenId(null); setShowDecisions(true); return; }
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
        <Controls position="bottom-left" showInteractive={false}>
          <ControlButton
            className="flow-ctl-undo"
            onClick={undoMove}
            disabled={!moves.length}
            title={moves.length ? "Undo the last card move (Ctrl+Z)" : "No card move to undo"}
            aria-label="Undo the last card move"
          >
            <Undo2 size={14} aria-hidden />
          </ControlButton>
          <ControlButton
            className="flow-ctl-reorganize"
            onClick={reorganize}
            title="Put every card back in its layer"
            aria-label="Reorganize the cards into their layers"
          >
            <LayoutGrid size={14} aria-hidden />
          </ControlButton>
        </Controls>
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

      {/* the legend is a SCREEN overlay (plan-20261010-006): drawn on the canvas it sat in a
          reserve that the first fit put at 17–33% zoom, where the overview hides all text —
          nobody saw it until they zoomed past 75%. On screen it is readable at every zoom,
          and it folds away when it covers cards (plan-20261011-005). */}
      <FlowLegend graph={graph} rect={layout.chrome.legend} />

      {/* M1: who is in the room — each active agent, what it is on, when it last spoke */}
      <div className="flow-presence" role="group" aria-label="Who is working">
        {present.length === 0 ? (
          <span className="flow-presence__none">No agent holds a card right now</span>
        ) : (
          present.map(p => (
            <button key={`${p.agent}:${p.task}`} type="button" className="flow-presence__pp" data-live={p.live ? "true" : "false"} onClick={() => setOpenId(p.task)} title={p.taskTitle}>
              <span className="flow-face__av" aria-hidden>{p.name.charAt(0).toUpperCase()}</span>
              <b>{p.name}</b>
              <span className="flow-presence__on">on {p.taskTitle}</span>
              <span className="flow-presence__m">{p.lastSpoke ? `spoke ${agoLabel(p.lastSpoke) ?? ""}` : "has not spoken"}</span>
            </button>
          ))
        )}
      </div>

      {/* the room's own status chips — the shared top strip has no slot for them.
          They live in the chipbar rect the layout reserves. */}
      <div
        className="flow-chipbar"
        style={{
          top: layout.chrome.chipbar.y,
          right: FLOW_MARGIN,
        }}
      >
        <button type="button" className={`flow-chip${counts.hil > 0 ? " flow-chip--hil" : ""}`} onClick={() => { setOpenId(null); setShowDecisions(true); }} aria-label={`Waiting on you: ${counts.hil}`}>
          🧑 Waiting on you {counts.hil}
        </button>
        {graph.nodes.find(node => node.kind === "start")?.cron && (
          <span className="flow-chip">
            ⏱ {graph.nodes.find(node => node.kind === "start")?.cron?.every}
          </span>
        )}
        <span className="flow-chip">{view === "all" ? "all layers" : `layer ${view}`}</span>
        {query && <span className="flow-chip flow-chip--on">filter: {query}</span>}
        {/* Truth about the source, FROM THE ADAPTER rather than a hardcoded string: a payload with
            no declared layers gets ONE column, and the room says so instead of implying strata.
            The label is the only field that distinguishes the live projection read from the
            running engine from the bundled snapshot of this repo, so the chip renders it. */}
        <span
          className={`flow-chip${active.kind === "sample" ? " flow-chip--on" : ""}`}
          title={active.label}
        >
          {sourceChipText(active)}
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

      {showDecisions && <FlowDecisions items={inbox} onClose={() => setShowDecisions(false)} onDecide={active.decide} onRecorded={(task, row) => setRecorded(previous => ({ ...previous, [task]: row }))} />}

      {!showDecisions && openNode && openNode.kind !== "gatepost" && (
        <FlowInspector
          node={openNode}
          onClose={closeCard}
          readOnly={!active.sendMessage}
          harnesses={harnessList}
          onAsk={active.ask ? async (text, harness, onText) => {
            try {
              const r = await active.ask!(openNode.id, text, harness, ev => {
                if (ev.type === "text" && ev.text) onText(ev.text);
                if (ev.type === "error" && ev.message) onText(`\n[${ev.message}]`);
              });
              return { ok: r.recorded, note: r.dispatched ? "Question saved to the journal; the answer is above." : r.note };
            } catch (err) {
              return { ok: false, note: err instanceof Error ? err.message : String(err) };
            }
          } : undefined}
          onSend={async (text, intent) => {
            if (!active.sendMessage) return { ok: false, note: "This view is a snapshot — nothing was written." };
            const r = await active.sendMessage(openNode.id, text, intent === "steer" || intent === "question" ? intent : "comment");
            if (r.ok) setSteeredIds([openNode.id]);
            return r;
          }}
        />
      )}
    </div>
  );
}

// ── the legend (frame 1, bottom-left, a screen overlay) ───────────────────
//
// Rendered FROM `flowLegendModel(graph)` — the same model the layout measures to
// size the panel — so a row can never be added here without the panel growing.
// It folds to one button (plan-20261011-005); the choice is a per-viewer convenience.

const LEGEND_OPEN_KEY = "flow-room:legend-open";
function readLegendOpen(): boolean {
  try { return window.localStorage.getItem(LEGEND_OPEN_KEY) !== "false"; } catch { return true; }
}

function FlowLegend({ graph, rect }: { graph: FlowGraph; rect: FlowRect }) {
  const groups = flowLegendModel(graph);
  const [open, setOpen] = useState(readLegendOpen);
  const toggle = (next: boolean) => {
    setOpen(next);
    try { window.localStorage.setItem(LEGEND_OPEN_KEY, String(next)); } catch { /* private window: this view only */ }
  };
  if (!open) {
    return (
      <button type="button" className="flow-legend-toggle" aria-expanded="false" aria-label="Show legend" onClick={() => toggle(true)}>
        <ListTree size={14} aria-hidden /> Legend
      </button>
    );
  }
  return (
    <>
    <button type="button" className="flow-legend-toggle flow-legend-toggle--hide" aria-expanded="true" aria-label="Hide legend"
      style={{ left: `calc(var(--legend-left) + ${rect.width + 6}px)` }} onClick={() => toggle(false)}>
      <ChevronDown size={14} aria-hidden />
    </button>
    <div
      className="flow-legend"
      aria-label="Legend"
      style={{
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
    </>
  );
}
