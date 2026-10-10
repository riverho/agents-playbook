// ─── Flow room — projection, honesty rules and the adapter seam ───
//
// This is the room's contract in executable form, and it runs against BOTH
// payloads: this repo's live `pb graph --json` snapshot and the labelled
// three-layer sample. The point of the second half is that the P3 swap cannot
// break a component: the same derivations must hold for the engine's own shape
// (`kind` absent, `checks` a number, `gate_quality` a decorated string, per-check
// exit codes absent).

import { describe, expect, it } from "vitest";
import {
  LIVE_SNAPSHOT_ADAPTER,
  SAMPLE_LAYERED_ADAPTER,
  assertFlowSchema,
  createPbGraphAdapter,
  deriveWorkerEdges,
  findEngineShapeProblems,
  projectGraph,
  type FlowAdapter,
} from "@/lib/flow-adapter";
import {
  FLOW_EDGE_STYLE,
  FLOW_TONE,
  allChecksPassed,
  checksCount,
  checksOutcome,
  checksUnproven,
  derivedCycleIndex,
  edgeKindsInUse,
  flowCountsLine,
  flowEdgeStyle,
  flowRail,
  flowStepLabel,
  hasDeclaredLayers,
  hasRedCheck,
  isHollow,
  isProvenCondition,
  isUnevaluatedGate,
  needsHuman,
  steeringPlan,
} from "@/lib/flow-derive";
import { layoutFlow, layoutNodeById } from "@/lib/flow-layout";
import { FLOW_NODE_TYPES, projectToCanvas, type FlowCardData } from "@/lib/flow-projection";
import { FLOW_LIVE_GRAPH } from "@/mocks/flow-graph-live";
import { FLOW_SAMPLE_LAYERED } from "@/mocks/flow-sample-layered";
import type { FlowGraph, FlowNode } from "@/lib/flow-types";

const live = LIVE_SNAPSHOT_ADAPTER.load();
const sample = SAMPLE_LAYERED_ADAPTER.load();

const nodeById = (graph: FlowGraph, id: string): FlowNode => {
  const node = graph.nodes.find(entry => entry.id === id);
  if (!node) throw new Error(`graph has no node ${id}`);
  return node;
};

