// ─── Flow room — the projection the room draws ───
//
// This file is the SHAPE of `pb graph --json` (schema `agent-playbook.graph.v1`,
// DESIGN.md §4.1). It is deliberately the only vocabulary the Flow room knows:
// every fact a card, an edge, the inspector or the steering dock shows is a
// field on this object. If a fact is not here it is not drawn — the room never
// reads `backlog.yaml`, the filesystem, a worktree or the journal itself.
//
// The types are ENGINE-SHAPED, not fixture-shaped. The first version typed
// `checks` as a list of `{command, exit_code}` while the engine sends a COUNT
// plus the declared commands and one aggregate outcome:
//
//   checks: 2                                  ← how many the task declares
//   acceptance_checks: ["node …", "node …"]    ← the declared commands
//   gate_quality: "✓verified" | "⚠hollow"      ← a decorated string, not a union
//   journal[].checks: "passed" | "failed"      ← the aggregate outcome, per row
//
// Per-check EXIT CODES have no live source at all, so `checks_detail` is optional
// and only a payload that can prove each one may set it.
//
// What the room is allowed to compute (and nothing else):
//   · card positions              → lib/flow-layout.ts (dagre, left → right)
//   · tone / rail fill from status+checks → lib/flow-derive.ts (the honesty rules)
//   · zoom, pan, selection, animation     → component state, never persisted
//
// PB owns truth; Wenmei is the surface. See docs/wenmei-pb-integration-contract.md.

/** The projection schema this room renders. A different string is refused. */
export const FLOW_SCHEMA = "agent-playbook.graph.v1";

/** The engine's task states. `done` is an exit code, not a claim. */
export type FlowStatus = "todo" | "in_progress" | "blocked" | "done";

/** The aggregate outcome of the checks a journal row recorded. */
export type FlowChecksOutcome = "passed" | "failed" | "skipped" | null;

export type FlowCheckerVerdict = "pass" | "risk" | "block" | "none";

/** PB's loop steps. The card rail has exactly one segment per step. */
export const FLOW_CYCLE_STEPS = [
  "orient",
  "select",
  "act",
  "verify",
  "record",
  "report",
] as const;

export type FlowCycleStep = (typeof FLOW_CYCLE_STEPS)[number];

/**
 * What a node is. The ENGINE omits this for plain tasks, so it is optional: the
 * adapter defaults it to `task` and derives `fork` from a worker record.
 */
export type FlowNodeKind =
  | "task"
  | "start"
  | "goal"
  | "orchestrator"
  | "fork"
  | "batch"
  | "gatepost";

/** One journal row, as projected. The rail and the steering thread read these. */
export interface FlowJournalRow {
  /** Engine timestamp field (`ts`); `at` is accepted for older payloads. */
  ts?: string;
  at?: string;
  seq?: number;
  action: string;
  agent: string;
  /** The row's text. PB's field is `notes` (the design example said `text`). */
  notes: string;
  /**
   * The aggregate this row recorded. `"none"` is what a claim row carries (no run
   * happened), so it is not an outcome the rail may read as green.
   */
  checks?: "passed" | "failed" | "skipped" | "none" | null;
  /**
   * The row's own status. Checker rows carry `pass` / `block`, which are not
   * task states, so this is the engine's vocabulary rather than `FlowStatus`.
   */
  status?: FlowStatus | "pass" | "risk" | "block" | "info" | null;
  loop_id?: string;
  /** The engine has sent a string here in older rows and an array in newer ones. */
  files?: string[] | string;
  /** The remaining fields the engine stamps on a row; carried, never invented. */
  task?: string;
  agent_id?: string;
  agent_chain?: string[] | string;
  claimed_by?: string | null;
  mode?: string;
  ownership?: string;
  result?: string | null;
  check_cwd?: string;
  origin_agent?: string;
  origin_agent_id?: string;
  origin_runtime?: string | null;
  origin_session_id?: string | null;
}

/**
 * A single acceptance check WITH its exit code. Only a payload that can prove an
 * individual result may set this: the live projection cannot, so the inspector
 * falls back to the declared commands + the aggregate outcome.
 */
export interface FlowCheckDetail {
  command: string;
  exit_code: number;
  passed: boolean;
}

