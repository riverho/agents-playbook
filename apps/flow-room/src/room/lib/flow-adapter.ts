// ─── Flow room — THE adapter boundary (one seam, one file) ───
//
// The room's components take a `FlowGraph`; they never learn where it came from.
// This module is the only place that knows, and it knows three producers:
//
//   LIVE_SNAPSHOT_ADAPTER   verbatim `node scripts/pb.mjs graph --json` from this
//                           playbook (src/mocks/flow-graph-live.ts) — the default,
//                           and therefore what the room shows about this repo
//   SAMPLE_LAYERED_ADAPTER  the painted frame's three-layer sample, explicitly
//                           labelled `sample: true` (it is NOT this repo's state)
//   createPbGraphAdapter()  P3: the same shape, straight off the CLI at runtime
//
// Swapping the adapter must not touch a single component — that is the whole
// point of the seam.
//
// The projection is ENGINE-SHAPED, so this file also does the synthesis the
// engine deliberately leaves to a surface:
//
//   · `pb graph` keeps the bookends OUT of `nodes[]` and points its `spawn` edges
//     at `start` and its `hil` edge at `human` — so those nodes are built here,
//     or every one of those edges would dangle;
//   · `kind` is absent for plain tasks, so it defaults to `task` here (a fork
//     must be marked explicitly, never inferred from a worktree);
//   · the human batch becomes ONE node (one hand-off answers every gate);
//   · `checks_outcome` is derived from the newest journal row that recorded one,
//     because the projection carries the aggregate, not per-check exit codes.

import type {
  FlowChecksOutcome,
  FlowEdge,
  FlowGoalDiff,
  FlowGraph,
  FlowNode,
} from "./flow-types";
import { FLOW_SCHEMA } from "./flow-types";
import { steeringPlan, type SteeringPlan } from "./flow-derive";
import { FLOW_LIVE_GRAPH } from "@/mocks/flow-graph-live";
import { FLOW_SAMPLE_LAYERED } from "@/mocks/flow-sample-layered";

/** The four dock actions (frame 3). Only `steer` edits the cycle brief. */
export type FlowSteeringMode = "steer" | "comment" | "fork" | "attach";

/** What a steering action wrote: journal rows, and at most one cycle-brief edit. */
export interface FlowSteeringResult {
  /** Append-only journal rows, one per selected card (`pb comment --task`). */
  rows: { task: string; action: "comment"; text: string }[];
  /** The cycle-brief `stop` edit, as a diff for the end-goal card (frame 3). */
  goal_diff?: FlowGoalDiff;
  /** The dock's "steering will write" summary. */
  wrote: SteeringPlan;
  /** False while the adapter cannot write (the fixture says so out loud). */
  persisted: boolean;
  /**
   * Why it did not persist, in the adapter's own words — a fixture admitting it is a
   * fixture, or a live engine's refusal. The toast shows this verbatim rather than
   * assuming a cause.
   */
  note?: string;
}

/** Where a payload came from — the room labels the sample as a sample. */
export type FlowAdapterKind = "live" | "sample";

/** The one interface every producer of room data implements. */
export interface FlowAdapter {
  readonly id: string;
  readonly label: string;
  readonly kind: FlowAdapterKind;
  /** Read the whole projection. Must throw on an unknown schema. */
  load(): FlowGraph;
  /**
   * Write a steering action (journal rows + goal edit).
   *
   * MAY BE ASYNC, because a real write is. The fixture answers synchronously and says so
   * (`persisted: false`, `note` explains), while a live adapter talks to a server and must
   * be awaited — and only after awaiting can the toast tell the truth about what landed
   * instead of guessing optimistically. The room awaits both, which costs the fixture nothing.
   */
  applySteering(
    selection: FlowNode[],
    prompt: string,
    mode?: FlowSteeringMode
  ): FlowSteeringResult | Promise<FlowSteeringResult>;
}

/**
 * Refuse a payload this room does not understand, loudly, instead of drawing a
 * half-empty graph. A projection is a contract.
 */
export function assertFlowSchema(graph: FlowGraph): FlowGraph {
  if (graph.schema !== FLOW_SCHEMA) {
    throw new Error(
      `Flow room: unsupported projection schema "${graph.schema}" (expected "${FLOW_SCHEMA}")`
    );
  }
  return graph;
}

const STATUSES = new Set(["todo", "in_progress", "blocked", "done"]);
const EDGE_KINDS = new Set(["dep", "done", "spawn", "fork", "merge", "hil", "idle"]);