describe("the adapter seam survives the real engine payload", () => {
  it("synthesises the nodes the engine keeps out of nodes[]", () => {
    // The spawn edges point at `start` and the hil edge points at `human`; both
    // ids are absent from `nodes[]`, so without synthesis every edge dangles.
    const ids = new Set(live.nodes.map(node => node.id));
    expect(ids.has("start")).toBe(true);
    expect(ids.has("goal")).toBe(true);
    expect(ids.has("human")).toBe(true);
    for (const edge of live.edges) {
      expect(ids.has(edge.from), edge.from).toBe(true);
      expect(ids.has(edge.to), edge.to).toBe(true);
    }
  });

  it("defaults `kind` so every engine node gets a registered React Flow type", () => {
    for (const node of live.nodes) {
      if (node.id === "start" || node.id === "goal" || node.id === "human") continue;
      expect(node.kind, `${node.id} kind`).toBe("task");
    }
    const canvas = projectToCanvas(live);
    expect(canvas.nodes).toHaveLength(live.nodes.length);
    for (const node of canvas.nodes) {
      expect(FLOW_NODE_TYPES).toContain(node.type as string);
    }
    // Nothing throws on the engine's real numbers/strings.
    for (const node of live.nodes) {
      expect(() => checksCount(node)).not.toThrow();
      expect(() => hasRedCheck(node)).not.toThrow();
      expect(() => flowRail(node)).not.toThrow();
    }
  });

  it("fires the hollow warning off the engine's decorated gate_quality", () => {
    // The engine sends "✓verified" / "⚠hollow"; an equality test on "hollow"
    // could never fire live (the checker caught exactly that).
    expect(
      isHollow({ id: "x", title: "x", status: "todo", layer: "L1", gate_quality: "⚠hollow" })
    ).toBe(true);
    expect(
      isHollow({ id: "x", title: "x", status: "todo", layer: "L1", gate_quality: "✓verified" })
    ).toBe(false);
    expect(isHollow(nodeById(sample, "plan-20260721-004"))).toBe(true);
  });

  it("reads the engine's checks as a count plus an aggregate outcome", () => {
    const node = nodeById(live, "plan-20260721-001");
    expect(node.checks).toBe(2);
    expect(node.acceptance_checks).toEqual([
      "node scripts/test-orca-runcard.mjs",
      "node scripts/pb.mjs validate",
    ]);
    expect(checksCount(node)).toBe(2);
    // No per-check exit codes exist in the payload; the aggregate comes from the
    // journal row that recorded it.
    expect(node.checks_detail).toBeUndefined();
    expect(checksOutcome(node)).toBe("passed");
    expect(allChecksPassed(node)).toBe(true);
  });

  it("never invents a per-check exit code", () => {
    expect(live.nodes.filter(node => (node.checks_detail ?? []).length > 0)).toHaveLength(0);
  });

  it("carries only engine-valid statuses, ids and a batch of real tasks", () => {
    // The snapshot is verbatim engine output now, so the pin is the SHAPE plus
    // the engine's own invariants — not a frozen backlog (unrelated work moves
    // statuses daily, and that must never redden the room).
    const valid = new Set(["todo", "in_progress", "blocked", "done"]);
    expect(live.nodes.every(node => valid.has(node.status))).toBe(true);
    expect(new Set(live.nodes.map(node => node.id)).size).toBe(live.nodes.length);
    const ids = new Set(live.nodes.map(node => node.id));
    for (const entry of live.human.batch) {
      expect(entry.tasks.length).toBeGreaterThan(0);
      for (const task of entry.tasks) {
        expect(ids.has(task), task).toBe(true);
        expect(nodeById(live, task).manual).toBe(true);
      }
    }
    expect(live.nodes.filter(node => node.kind === "batch")).toHaveLength(
      live.human.batch.length > 0 ? 1 : 0
    );
  });

  it("refuses a foreign schema instead of drawing half a graph", () => {
    expect(() => assertFlowSchema({ ...live, schema: "something-else.v9" })).toThrow(
      /unsupported projection schema/
    );
  });

  it("passes its own engine-shape validator — and the validator has teeth", () => {
    expect(findEngineShapeProblems(FLOW_LIVE_GRAPH)).toEqual([]);
    expect(findEngineShapeProblems(FLOW_SAMPLE_LAYERED)).toEqual([]);
    const broken = {
      ...FLOW_LIVE_GRAPH,
      nodes: [{ ...FLOW_LIVE_GRAPH.nodes[0], checks: [{ command: "x", passed: true }] }],
    } as unknown as FlowGraph;
    expect(findEngineShapeProblems(broken).join("\n")).toMatch(/checks is not a number/);
  });

  it("behaves identically through the P3 factory (the swap is one line)", () => {
    const p3: FlowAdapter = createPbGraphAdapter(() => FLOW_LIVE_GRAPH);
    const viaFactory = p3.load();
    expect(viaFactory.nodes.map(node => node.id)).toEqual(live.nodes.map(node => node.id));
    expect(viaFactory.edges.map(edge => edge.kind)).toEqual(live.edges.map(edge => edge.kind));
    expect(flowCountsLine(viaFactory)).toBe(flowCountsLine(live));
  });

  it("labels the layered sample as a sample, and solves its edges too", () => {
    expect(FLOW_SAMPLE_LAYERED.sample).toBe(true);
    expect(SAMPLE_LAYERED_ADAPTER.kind).toBe("sample");
    expect(LIVE_SNAPSHOT_ADAPTER.kind).toBe("live");
    const ids = new Set(sample.nodes.map(node => node.id));
    for (const edge of sample.edges) {
      expect(ids.has(edge.from), edge.from).toBe(true);
      expect(ids.has(edge.to), edge.to).toBe(true);
    }
    // ONE batch node holds both sample gates.
    expect(sample.nodes.filter(node => node.kind === "batch")).toHaveLength(1);
    expect(sample.human.batch).toHaveLength(2);
  });
});

