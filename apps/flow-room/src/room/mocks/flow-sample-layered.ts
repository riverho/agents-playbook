// ─── Flow room — the LAYERED SAMPLE (explicitly NOT this repo) ───
//
// This file used to carry the painted frame's three-column look, because this
// playbook declared no layers. That changed: the human approved declaring L0/L1/L2
// and `pb graph --json` now returns nodes at L0 / L1 / L2, so the room's DEFAULT
// live snapshot already draws the three-column graph, with its own spawn/hil edges
// and its own human batch.
//
// What the live projection still cannot supply — and the only reason this sample
// exists — is four things:
//
//   1. per-check EXIT CODES (`checks_detail`): the engine sends a count plus one
//      aggregate outcome, so `✗ exit 1 · RED` is unprovable live;
//   2. a fork EXPERIMENT (a `worker` record on a node the payload marks `fork`):
//      live has one worker, but nowhere is it an experiment branch of anything;
//   3. a declared-but-UNEVALUATED layer gate (gate posts + `unevaluated_gates`):
//      live reports `gates_checked: false` and emits no gate nodes;
//   4. a RED-before check on a card that is honest about looking red.
//
// It stays marked `sample: true` and labelled in the room's source chip, so it is
// never served as this repo's state. Gate names are read from the payloads — never
// hard-coded in the UI.

import type { FlowEdge, FlowGraph, FlowJournalRow, FlowNode } from "@/lib/flow-types";

const LOOP = "loop-20261009-001";

/** A sample task. `checks` is the engine's COUNT; `_detail` is sample-only. */
function task(
  id: string,
  title: string,
  layer: string,
  declaredLayer: string,
  status: FlowNode["status"],
  checks: number,
  acceptanceChecks: string[],
  extra: Partial<FlowNode> = {}
): FlowNode {
  return {
    id,
    kind: "task",
    title,
    status,
    layer,
    declared_layer: declaredLayer,
    derived_layer: Number(declaredLayer.slice(1)),
    skill: "run-task",
    checks,
    acceptance_checks: acceptanceChecks,
    checks_outcome: status === "done" ? "passed" : null,
    gate_quality: "✓verified",
    claim: status === "done" ? { by: "agent", seq: 21 } : null,
    checker: null,
    worker: null,
    docs: [],
    journal: [],
    ...extra,
  };
}

function row(seq: number, ts: string, action: string, agent: string, notes: string, checks?: FlowJournalRow["checks"]): FlowJournalRow {
  return { seq, ts, action, agent, notes, checks: checks ?? null };
}