export interface FlowClaim {
  by: string | null;
  seq: number | null;
  loop_id?: string | null;
}

export interface FlowChecker {
  verdict: string;
  notes?: string | null;
  recorded_at?: string | null;
  agent?: string | null;
}

export interface FlowWorker {
  branch: string;
  /** The worker record's own lifecycle state, when PB has one. */
  status?: string;
  ahead?: number;
  uncommitted?: number;
  merge_ready: boolean;
  /** Set once a merge-back actually happened — proof, not a claim. */
  merged_at?: string | null;
  merge_commit?: string | null;
  /** The rest of PB's worker record, carried verbatim. */
  agent?: string | null;
  worktree_path?: string | null;
  base_branch?: string | null;
  base_commit?: string | null;
  head_commit?: string | null;
  created_at?: string | null;
}

/** Why a card exists — the counter-measure to an adopted-loop accident. */
export interface FlowProvenance {
  spawned_by?: string;
  origin?: string;
  correction?: string;
  recorded_by?: string;
}

export interface FlowStopCondition {
  text: string;
  /**
   * `true` only when something executable backs the clause (a check that ran).
   * `null` means the stop condition is prose PB cannot evaluate — the card must
   * render it as an OPEN clause, never as a tick. `pb graph` emits `null` today.
   */
  met: boolean | null;
}

/** A tick is PB evidence, not a Wenmei invention: the host owns cadence. */
export interface FlowCron {
  every: string;
  next_tick: string;
  last_run: string;
  runs: string;
  /** Last N runs as relative heights (bars), 0..1 — from `pb loop run` rows. */
  ticks: number[];
}

/** The engine's own cycle projection (one row per step, plus the filled ones). */
export interface FlowCycleProjection {
  /** `null` when the task's journal proves no step yet. */
  step: string | null;
  index: number | null;
  steps?: string[];
  filled?: string[];
}

export interface FlowNode {
  id: string;
  /** Optional: the engine omits it for tasks; the adapter defaults it. */
  kind?: FlowNodeKind;
  title: string;
  status: FlowStatus;
  /**
   * PB's own derived layering — the horizontal axis of the room. Everything is
   * `L1` when the playbook declares no layers, which is why the room draws ONE
   * column and says "no layers declared — flat view".
   */
  layer: string;
  /** PB's declared layer, when the task declares one (`null` otherwise). */
  declared_layer?: string | null;
  /** PB's derived depth (number), when the engine sends it. */
  derived_layer?: number | null;
  priority?: number;
  skill?: string;
  mode?: string;
  /** How many acceptance checks the task declares (the engine sends a COUNT). */
  checks?: number;
  /** The declared commands — the engine sends these. */
  acceptance_checks?: string[];
  /** Per-check results: only a payload that can prove each one sets this. */
  checks_detail?: FlowCheckDetail[];
  /** The aggregate outcome of the last recorded run. */
  checks_outcome?: FlowChecksOutcome;
  /** `pb validate`'s wrapper as the engine sends it (`"✓verified"`, `"⚠hollow"`). */
  gate_quality?: string;
  /** A human decision is required (`manual: true` in the backlog). */
  manual?: boolean;
  claim?: FlowClaim | null;
  checker?: FlowChecker | null;
  worker?: FlowWorker | null;
  merge_ready?: boolean;
  /** PB's own reason list for why a merge is or is not allowed. */
  merge_reasons?: string[];
  /** PB's own warnings for this node (hollow gate, no worktree, drift). */
  merge_warnings?: string[];
  /** The engine's cycle projection; the rail prefers journal-derived evidence. */
  cycle?: FlowCycleProjection;
  /** Playbook paths attached to the task (`docs:` on the backlog task). */
  docs?: string[];
  journal?: FlowJournalRow[];
  provenance?: FlowProvenance;
  /** Fork experiments: the worker's own progress, derived engine-side. */
  progress?: number;
  /** Bookend / orchestrator / batch copy — projection text, not UI composition. */
  body?: string;
  /** The playbook's North Star, shown on the end-goal card when the payload has it. */
  north_star?: string;
  metrics?: { spawns?: number; forks?: number; hil?: number; rounds?: number };
  stoplist?: FlowStopCondition[];
  cron?: FlowCron;
  /** Human-readable claim age, formatted engine-side ("12m"). */
  elapsed?: string;
  /** Gate-post label. `evaluated` is false for a declared-but-unexecuted gate. */
  gate?: { id: string; command: string; passing: boolean; evaluated?: boolean };
  /** The engine stamps every node it projects. */
  updated_at?: string | null;
}