/**
 * Check that a payload supplies every field the room reads, with the type the
 * engine actually sends. Returns a list of problems (empty = the shape holds) —
 * the executable pin that stops a fixture drifting away from the engine, and the
 * reason `checks` is a NUMBER here rather than an invented list of results.
 */
export function findEngineShapeProblems(graph: FlowGraph): string[] {
  const problems: string[] = [];
  const need = (condition: boolean, message: string) => {
    if (!condition) problems.push(message);
  };

  need(
    graph.schema === FLOW_SCHEMA,
    `schema is "${graph.schema}", expected "${FLOW_SCHEMA}"`
  );
  need(typeof graph.start?.loop === "string", "start.loop is not a string");
  need(typeof graph.start?.goal === "string", "start.goal is not a string");
  need(typeof graph.start?.phase === "number", "start.phase is not a number");
  need(typeof graph.goal?.stop === "string", "goal.stop is not a string");
  need(Array.isArray(graph.goal?.conditions), "goal.conditions is not an array");
  for (const condition of graph.goal?.conditions ?? []) {
    need(
      condition.met === null || typeof condition.met === "boolean",
      `goal condition "${condition.text}" has met=${String(condition.met)} (expected boolean|null)`
    );
  }
  need(Array.isArray(graph.human?.batch), "human.batch is not an array");
  for (const entry of graph.human?.batch ?? []) {
    need(typeof entry.command === "string", "a human batch entry has no command string");
    need(Array.isArray(entry.tasks), "a human batch entry has no tasks array");
  }
  need(Array.isArray(graph.nodes), "nodes is not an array");
  for (const node of graph.nodes ?? []) {
    need(typeof node.id === "string", "a node has no string id");
    need(typeof node.title === "string", `node ${node.id} has no string title`);
    need(STATUSES.has(node.status), `node ${node.id} has status "${node.status}"`);
    need(typeof node.layer === "string", `node ${node.id} has no string layer`);
    if (node.checks !== undefined) {
      need(typeof node.checks === "number", `node ${node.id} checks is not a number`);
    }
    if (node.acceptance_checks !== undefined) {
      need(
        Array.isArray(node.acceptance_checks),
        `node ${node.id} acceptance_checks is not an array`
      );
    }
    if (node.gate_quality !== undefined) {
      need(
        typeof node.gate_quality === "string",
        `node ${node.id} gate_quality is not a string`
      );
    }
    if (node.claim !== undefined && node.claim !== null) {
      need("by" in node.claim, `node ${node.id} claim has no by field`);
    }
    for (const row of node.journal ?? []) {
      need(typeof row.notes === "string", `node ${node.id} has a journal row without notes`);
      need(
        typeof row.ts === "string" || typeof row.at === "string",
        `node ${node.id} has a journal row without a timestamp`
      );
    }
  }
  for (const edge of graph.edges ?? []) {
    need(
      typeof edge.from === "string" && typeof edge.to === "string",
      "an edge lacks from/to"
    );
    need(EDGE_KINDS.has(edge.kind), `edge ${edge.from}->${edge.to} has kind "${edge.kind}"`);
  }
  return problems;
}

/** The newest aggregate a journal row recorded, if any. */
function outcomeFromJournal(node: FlowNode): FlowChecksOutcome {
  for (const row of [...(node.journal ?? [])].reverse()) {
    if (row.checks === "passed" || row.checks === "failed" || row.checks === "skipped") {
      return row.checks;
    }
  }
  return null;
}

// ── the nodes the engine keeps out of `nodes[]` ──────────────────────────

function startNode(graph: FlowGraph): FlowNode {
  return {
    id: graph.start.id ?? "start",
    kind: "start",
    title: graph.start.goal,
    status: "in_progress",
    layer: "START",
    body: `Stop: ${graph.start.stop}`,
    stoplist: graph.goal.conditions,
    cron: graph.start.cron,
  };
}

function goalNode(graph: FlowGraph): FlowNode {
  return {
    id: graph.goal.id ?? "goal",
    kind: "goal",
    title: "Cycle stop — where this loop hands back",
    status: "todo",
    layer: "GOAL",
    body: graph.goal.stop,
    north_star: graph.goal.north_star,
    stoplist: graph.goal.conditions,
  };
}

/** ONE batch node for every human gate: one hand-off answers them all (D7). */
function batchNode(graph: FlowGraph, id: string): FlowNode {
  const count = graph.human.batch.length;
  return {
    id,
    kind: "batch",
    status: "blocked",
    layer: "GOAL",
    title: `Batch of ${count} task${count === 1 ? "" : "s"} held`,
    body: graph.human.note ?? "every human gate feeds one batch",
  };
}