describe("frame 1 (the labelled sample) — cards, edges and the honesty rules", () => {
  it("draws nine tasks, two bookends, a batch and two gate posts", () => {
    const count = (kind: string) => sample.nodes.filter(node => node.kind === kind).length;
    expect(count("task")).toBe(9);
    expect(count("start")).toBe(1);
    expect(count("goal")).toBe(1);
    expect(count("orchestrator")).toBe(1);
    expect(count("fork")).toBe(2);
    expect(count("batch")).toBe(1);
    expect(count("gatepost")).toBe(2);
  });

  it("uses all five edge kinds with the frame's counts", () => {
    const counts = sample.edges.reduce<Record<string, number>>((acc, edge) => {
      acc[edge.kind] = (acc[edge.kind] ?? 0) + 1;
      return acc;
    }, {});
    expect(counts).toEqual({ dep: 4, done: 4, spawn: 1, fork: 2, merge: 1, hil: 2 });
    expect(edgeKindsInUse(sample).sort()).toEqual(
      ["dep", "done", "spawn", "fork", "merge", "hil"].sort()
    );
  });

  it("pins the edge vocabulary to the values measured from flow.css", () => {
    expect(FLOW_EDGE_STYLE.dep.stroke).toBe("#c9c3bb");
    expect(FLOW_EDGE_STYLE.dep.width).toBe(1.25);
    expect(FLOW_EDGE_STYLE.done.stroke).toBe("rgba(17, 17, 17, 0.3)");
    expect(FLOW_EDGE_STYLE.spawn.dash).toBe("5 4");
    expect(FLOW_EDGE_STYLE.fork.dash).toBe("2 3");
    expect(FLOW_EDGE_STYLE.merge.width).toBe(2.25);
    expect(FLOW_EDGE_STYLE.merge.double).toBe(true);
    expect(FLOW_EDGE_STYLE.hil.stroke).toBe("var(--accent-rose)");
    expect(FLOW_EDGE_STYLE.hil.dash).toBe("4 3");
    // A proven spawn is solid; a claim keeps the dash.
    expect(flowEdgeStyle("spawn", true).dash).toBeUndefined();
    expect(flowEdgeStyle("spawn", false).dash).toBe("5 4");
  });

  it("feeds both sample gates into ONE hand-off", () => {
    const batch = sample.nodes.filter(node => node.kind === "batch");
    expect(batch).toHaveLength(1);
    const hilTargets = sample.edges.filter(edge => edge.kind === "hil").map(edge => edge.to);
    expect(new Set(hilTargets)).toEqual(new Set([batch[0].id]));
    expect(sample.human.batch.flatMap(entry => entry.tasks).sort()).toEqual([
      "plan-20260918-002",
      "plan-20260918-004",
    ]);
  });

  it("derives fork and merge-back from the worker record, never from a parent", () => {
    const forks = sample.edges.filter(edge => edge.kind === "fork");
    expect(forks).toHaveLength(2);
    expect(forks.every(edge => edge.derived === true && edge.evidence === "worker")).toBe(true);
    const merges = sample.edges.filter(edge => edge.kind === "merge");
    expect(merges).toHaveLength(1);
    expect(merges[0]).toMatchObject({ from: "fork-a", to: "goal", evidence: "merge-verdict" });
    // Strip the proof and the merge edge disappears with it.
    const unproven = projectGraph({
      ...FLOW_SAMPLE_LAYERED,
      goal: { ...FLOW_SAMPLE_LAYERED.goal, merge_back: undefined },
    });
    expect(deriveWorkerEdges(unproven).filter(edge => edge.kind === "merge")).toHaveLength(0);
  });

  it("stamps what proves a spawn edge when the engine sent no verdict", () => {
    const liveSpawn = live.edges.filter(edge => edge.kind === "spawn");
    expect(liveSpawn.length).toBeGreaterThan(0);
    // The engine's own verdict is kept, never overridden.
    expect(liveSpawn.every(edge => edge.proven === false && edge.evidence === "claim")).toBe(true);

    expect(sample.edges.find(edge => edge.kind === "spawn")).toMatchObject({
      proven: true,
      evidence: "spawn",
    });
    // Strip both the engine's verdict and the proving row: the edge must come
    // back as a dashed CLAIM, never as a fact.
    const stripped: FlowGraph = {
      ...FLOW_SAMPLE_LAYERED,
      nodes: FLOW_SAMPLE_LAYERED.nodes.map(node =>
        node.id === "monitor-help-must-not-mutate"
          ? { ...node, journal: (node.journal ?? []).filter(row => row.action === "claim") }
          : node
      ),
      edges: FLOW_SAMPLE_LAYERED.edges.map(edge =>
        edge.kind === "spawn" ? { ...edge, proven: undefined, evidence: undefined } : edge
      ),
    };
    const restamped = projectGraph(stripped).edges.filter(edge => edge.kind === "spawn");
    expect(restamped[0]).toMatchObject({ proven: false, evidence: "claim" });
  });
});