const TASKS: FlowNode[] = [
  // ── L0 ────────────────────────────────────────────────────────────────
  task(
    "multi-loop-safety-carryover",
    "Lock in the multi-worker safety core",
    "L0",
    "L0",
    "done",
    6,
    [
      "node scripts/test-concurrency-state.mjs",
      "node scripts/test-worker-state-txn.mjs",
      "node scripts/test-repair-state.mjs",
      "node scripts/test-auto-attribution.mjs",
      "node scripts/test-worker-worktree.mjs",
      "node scripts/pb.mjs validate",
    ],
    {
      journal: [
        row(20, "2026-09-17T17:49:42.708Z", "claim", "agent", "claim held"),
        row(21, "2026-09-17T17:50:51.470Z", "execute", "agent", "6 checks exited 0", "passed"),
      ],
      provenance: {
        spawned_by: "loop loop-20260917-001",
        origin: "carryover of the archived multi-loop track",
        recorded_by: "agent · ownership token · loop-20260917-001",
      },
    }
  ),
  task(
    "plan-20260920-001",
    "Layer-model hardening",
    "L0",
    "L0",
    "done",
    5,
    [
      "node scripts/test-layered-plan.mjs",
      "node scripts/test-shell-split-quotes.mjs",
      "node scripts/test-repair-terminal-release.mjs",
      "node scripts/pb.mjs validate",
      "npm test",
    ],
    {
      journal: [
        row(25, "2026-09-20T07:32:06.864Z", "claim", "agent", "claim held"),
        row(26, "2026-09-20T07:36:03.665Z", "execute", "agent", "5 checks exited 0", "passed"),
      ],
    }
  ),
  // ── L1 ────────────────────────────────────────────────────────────────
  task(
    "plan-20260920-002",
    "Human-gated branches: one batch, one hand-off",
    "L1",
    "L1",
    "done",
    4,
    [
      "node scripts/test-human-gates.mjs",
      "node scripts/test-layered-plan.mjs",
      "node scripts/pb.mjs validate",
      "npm test",
    ],
    {
      journal: [
        row(29, "2026-09-20T17:25:41.753Z", "claim", "agent", "claim held"),
        row(31, "2026-09-20T17:27:34.623Z", "execute", "agent", "4 checks exited 0", "passed"),
      ],
    }
  ),
  task(
    "plan-20260721-001",
    "RunCard schema + JSON helpers for worker runs",
    "L1",
    "L1",
    "done",
    2,
    ["node scripts/test-orca-runcard.mjs", "node scripts/pb.mjs validate"],
    {
      journal: [
        row(4, "2026-07-21T17:24:56.287Z", "claim", "agent", "claim held"),
        row(5, "2026-07-21T17:24:56.287Z", "execute", "agent", "2 checks exited 0", "passed"),
      ],
    }
  ),
  task(
    "plan-20260721-004",
    "Wenmei contract: PB owns truth",
    "L1",
    "L1",
    "done",
    4,
    [
      "git ls-files --error-unmatch docs/wenmei-pb-integration-contract.md",
      "grep -q 'PB owns truth' docs/wenmei-pb-integration-contract.md",
      "grep -q 'checker' docs/wenmei-pb-integration-contract.md",
      "node scripts/pb.mjs validate",
    ],
    {
      // pb validate's own wrapper: these four checks are all structural, so the
      // gate cannot fail on the thing it claims to protect. Sample value.
      gate_quality: "⚠hollow",
      docs: ["docs/wenmei-pb-integration-contract.md"],
      merge_warnings: ["hollow gate: every check is structural (pb validate)"],
      journal: [
        row(7, "2026-07-21T17:25:49.078Z", "claim", "agent", "claim held"),
        row(9, "2026-07-21T17:25:49.078Z", "execute", "agent", "4 checks exited 0", "passed"),
      ],
    }
  ),
  task(
    "monitor-help-must-not-mutate",
    "A --help run must never mutate the backlog",
    "L1",
    "L1",
    "in_progress",
    2,
    [
      "node scripts/test-daily-monitor-help-inert.mjs",
      "node scripts/pb.mjs validate",
    ],
    {
      // The RED-before check: sample-only per-check detail (see the file header).
      checks_detail: [
        { command: "node scripts/test-daily-monitor-help-inert.mjs", exit_code: 1, passed: false },
        { command: "node scripts/pb.mjs validate", exit_code: 0, passed: true },
      ],
      checks_outcome: "failed",
      claim: { by: "lead", seq: 28, loop_id: LOOP },
      elapsed: "12m",
      docs: ["docs/design/graph-flow-ui.md", "app_design/design-contract.yaml"],
      worker: { branch: "agent/monitor-help", status: "created", ahead: 2, uncommitted: 1, merge_ready: false },
      checker: { verdict: "none" },
      merge_reasons: ["checker verdict must be pass (got none recorded)"],
      provenance: {
        spawned_by: "orchestrator (lead), round 3 · action: spawn",
        origin: "recon probe executed a real monitor iteration",
        correction: "journal seq 26/27 void seq 23/25",
        recorded_by: "agent lead · ownership token · loop-20261009-001",
      },
      journal: [
        row(24, "2026-10-09T17:40:00.000Z", "spawn", "lead", "orchestrator (lead), round 3 · action: spawn"),
        row(28, "2026-10-09T18:03:00.000Z", "claim", "lead", "claim held by lead · ownership token"),
        row(29, "2026-10-09T18:11:00.000Z", "test", "lead", "node scripts/test-daily-monitor-help-inert.mjs → exit 1 · RED", "failed"),
      ],
    }
  ),
  // ── L2 ────────────────────────────────────────────────────────────────
  task(
    "plan-20261009-001",
    "Ship v0.7.1 and mount it in the desktop profile",
    "L2",
    "L2",
    "done",
    6,
    [
      "npm view agents-playbook@0.7.1 version",
      "npm view dsh-agents-playbook@0.7.1 version",
      "git show-ref --tags v0.7.1",
      "node scripts/test-npm-pack-shape.mjs",
      "node scripts/pb.mjs validate",
      "npm test",
    ],
    {
      skill: "release",
      journal: [
        row(32, "2026-10-09T15:39:36.202Z", "claim", "session-184461c9", "claim held"),
        row(33, "2026-10-09T15:39:59.628Z", "execute", "session-184461c9", "6 checks exited 0", "passed"),
      ],
    }
  ),
  task(
    "plan-20260918-002",
    "Publish dsh-agents-playbook@0.6.2 to npm",
    "L2",
    "L2",
    "blocked",
    1,
    ["npm view dsh-agents-playbook@0.6.2 version"],
    {
      skill: "release",
      manual: true,
      checks_outcome: null,
      merge_reasons: ["blocked: a person has to run the publish"],
    }
  ),
  task(
    "plan-20260918-004",
    "Publish v0.6.3 — needs a valid npm token",
    "L2",
    "L2",
    "blocked",
    2,
    ["npm view agents-playbook@0.6.3 version", "npm view dsh-agents-playbook@0.6.3 version"],
    {
      skill: "release",
      manual: true,
      checks_outcome: null,
      merge_reasons: ["blocked: a person has to run the publish"],
    }
  ),
];