// ── fork / merge-back: derived, because PB does not model them as edges ──
//
// P1 (lead, phase 42): `pb graph --json` emits only `dep | spawn | hil` edges.
// PB models a branch as a TASK ATTRIBUTE — `node.worker { branch, status,
// merge_ready, merged_at, merge_commit }` — never as a task→task relation. So:
//
//   · an EXPERIMENT node (`kind: "fork"`) with a real worker branch → fork edge
//   · `worker.merge_ready` / `worker.merged_at`                    → merge-back
//   · `goal.merge_back.verdict === "pass"` naming that fork        → merge-back
//
// A SPAWN edge keeps whatever the engine proved; when the engine sent nothing,
// an explicit `action: spawn` journal row proves it and a bare claim does not.

function normalizeForkName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "-");
}

function edgeKey(edge: FlowEdge): string {
  return `${edge.from}->${edge.to}:${edge.kind}`;
}

const TRUNK_BRANCH = "main";

export function deriveWorkerEdges(graph: FlowGraph): FlowEdge[] {
  const nodes = graph.nodes;
  const orchestrator = nodes.find(node => node.kind === "orchestrator");
  const start = nodes.find(node => node.kind === "start");
  const goal = nodes.find(node => node.kind === "goal");
  const existing = new Set(graph.edges.map(edgeKey));
  const derived: FlowEdge[] = [];

  for (const node of nodes) {
    const branch = node.worker?.branch;
    if (!branch) continue;

    const isExperiment = node.kind === "fork" && branch !== TRUNK_BRANCH;
    if (isExperiment) {
      const source = orchestrator?.id ?? start?.id;
      if (source) {
        const forkEdge: FlowEdge = {
          from: source,
          to: node.id,
          kind: "fork",
          label: `fork · ${branch}`,
          proven: true,
          evidence: "worker",
          derived: true,
        };
        if (!existing.has(edgeKey(forkEdge))) {
          derived.push(forkEdge);
          existing.add(edgeKey(forkEdge));
        }
      }
    }

    const verdict = graph.goal.merge_back;
    const namedByGoal = verdict !== undefined && normalizeForkName(verdict.fork) === node.id;
    const mergeProven =
      node.worker?.merge_ready === true ||
      node.merge_ready === true ||
      !!node.worker?.merged_at ||
      (namedByGoal && verdict?.verdict === "pass");
    if (!mergeProven || !goal) continue;
    const workerProves =
      node.worker?.merge_ready === true || !!node.worker?.merged_at || node.merge_ready === true;
    const mergeEdge: FlowEdge = {
      from: node.id,
      to: goal.id,
      kind: "merge",
      label: workerProves
        ? "merge-back · worker merge-ready"
        : `merge-back · checker verdict ${verdict?.verdict}`,
      proven: true,
      evidence: workerProves ? "merge-ready" : "merge-verdict",
      derived: true,
    };
    if (!existing.has(edgeKey(mergeEdge))) {
      derived.push(mergeEdge);
      existing.add(edgeKey(mergeEdge));
    }
  }

  return derived;
}

/** Spawn edges carry their proof; the engine's own verdict is never overridden. */
export function projectSpawnEvidence(graph: FlowGraph): FlowEdge[] {
  const byId = new Map(graph.nodes.map(node => [node.id, node]));
  const start = graph.nodes.find(node => node.kind === "start");
  const orchestrator = graph.nodes.find(node => node.kind === "orchestrator");
  const edges: FlowEdge[] = [];

  for (const edge of graph.edges) {
    if (edge.kind !== "spawn") {
      edges.push(edge);
      continue;
    }
    const target = byId.get(edge.to);
    const spawnedByRow = (target?.journal ?? []).some(
      row => row.action.toLowerCase() === "spawn"
    );
    edges.push({
      ...edge,
      proven: edge.proven ?? spawnedByRow,
      evidence: edge.evidence ?? (spawnedByRow ? "spawn" : "claim"),
    });
  }

  // A task whose journal carries an `action: spawn` row gets the edge even when
  // the projection did not emit one — the row is the proof.
  const emitted = new Set(edges.filter(edge => edge.kind === "spawn").map(edgeKey));
  const source = orchestrator?.id ?? start?.id;
  if (source) {
    for (const node of graph.nodes) {
      if ((node.kind ?? "task") !== "task") continue;
      const spawnedByRow = (node.journal ?? []).some(
        row => row.action.toLowerCase() === "spawn"
      );
      if (!spawnedByRow) continue;
      const edge: FlowEdge = {
        from: source,
        to: node.id,
        kind: "spawn",
        label: "spawn — discovered at runtime",
        proven: true,
        evidence: "spawn",
        derived: true,
      };
      if (!emitted.has(edgeKey(edge))) {
        edges.push(edge);
        emitted.add(edgeKey(edge));
      }
    }
  }

  return edges;
}