describe("the cycle rail is derived from journal rows, never hand-set", () => {
  it("puts the sample's spawn-discovered card on verify, step 4/6", () => {
    const node = nodeById(sample, "monitor-help-must-not-mutate");
    expect(derivedCycleIndex(node)).toBe(4);
    const rail = flowRail(node);
    expect(rail.derived).toBe(true);
    expect(rail.filled).toBe(4);
    expect(rail.step).toBe("verify");
    expect(rail.pulsing).toBe(true);
    expect(flowStepLabel(node)).toBe("verify · step 4/6");
  });

  it("moves the rail when the journal moves — it is not a stored number", () => {
    const node = nodeById(sample, "monitor-help-must-not-mutate");
    const claimOnly: FlowNode = {
      ...node,
      journal: (node.journal ?? []).filter(row => row.action === "claim"),
    };
    expect(flowRail(claimOnly).step).toBe("select");
    const noRows: FlowNode = { ...node, journal: [], cycle: undefined };
    expect(flowRail(noRows).derived).toBe(false);
  });

  it("never shows a green rail unless a run is provably green", () => {
    // A done card whose journal recorded a pass fills all six…
    const passed = projectGraph({
      ...FLOW_SAMPLE_LAYERED,
      nodes: FLOW_SAMPLE_LAYERED.nodes.map(node =>
        node.id === "monitor-help-must-not-mutate"
          ? { ...node, status: "done", checks_detail: [], checks_outcome: "passed" }
          : node
      ),
    });
    expect(flowRail(nodeById(passed, "monitor-help-must-not-mutate")).filled).toBe(6);
    // …a red run stops at verify…
    const red = nodeById(sample, "monitor-help-must-not-mutate");
    expect(hasRedCheck(red)).toBe(true);
    expect(flowRail({ ...red, status: "done" }).filled).toBe(4);
    // …and an unrecorded run is NOT a pass either.
    const unknown: FlowNode = {
      ...red,
      status: "done",
      checks_detail: [],
      checks_outcome: null,
      journal: [],
    };
    expect(checksUnproven(unknown)).toBe(true);
    expect(flowRail(unknown).filled).toBeLessThan(6);
  });

  it("never fills the rail on a card that has not started", () => {
    for (const id of ["plan-20260918-002", "plan-20260918-004"]) {
      expect(flowRail(nodeById(sample, id)).filled).toBe(0);
      expect(flowStepLabel(nodeById(sample, id))).toBeNull();
    }
  });

  it("keeps the five tones of the stage layer", () => {
    expect(FLOW_TONE.done).toBe("#2f2f2f");
    expect(FLOW_TONE.in_progress).toBe("var(--accent-teal)");
    expect(FLOW_TONE.blocked).toBe("var(--accent-rose)");
    expect(FLOW_TONE.todo).toBe("var(--text-tertiary)");
  });
});

describe("what the payload does NOT say, the room does not claim", () => {
  it("renders every prose stop condition open, never ticked", () => {
    expect(live.goal.conditions.length).toBeGreaterThan(0);
    expect(live.goal.conditions.every(condition => condition.met === null)).toBe(true);
    expect(live.goal.conditions.some(isProvenCondition)).toBe(false);
    expect(nodeById(live, "goal").stoplist?.every(condition => condition.met === null)).toBe(true);
  });

  it("uses PB's declared layers as the axis, and says 'flat' when there are none", () => {
    // The human approved declaring layers, so the live payload now carries three
    // strata and the room draws the painted three-column graph.
    expect(hasDeclaredLayers(live)).toBe(true);
    expect(
      new Set(live.nodes.filter(node => node.kind === "task").map(node => node.layer))
    ).toEqual(new Set(["L0", "L1", "L2"]));
    expect(hasDeclaredLayers(sample)).toBe(true);
    // A payload with no declared layer still renders one column and one label —
    // the fallback is exercised against a synthetic flat graph, not a fixture.
    const flat: FlowGraph = {
      ...live,
      nodes: live.nodes.map(node => ({ ...node, layer: "L1", declared_layer: null })),
    };
    expect(hasDeclaredLayers(flat)).toBe(false);
    const columns = new Set(
      layoutFlow(flat).nodes.filter(node => !node.gatepost && node.kind !== "start" && node.kind !== "goal")
        .map(node => node.column)
    );
    expect(columns.size).toBe(1);
  });

  it("shows no orchestrator, fork or gate post live — and only proof-derived edges", () => {
    // None of those has a live source today: drawing them would invent topology
    // the engine does not have. The one derived edge is a merge-back, and it
    // exists only because the engine says `merge_ready: true` for that task.
    expect(live.nodes.filter(node => node.kind === "orchestrator")).toHaveLength(0);
    expect(live.nodes.filter(node => node.kind === "fork")).toHaveLength(0);
    expect(live.nodes.filter(node => node.kind === "gatepost")).toHaveLength(0);
    expect(new Set(live.edges.map(edge => edge.kind))).toEqual(
      new Set(["spawn", "hil", "merge"])
    );
    const derived = live.edges.filter(edge => edge.derived === true);
    expect(derived.length).toBeGreaterThan(0);
    expect(derived.every(edge => edge.proven === true)).toBe(true);
    expect(derived.every(edge => nodeById(live, edge.from).merge_ready === true)).toBe(true);
    // No dependency edges exist, because this playbook declares no dependencies.
    expect(live.edges.some(edge => edge.kind === "dep" || edge.kind === "done")).toBe(false);
  });

  it("labels the declared-but-unexecuted gates instead of calling them blockers", () => {
    expect(sample.human.unevaluated_gates).toHaveLength(2);
    expect(sample.nodes.filter(node => node.kind === "gatepost").every(isUnevaluatedGate)).toBe(
      true
    );
    expect(live.human.gates_checked).toBe(false);
    expect(live.human.unevaluated_gates ?? []).toHaveLength(0);
  });

  it("counts the room from the graph rather than a painted string", () => {
    expect(flowCountsLine(sample)).toBe(
      "9 tasks · 1 in progress · 2 blocked · 6 done · 1 HIL batch · 2 forks"
    );
    const line = flowCountsLine(live);
    expect(line).toContain("1 HIL batch");
    // No worker records live, so the room claims no forks at all.
    expect(line).not.toContain("forks");
    expect(needsHuman(nodeById(live, "plan-20260918-002"))).toBe(true);
  });

  it("says out loud that a fixture write persisted nothing", async () => {
    // AWAITED because the seam now allows a promise: a live adapter talks to a server, while
    // the fixture still answers synchronously. Awaiting keeps every assertion below identical.
    const result = await LIVE_SNAPSHOT_ADAPTER.applySteering(
      [nodeById(live, "plan-20260721-004")],
      "keep it in the playground",
      "steer"
    );
    expect(result.persisted).toBe(false);
    expect(result.rows).toEqual([
      { task: "plan-20260721-004", action: "comment", text: "keep it in the playground" },
    ]);
    // …and the reason comes from the adapter, so a live refusal can explain itself too.
    expect(result.note).toContain("fixture adapter");
    expect(steeringPlan([nodeById(live, "plan-20260721-004")]).rows).toBe(
      "1 row · action: comment"
    );
  });
});