/** The orchestrator round: the painted frame's routing-around-the-blocker card. */
const ORCHESTRATOR: FlowNode = {
  id: "orchestrator",
  kind: "orchestrator",
  title: "lead — routing around the blocker",
  status: "in_progress",
  layer: "L0",
  declared_layer: "L0",
  body: "publish is human-gated → did not wait. Spawned the defect found at runtime, forked 2 experiments.",
  metrics: { spawns: 1, forks: 2, hil: 1, rounds: 3 },
  journal: [],
};

const FORK_A: FlowNode = {
  id: "fork-a",
  kind: "fork",
  title: "Flow room prototype in app_design",
  status: "in_progress",
  layer: "L1",
  declared_layer: "L1",
  progress: 45,
  worker: { branch: "agent/graph-room", status: "created", merge_ready: false },
  checker: { verdict: "none" },
  merge_reasons: ["checker verdict must be pass (got none recorded)"],
  docs: ["artifacts/graph-flow-ui/DESIGN.md", "artifacts/graph-flow-ui/frames/f1-room-overview.png"],
  journal: [
    row(36, "2026-10-10T02:06:00.000Z", "claim", "p2-flow-room", "claim held · agent/graph-room"),
    row(37, "2026-10-10T02:20:00.000Z", "implement", "p2-flow-room", "room + layout adapter"),
  ],
};

const FORK_B: FlowNode = {
  id: "fork-b",
  kind: "fork",
  title: "pb graph --json projection + tests",
  status: "in_progress",
  layer: "L2",
  declared_layer: "L2",
  progress: 15,
  worker: { branch: "agent/graph-json", status: "created", merge_ready: false },
  checker: { verdict: "none" },
  merge_reasons: ["checker verdict must be pass (got none recorded)"],
  journal: [row(35, "2026-10-09T18:06:00.000Z", "claim", "p1-graph-projection", "claim held")],
};

/** Gate posts: declared layer gates whose commands have NOT been executed. */
const GATES: FlowNode[] = [
  {
    id: "gate-l0",
    kind: "gatepost",
    title: "gate L0",
    status: "done",
    layer: "L0",
    declared_layer: "L0",
    gate: { id: "gate-l0", command: "npm test", passing: true, evaluated: false },
  },
  {
    id: "gate-l1",
    kind: "gatepost",
    title: "gate L1",
    status: "done",
    layer: "L1",
    declared_layer: "L1",
    gate: { id: "gate-l1", command: "pb validate", passing: true, evaluated: false },
  },
];