/**
 * Everything the room draws comes out of here — engine payload in, room graph
 * out. Pure: it adds the bookends/batch node, defaults `kind`, derives the
 * aggregate checks outcome and then appends the worker-derived edges.
 */
export function projectGraph(raw: FlowGraph): FlowGraph {
  assertFlowSchema(raw);
  const nodes: FlowNode[] = [];
  const known = new Set(raw.nodes.map(node => node.id));

  for (const node of raw.nodes) {
    nodes.push({
      ...node,
      kind: node.kind ?? "task",
      checks_outcome: node.checks_outcome ?? outcomeFromJournal(node),
    });
  }

  const start = startNode(raw);
  if (!known.has(start.id) && !nodes.some(node => node.id === start.id)) {
    nodes.unshift(start);
  }
  const goal = goalNode(raw);
  if (!known.has(goal.id) && !nodes.some(node => node.id === goal.id)) {
    nodes.push(goal);
  }

  // The engine points its `hil` edge at a node id it does not put in `nodes[]`.
  const hilTarget = raw.edges.find(edge => edge.kind === "hil")?.to;
  if (raw.human.batch.length > 0) {
    const id = hilTarget ?? "human";
    if (!known.has(id) && !nodes.some(node => node.id === id)) {
      nodes.push(batchNode(raw, id));
    }
  }

  const withNodes: FlowGraph = { ...raw, nodes };
  const withProof: FlowGraph = { ...withNodes, edges: projectSpawnEvidence(withNodes) };
  return { ...withProof, edges: [...withProof.edges, ...deriveWorkerEdges(withProof)] };
}

// ── the three producers ──────────────────────────────────────────────────

function steeringResult(
  selection: FlowNode[],
  prompt: string,
  mode: FlowSteeringMode
): FlowSteeringResult {
  const rows =
    mode === "attach"
      ? []
      : selection.map(node => ({
          task: node.id,
          action: "comment" as const,
          text: prompt,
        }));
  const goalDiff: FlowGoalDiff | undefined =
    mode === "steer" && selection.length > 0
      ? {
          old: "Stop: design approved by the human",
          new: "Stop: design approved; prototype verified in the app_design playground",
          when: `applied just now · from steering on ${selection.length} card${
            selection.length === 1 ? "" : "s"
          }`,
          from: `pb comment on ${selection.length} card${
            selection.length === 1 ? "" : "s"
          } + 1 cycle-brief edit`,
        }
      : undefined;
  return {
    rows,
    goal_diff: goalDiff,
    wrote: steeringPlan(selection),
    persisted: false,
    note: "fixture adapter: rows shown, nothing written to the playbook yet",
  };
}

/** The default: this repo's own `pb graph --json`, captured verbatim. */
export const LIVE_SNAPSHOT_ADAPTER: FlowAdapter = {
  id: "snapshot",
  kind: "live",
  label: "snapshot · pb graph --json (this repo)",
  load: () => projectGraph(FLOW_LIVE_GRAPH),
  applySteering: (selection, prompt, mode = "steer") =>
    steeringResult(selection, prompt, mode),
};

/** The painted frame's three-layer sample — labelled a sample, never this repo. */
export const SAMPLE_LAYERED_ADAPTER: FlowAdapter = {
  id: "sample",
  kind: "sample",
  label: "sample · painted frame (three declared layers)",
  load: () => projectGraph(FLOW_SAMPLE_LAYERED),
  applySteering: (selection, prompt, mode = "steer") =>
    steeringResult(selection, prompt, mode),
};

/** What the room opens with. Anything implementing FlowAdapter is accepted. */
export const DEFAULT_FLOW_ADAPTER: FlowAdapter = LIVE_SNAPSHOT_ADAPTER;

/**
 * P3: the live adapter. `read` is a thunk around `pb graph --json` (the Rust
 * allowlist gains `graph`), `write` around `pb comment --task … --goal …`.
 */
export function createPbGraphAdapter(read: () => FlowGraph): FlowAdapter {
  return {
    id: "pb-graph",
    kind: "live",
    label: "live · pb graph --json",
    load: () => projectGraph(assertFlowSchema(read())),
    applySteering: (selection, prompt, mode = "steer") =>
      steeringResult(selection, prompt, mode),
  };
}