describe("layout: PB's layering is the axis, dagre does the rest", () => {
  const layout = layoutFlow(sample);

  it("runs the dagre adapter and agrees with the declared layers", () => {
    expect(layout.engine).toBe("dagre");
    expect(layout.warnings).toEqual([]);
    for (const node of sample.nodes.filter(entry => entry.kind !== "gatepost")) {
      expect(layoutNodeById(layout, node.id)?.column).toBe(
        ["START", "L0", "L1", "L2", "GOAL"].indexOf(node.layer)
      );
    }
  });

  it("lays the live payload out over its three declared layers", () => {
    const layout = layoutFlow(live);
    const columns = new Set(
      live.nodes
        .filter(node => node.kind === "task")
        .map(node => layoutNodeById(layout, node.id)?.column)
    );
    expect(columns.size).toBe(3);
    const x = (id: string) => layoutNodeById(layout, id)?.x ?? -1;
    expect(x("start")).toBeLessThan(x("multi-loop-safety-carryover"));
    expect(x("multi-loop-safety-carryover")).toBeLessThan(x("plan-20260721-001"));
    expect(x("plan-20260721-001")).toBeLessThan(x("goal"));
    // The declared layer owns the column, whatever dagre's rank said.
    for (const node of live.nodes.filter(entry => entry.kind === "task")) {
      expect(layoutNodeById(layout, node.id)?.column).toBe(
        ["START", "L0", "L1", "L2", "GOAL"].indexOf(node.layer)
      );
    }
  });

  it("hands each card the projection data its renderer reads", () => {
    const canvas = projectToCanvas(sample);
    const cardData = (id: string): FlowCardData => {
      const node = canvas.nodes.find(entry => entry.id === id);
      if (!node) throw new Error(`no canvas node ${id}`);
      return node.data as FlowCardData;
    };
    expect(cardData("start").loopId).toBe("loop-20261009-001");
    expect(cardData("start").phase).toBe(42);
    expect(cardData("start").cron?.every).toBe("every 30m");
    expect(cardData("goal").mergeBack).toEqual({ verdict: "pass", fork: "fork A" });
    expect(cardData("human").batch).toHaveLength(2);
    expect(cardData("human").unevaluated).toHaveLength(2);
    expect(cardData("orchestrator").metrics?.forks).toBe(2);
    expect(cardData("gate-l0").gateLabel?.text).toContain("unevaluated");
  });
});