/**
 * The five edge kinds of DESIGN §2.2, plus `idle` (a declared dependency that
 * has not started) — every one earns its own dash pattern in `flow.css`. A
 * relation the engine cannot prove is drawn dashed; only proof is solid.
 */
export type FlowEdgeKind = "dep" | "done" | "spawn" | "fork" | "merge" | "hil" | "idle";

/** What proves an edge. `claim` is the only unproven one — it renders dashed. */
export type FlowEdgeEvidence =
  | "dep"
  | "done"
  | "spawn"
  | "claim"
  | "worker"
  | "merge-ready"
  | "merge-verdict"
  | "human";

export interface FlowEdge {
  from: string;
  to: string;
  kind: FlowEdgeKind;
  label?: string;
  /** true when the engine proved the relation (fork record, merge gate exit 0). */
  proven?: boolean;
  /** The row/record that proves (or fails to prove) this edge. */
  evidence?: FlowEdgeEvidence;
  /** The claiming agent/row, as the engine sends it. */
  by?: string | null;
  seq?: number | null;
  loop?: string | null;
  reason?: string | null;
  origin_runtime?: string | null;
  /** True when the ADAPTER derived this edge rather than the engine emitting it. */
  derived?: boolean;
}

/**
 * One human hand-off. Several blocked tasks feed ONE batch (D7 / frame 1).
 * `evaluated: false` marks a gate that is declared but whose command has not
 * run — it is NOT a live blocker and must not be painted as one.
 */
export interface FlowHumanBatch {
  /** `manual` for a `manual: true` task; `gate` for a declared layer gate. */
  kind?: "manual" | "gate" | string;
  gate?: string | null;
  command: string;
  commands?: string[];
  tasks: string[];
  /** The single task this entry came from, when there is one. */
  task?: string;
  title?: string;
  status?: FlowStatus;
  /** The engine's own explanation of why this is a question for a person. */
  reason?: string;
  /** Short reason shown on the batch card ("needs a valid token"). */
  note?: string;
  evaluated?: boolean;
}

export interface FlowStart {
  id?: string;
  loop: string;
  loop_status?: string;
  started_at?: string;
  phase: number;
  goal: string;
  stop: string;
  mode: string;
  /** e.g. `3/9 tasks` — the loop's own progress, projection-side. */
  tasks_closed?: string;
  /**
   * The host's cadence chip (Wenmei owns the schedule; PB records the runs). It is
   * optional and absent from `pb graph --json`, so the live room shows no cron box
   * rather than inventing one.
   */
  cron?: FlowCron;
}

export interface FlowGoal {
  id?: string;
  /** The cycle brief's `stop`, verbatim. */
  stop: string;
  north_star?: string;
  conditions: FlowStopCondition[];
  /** True when PB actually evaluated the conditions (`pb graph` sends false). */
  conditions_evaluated?: boolean;
  merge_back?: { verdict: string; fork: string };
}

/** Frame 3: a live goal change, as it lands back on the end-goal card. */
export interface FlowGoalDiff {
  old: string;
  new: string;
  when: string;
  from: string;
}

export interface FlowGraph {
  schema: string;
  start: FlowStart;
  goal: FlowGoal;
  nodes: FlowNode[];
  edges: FlowEdge[];
  human: {
    id?: string;
    /** Provable human work: tasks with `manual: true` (one hand-off answers all). */
    batch: FlowHumanBatch[];
    /** Declared gates whose command has NOT been executed — not blockers. */
    unevaluated_gates?: FlowHumanBatch[];
    gates_checked?: boolean;
    note?: string;
  };
  goal_diff?: FlowGoalDiff;
  /**
   * True for a hand-built SAMPLE (the painted frame's layered playbook). The room
   * labels it as such: only the live snapshot or `pb graph --json` is this repo.
   */
  sample?: boolean;
  /** Where the payload came from — shown in the room's source chip. */
  source?: string;
}