/** Sample edges: the engine's own kinds only (dep | done | spawn | hil). */
const EDGES: FlowEdge[] = [
  { from: "start", to: "multi-loop-safety-carryover", kind: "dep", proven: true, evidence: "dep" },
  { from: "start", to: "plan-20260920-001", kind: "dep", proven: true, evidence: "dep" },
  { from: "multi-loop-safety-carryover", to: "plan-20260920-002", kind: "done", proven: true, evidence: "done" },
  { from: "plan-20260920-001", to: "plan-20260721-001", kind: "done", proven: true, evidence: "done" },
  { from: "plan-20260920-002", to: "plan-20261009-001", kind: "done", proven: true, evidence: "done" },
  { from: "plan-20260721-001", to: "plan-20260918-002", kind: "dep", proven: false, evidence: "dep" },
  { from: "plan-20260721-004", to: "plan-20260918-004", kind: "dep", proven: false, evidence: "dep" },
  { from: "plan-20261009-001", to: "goal", kind: "done", proven: true, evidence: "done" },
  {
    from: "orchestrator",
    to: "monitor-help-must-not-mutate",
    kind: "spawn",
    label: "spawn — discovered at runtime",
    proven: true,
    evidence: "spawn",
  },
  { from: "plan-20260918-002", to: "human", kind: "hil", label: "human gate", proven: true, evidence: "human" },
  { from: "plan-20260918-004", to: "human", kind: "hil", proven: true, evidence: "human" },
];

/**
 * The sample graph. `sample: true` is what keeps it honest: the room labels it and never claims it is this playbook.
 */
export const FLOW_SAMPLE_LAYERED: FlowGraph = {
  schema: "agent-playbook.graph.v1",
  sample: true,
  source: "sample · per-check exit codes, a fork and an unevaluated gate (not this repo)",
  start: {
    id: "start",
    loop: LOOP,
    loop_status: "active",
    phase: 42,
    goal: "Paint & approve the backlog-graph",
    stop: "design approved by the human; then PB graph projection + Flow room land green",
    mode: "coding",
    tasks_closed: "3/9 tasks",
    cron: {
      every: "every 30m",
      next_tick: "next tick in 12m",
      last_run: "last run 6m ago",
      runs: "runs pb loop run --auto",
      ticks: [0.31, 0.46, 0.62, 0.38, 0.54, 0.35, 0.5, 0.42],
    },
  },
  goal: {
    id: "goal",
    stop: "design approved by the human; then PB graph projection + Flow room land green",
    north_star:
      'Make "done" mean a verified exit code, not a claim — a portable loop an agent can carry into any repo.',
    conditions: [
      { text: "design approved by the human", met: null },
      { text: "graph projection has executable tests", met: null },
      { text: "Flow room green in app_design", met: null },
      { text: "merge-back gated by a checker verdict", met: null },
    ],
    conditions_evaluated: false,
    merge_back: { verdict: "pass", fork: "fork A" },
  },
  nodes: [...TASKS, ORCHESTRATOR, FORK_A, FORK_B, ...GATES],
  edges: EDGES,
  human: {
    batch: [
      {
        kind: "manual",
        gate: null,
        command: "npm publish dsh-agents-playbook@0.6.2",
        commands: ["npm publish dsh-agents-playbook@0.6.2"],
        tasks: ["plan-20260918-002"],
        task: "plan-20260918-002",
        title: "Publish dsh-agents-playbook@0.6.2 to npm",
        status: "blocked",
        reason: "the task declares manual: true — only a person can close it",
        note: "needs a valid token",
        evaluated: true,
      },
      {
        kind: "manual",
        gate: null,
        command: "npm whoami",
        commands: ["npm whoami"],
        tasks: ["plan-20260918-004"],
        task: "plan-20260918-004",
        title: "Publish v0.6.3 — needs a valid npm token",
        status: "blocked",
        reason: "the task declares manual: true — only a person can close it",
        note: "npm whoami → 401",
        evaluated: true,
      },
    ],
    // Declared, never executed: `pb plan --layers` names these gates, but only
    // `--check-gates` runs them. They are NOT live blockers.
    unevaluated_gates: [
      {
        kind: "gate",
        gate: "gate L0",
        command: "npm test",
        commands: ["npm test"],
        tasks: ["multi-loop-safety-carryover", "plan-20260920-001"],
        note: "declared · command not executed",
        evaluated: false,
      },
      {
        kind: "gate",
        gate: "gate L1",
        command: "pb validate",
        commands: ["pb validate"],
        tasks: ["plan-20260920-002", "plan-20260721-001"],
        note: "declared · command not executed",
        evaluated: false,
      },
    ],
    gates_checked: false,
    note: "sample: two declared human gates, collected into ONE hand-off",
  },
};
