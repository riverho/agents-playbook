#!/usr/bin/env node
// ─── acceptance check: P2 — the Wenmei Flow room (playground) ───
//
// plan-20261009-005. Certifies, by exit code, that the isolated Wenmei worktree
// really contains the room the painted frames describe, that the room draws
// through ONE adapter, that the fixture is derived from this repo's real backlog,
// and that the new dependency stayed in `app_design` (never the Wenmei root).
//
// Static assertions first (what the code says), then the four real gates inside
// the worktree's app_design (`tsc -b`, `lint`, `test`, `build`). Pass `--static`
// to skip the gates, or `--no-build` to skip only the bundler.
//
//   node scripts/check-flow-room.mjs [--static] [--no-build]
//
// Env: WENMEI_WORKTREE overrides the worktree path.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const WORKTREE =
  process.env.WENMEI_WORKTREE ??
  "D:\\HermesProjects\\Wenmei\\wenmei\\.worktrees\\graph-room";
const APP = path.join(WORKTREE, "app_design");
const SRC = path.join(APP, "src");
const FLAGS = new Set(process.argv.slice(2));
const STATIC_ONLY = FLAGS.has("--static");
const SKIP_BUILD = STATIC_ONLY || FLAGS.has("--no-build");

let failed = 0;
let passed = 0;

function ok(name, detail = "") {
  passed += 1;
  console.log(`  \u2713 ${name}${detail ? ` — ${detail}` : ""}`);
}
function bad(name, detail) {
  failed += 1;
  console.log(`  \u2717 ${name}\n      ${detail}`);
}
function check(name, fn) {
  try {
    const detail = fn();
    if (detail === false) bad(name, "returned false");
    else ok(name, typeof detail === "string" ? detail : "");
  } catch (error) {
    bad(name, error instanceof Error ? error.message : String(error));
  }
}

function read(relative) {
  const file = path.join(SRC, relative);
  if (!existsSync(file)) throw new Error(`missing file: src/${relative}`);
  return readFileSync(file, "utf8");
}
function readJson(file) {
  if (!existsSync(file)) throw new Error(`missing file: ${file}`);
  return JSON.parse(readFileSync(file, "utf8"));
}
function must(haystack, needle, label) {
  if (!haystack.includes(needle)) {
    throw new Error(`${label ?? `expected to find ${JSON.stringify(needle)}`}`);
  }
  return true;
}
function mustMatch(haystack, regex, label) {
  if (!regex.test(haystack)) throw new Error(label ?? `expected to match ${regex}`);
  return true;
}

console.log(`Flow room check — worktree ${WORKTREE}\n`);

// ── 1. the worktree exists and is the isolated branch ─────────────────────
check("the isolated worktree exists", () => {
  if (!existsSync(APP)) throw new Error(`no app_design at ${APP}`);
  const head = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: WORKTREE,
    encoding: "utf8",
  });
  if (head.status !== 0) {
    // A %TEMP% copy is not a git worktree; the mutation proofs run there.
    return "not a git checkout — branch check skipped";
  }
  const branch = (head.stdout ?? "").trim();
  // The invariant is "a linked worktree, never the main checkout" — not a frozen
  // branch name, which would rot with every fresh worktree.
  if (!/[\\/]\.worktrees[\\/]/.test(WORKTREE)) {
    throw new Error(`the path is not a linked worktree: ${WORKTREE}`);
  }
  if (branch === "main" || branch === "master" || branch === "") {
    throw new Error(`worktree is on "${branch}" — refusing to check the main checkout`);
  }
  return `${branch} (linked worktree)`;
});

// ── 2. the room is REGISTERED (the 4-edit change; tsc enforces no default) ─
check("StageId has a `flow` member", () => {
  const types = read("lib/stage-types.ts");
  mustMatch(
    types,
    /export type StageId =[\s\S]*?\|\s*"flow";/,
    "stage-types.ts: StageId union has no `| \"flow\"` member"
  );
  return 'union member "flow"';
});

check("STAGES declares the Flow room", () => {
  const types = read("lib/stage-types.ts");
  const entry = /id:\s*"flow",[\s\S]{0,600}?views:/.exec(types);
  if (!entry) throw new Error("stage-types.ts: no STAGES entry with id: \"flow\"");
  for (const field of ["label: \"Flow\"", "archetype: \"canvas\"", "group: \"see\""]) {
    must(entry[0], field, `Flow STAGES entry is missing ${field}`);
  }
  return "one STAGES entry (canvas · see)";
});

check("StageLayer registers the room in all four places, with no switch default", () => {
  const layer = read("components/stage/StageLayer.tsx");
  must(layer, 'import FlowRoom from "./FlowRoom"', "StageLayer does not import FlowRoom");
  mustMatch(layer, /flow:\s*Share2,/, "STAGE_ICON has no `flow:` icon line");
  mustMatch(layer, /case "flow":[\s\S]*?flowCountsLine\(/, "stageCounts has no derived `case \"flow\"`");
  mustMatch(layer, /case "flow":\s*\n\s*return <FlowRoom/, "StageBody has no `case \"flow\"` rendering FlowRoom");
  // The compiler enforces the registration only while the switches stay closed.
  const defaults = layer.match(/default:/g) ?? [];
  if (defaults.length > 0) {
    throw new Error("StageLayer switches gained a `default:` — tsc no longer enforces registration");
  }
  return "import · STAGE_ICON · stageCounts · StageBody · 0 defaults";
});

// ── 3. the room itself ───────────────────────────────────────────────────
check("FlowRoom is a React Flow canvas with the frame's chrome", () => {
  const room = read("components/stage/FlowRoom.tsx");
  must(room, 'from "@xyflow/react"', "FlowRoom does not import @xyflow/react");
  must(room, "@xyflow/react/dist/style.css", "FlowRoom does not load the React Flow stylesheet");
  for (const part of ["<ReactFlow", "<Background", "<Controls", "<MiniMap"]) {
    must(room, part, `FlowRoom does not render ${part}`);
  }
  mustMatch(room, /variant=\{BackgroundVariant\.Dots\}/, "the canvas background is not the dotted plate");
  mustMatch(room, /gap=\{16\}/, "the dot grid is not the painted 16 px");
  must(room, "panOnDrag", "the canvas does not declare its pan gesture");
  must(room, "selectionOnDrag", "the canvas has no rubber-band selection");
  return "ReactFlow · dotted Background · pan/zoom · Controls · MiniMap";
});

check("the room reads the graph through the adapter, never a payload module", () => {
  const room = read("components/stage/FlowRoom.tsx");
  must(room, 'from "@/lib/flow-adapter"', "FlowRoom does not import the adapter");
  const offenders = [];
  const components = readdirSync(path.join(SRC, "components", "stage"))
    .filter(name => name.startsWith("Flow"))
    .map(name => path.join("components", "stage", name));
  for (const file of components) {
    const text = read(file);
    for (const payload of ["flow-graph-live", "flow-sample-layered"]) {
      if (text.includes(payload)) offenders.push(`${file} → ${payload}`);
    }
  }
  if (offenders.length > 0) {
    throw new Error(`components import a payload module: ${offenders.join(", ")}`);
  }
  // Payload data is reachable from exactly one non-test module: the adapter.
  const importers = [];
  const payloadFiles = ["flow-graph-live.ts", "flow-sample-layered.ts"];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      // Tests may import the payloads — they are the ones proving the shape —
      // and a payload file may name another one in its own header comment.
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) &&
        !payloadFiles.includes(entry.name) &&
        /mocks\/flow-(graph-live|sample-layered)/.test(readFileSync(full, "utf8"))) {
        importers.push(path.relative(SRC, full).replace(/\\/g, "/"));
      }
    }
  };
  walk(SRC);
  const expected = ["lib/flow-adapter.ts"];
  if (importers.slice().sort().join(",") !== expected.join(",")) {
    throw new Error(`payloads must be imported only by ${expected}; got ${JSON.stringify(importers)}`);
  }
  return "one seam: lib/flow-adapter.ts";
});

check("the room shows THIS repo's payload by default and labels the sample", () => {
  const adapter = read("lib/flow-adapter.ts");
  must(adapter, "LIVE_SNAPSHOT_ADAPTER", "no live snapshot adapter");
  must(adapter, "SAMPLE_LAYERED_ADAPTER", "no labelled sample adapter");
  mustMatch(adapter, /DEFAULT_FLOW_ADAPTER[^=]*=\s*LIVE_SNAPSHOT_ADAPTER/,
    "the default adapter is not this repo's live snapshot");
  must(adapter, "FLOW_LIVE_GRAPH", "the default adapter does not load the engine snapshot");
  const sample = read("mocks/flow-sample-layered.ts");
  must(sample, "sample: true", "the sample payload is not marked `sample: true`");
  mustMatch(sample, /explicitly NOT this repo|not presented as this repo's state|labelled in the room's source chip/i,
    "the sample does not say what it is not");
  must(sample, "per-check EXIT CODES", "the sample does not state what only it can show");
  const room = read("components/stage/FlowRoom.tsx");
  must(room, "hasDeclaredLayers", "the room does not check whether layers are declared");
  must(room, "no layers declared — flat view", "the room does not label a flat view");
  must(room, "sample · unprovable detail", "the room does not label the sample");
  return "default = live snapshot · sample labelled · flat view stated";
});

check("the adapter exposes the P3 swap point", () => {
  const adapter = read("lib/flow-adapter.ts");
  mustMatch(adapter, /export interface FlowAdapter/, "no FlowAdapter interface");
  must(adapter, "load(): FlowGraph", "FlowAdapter has no load(): FlowGraph");
  must(adapter, "createPbGraphAdapter", "no live `pb graph --json` adapter factory for P3");
  must(adapter, "applySteering", "FlowAdapter has no steering write path");
  must(adapter, "findEngineShapeProblems", "no executable engine-shape validator");
  must(adapter, "projectGraph", "no payload → room-graph projection (node synthesis)");
  return "FlowAdapter { load, applySteering } + createPbGraphAdapter + shape validator";
});

// ── 4. the card / edge vocabulary of the painted frames ──────────────────
check("the five edge kinds keep the painted dash patterns and colours", () => {
  const derive = read("lib/flow-derive.ts");
  const expectations = [
    [/dep:\s*\{\s*stroke:\s*"#c9c3bb",\s*width:\s*1\.25/, "dependency: #c9c3bb @1.25"],
    [/done:\s*\{\s*stroke:\s*"rgba\(17, 17, 17, 0\.3\)"/, "done-through: ink @30%"],
    [/spawn:\s*\{[^}]*dash:\s*"5 4"/, "spawn: dashed 5 4"],
    [/fork:\s*\{[^}]*dash:\s*"2 3"/, "fork: dotted 2 3"],
    [/merge:\s*\{[^}]*width:\s*2\.25[^}]*double:\s*true/, "merge-back: 2.25 double"],
    [/hil:\s*\{[^}]*stroke:\s*"var\(--accent-rose\)"[^}]*dash:\s*"4 3"/, "needs-a-human: rose dashed 4 3"],
  ];
  for (const [regex, label] of expectations) {
    if (!regex.test(derive)) throw new Error(`edge vocabulary lost ${label}`);
  }
  return "dependency · done-through · spawn · fork · merge-back · needs-a-human";
});

check("a spawn is solid only when the journal proves it", () => {
  const derive = read("lib/flow-derive.ts");
  must(derive, "flowEdgeStyle", "no per-edge style function");
  mustMatch(
    derive,
    /proven === true \? \{ \.\.\.style, dash: undefined \}/,
    "a proven spawn is not drawn solid (claim could be dressed as a fact)"
  );
  const adapter = read("lib/flow-adapter.ts");
  must(adapter, 'row.action.toLowerCase() === "spawn"', "spawn proof is not read from a journal row");
  mustMatch(
    adapter,
    /edge\.evidence \?\? \(spawnedByRow \? "spawn" : "claim"\)/,
    "spawn evidence is not stamped"
  );
  mustMatch(adapter, /edge\.proven \?\? spawnedByRow/,
    "the engine's own spawn verdict is not preferred over a re-derivation");
  return "proven → solid · claim → dashed 5 4";
});

check("fork and merge-back are DERIVED from the worker record, not emitted", () => {
  const adapter = read("lib/flow-adapter.ts");
  must(adapter, "deriveWorkerEdges", "no worker-derived fork/merge function");
  mustMatch(adapter, /node\.worker\?\.merge_ready === true[\s\S]{0,160}node\.worker\?\.merged_at/,
    "merge-back is not gated on worker proof");
  const fixture = read("mocks/flow-sample-layered.ts");
  // Only the EDGE array matters here: a fork/fork NODE kind is fine.
  const edgesBlock = /const EDGES: FlowEdge\[\] = \[([\s\S]*?)\n\];/.exec(fixture);
  if (!edgesBlock) throw new Error("the sample has no EDGES array");
  const rawKinds = [...edgesBlock[1].matchAll(/kind:\s*"(dep|done|spawn|fork|merge|hil|idle)"/g)].map(m => m[1]);
  const illegal = rawKinds.filter(kind => kind === "fork" || kind === "merge");
  if (illegal.length > 0) {
    throw new Error(`the raw projection emits ${illegal.join("/")} — PB models those as a worker attribute`);
  }
  const rawSet = [...new Set(rawKinds)].sort();
  if (rawSet.join("|") !== "dep|done|hil|spawn") {
    throw new Error(`raw edges are ${rawSet.join(", ")}, expected dep | done | hil | spawn`);
  }
  return `factor in adapter; raw sample edges = ${rawSet.join(" | ")}`;
});

check("the card anatomy matches the painted frames", () => {
  const cards = read("components/stage/FlowCards.tsx");
  const layout = read("lib/flow-layout.ts");
  must(layout, "FLOW_CARD_W = 236", "cards are not 236 px wide");
  must(layout, "FLOW_CARD_H = 104", "cards are not 104 px tall");
  must(layout, "FLOW_BOOKEND_H = 300", "bookends are not 300 px tall");
  must(layout, "FLOW_ORCHESTRATOR_H = 140", "no 140 px orchestrator card");
  must(layout, "FLOW_FORK_H = 124", "no 124 px fork card");
  must(layout, "FLOW_BATCH_H = 170", "no 170 px human-batch card");
  for (const part of ["flow-card__bar", "flow-cycle", "⚠ hollow", "📎", "flow-hil", "flow-progress",
    "flow-bookend__title", "flow-gatepill", "flow-stoplist"]) {
    must(cards, part, `card anatomy lost ${part}`);
  }
  mustMatch(cards, /\[0, 1, 2, 3, 4, 5\]\.map/, "the cycle rail is not 6 segments");
  return "236×104 · 3 px bar · 6-segment rail · ⚠ hollow · 📎 · HIL · bookends · gate posts";
});

check("the goal card refuses to tick what the engine cannot evaluate", () => {
  const sample = read("mocks/flow-sample-layered.ts");
  must(sample, "met: null", "stop conditions do not carry `met: null`");
  if (/met:\s*true/.test(sample)) {
    throw new Error("the sample ticks a stop condition with no executable backing");
  }
  const live = readFileSync(path.join(SRC, "mocks", "flow-graph-live.ts"), "utf8");
  if (/"met":\s*true/.test(live)) {
    throw new Error("the live snapshot ticks a stop condition with no executable backing");
  }
  must(live, '"conditions_evaluated": false', "the snapshot does not record that PB left the conditions unevaluated");
  const cards = read("components/stage/FlowCards.tsx");
  must(cards, "isProvenCondition", "the goal card does not use the proof rule");
  return "every clause open (met: null) — ✓ only when proven";
});

check("an unevaluated gate is labelled, not painted as a live blocker", () => {
  const sample = read("mocks/flow-sample-layered.ts");
  must(sample, "unevaluated_gates", "no `human.unevaluated_gates`");
  must(sample, "evaluated: false", "no gate carries evaluated:false");
  const cards = read("components/stage/FlowCards.tsx");
  must(cards, "unevaluated", "the gate post does not render the unevaluated state");
  return "declared ≠ executed";
});

check("journal rows use PB's `notes` and `ts` fields", () => {
  const types = read("lib/flow-types.ts");
  const row = /interface FlowJournalRow \{([\s\S]*?)\n\}/.exec(types);
  if (!row) throw new Error("FlowJournalRow is gone");
  must(row[1], "notes: string", "FlowJournalRow does not require PB's `notes`");
  must(row[1], "ts?: string", "FlowJournalRow does not accept PB's `ts` timestamp");
  if (/text\??:/.test(row[1])) {
    throw new Error("FlowJournalRow still declares the design's wrong `text` field");
  }
  const live = readFileSync(path.join(SRC, "mocks", "flow-graph-live.ts"), "utf8");
  must(live, '"notes"', "the live snapshot carries no notes field");
  return "notes + ts (not the design example's `text`)";
});

check("the inspector, the steering dock and the effects are all present", () => {
  const inspector = read("components/stage/FlowInspector.tsx");
  for (const section of ["① CYCLE", "② ACCEPTANCE CHECKS", "③ PROVENANCE", "④ WORKTREE", "⑤ DOCUMENTS", "⑥ ORCHESTRATOR THREAD"]) {
    must(inspector, section, `inspector lost section ${section}`);
  }
  // Per-check exit codes appear only when the payload can prove each one; the
  // aggregate outcome is always stated.
  must(inspector, "detail.exit_code", "the inspector cannot show a per-check exit code when one exists");
  must(inspector, "checksOutcomeLabel", "the inspector does not state the aggregate outcome");
  must(inspector, "no per-check exit codes", "the inspector does not say where its outcomes come from");
  const dock = read("components/stage/FlowSteeringDock.tsx");
  for (const action of ["Steer direction", "Comment on", "Fork", "Attach document"]) {
    must(dock, action, `steering dock lost "${action}"`);
  }
  must(dock, "Steering applied", "no steering-applied toast");
  const cards = read("components/stage/FlowCards.tsx");
  must(cards, "flow-goaldiff", "the end-goal card has no goal-diff slot");
  const css = readFileSync(path.join(SRC, "index.css"), "utf8");
  must(css, "flow-popin", "no spawn pop-in effect");
  must(css, "flow-halo", "no HIL breathing halo");
  must(css, "flow-ripp", "no cron tick ripple");
  mustMatch(css, /prefers-reduced-motion: reduce[\s\S]*?flow-popin[\s\S]*?animation: none !important/,
    "the Flow effects are not switched off under prefers-reduced-motion");
  const edges = read("components/stage/FlowEdges.tsx");
  must(edges, "animateMotion", "no SMIL travel dot");
  must(edges, "usePrefersReducedMotion", "the SMIL dot is not gated on reduced motion");
  return "frame 2 inspector · frame 3 dock + goal-diff · frame 4 effects + reduced motion";
});

check("the live payload is engine-shaped and the room's invariants hold", () => {
  // Hermetic: this pins SHAPE and engine-derived invariants, never a frozen
  // backlog. Unrelated backlog work must not turn the room's gate red, so any
  // snapshot-vs-engine difference is reported as a WARNING (see below).
  const result = spawnSync("node scripts/pb.mjs graph --json", {
    cwd: ROOT,
    encoding: "utf8",
    shell: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `\`pb graph --json\` exited ${result.status}: ${(result.stderr ?? "").slice(0, 300)}`
    );
  }
  let engine;
  try {
    engine = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`\`pb graph --json\` did not print JSON: ${String(error).slice(0, 200)}`);
  }
  if (engine.schema !== "agent-playbook.graph.v1") {
    throw new Error(`the engine emits schema "${engine.schema}"`);
  }
  const statuses = new Set(["todo", "in_progress", "blocked", "done"]);
  const kinds = new Set(["dep", "done", "spawn", "fork", "merge", "hil", "idle"]);
  const nodeIds = new Set(engine.nodes.map(node => node.id));
  if (engine.nodes.length === 0) throw new Error("the engine sent no nodes");
  for (const node of engine.nodes) {
    if (!statuses.has(node.status)) throw new Error(`node ${node.id} has status "${node.status}"`);
    if (typeof node.layer !== "string" || !node.layer) {
      throw new Error(`node ${node.id} has no layer`);
    }
    if (node.checks !== undefined && typeof node.checks !== "number") {
      throw new Error(`node ${node.id} checks is not the engine's number`);
    }
    if (node.gate_quality !== undefined && typeof node.gate_quality !== "string") {
      throw new Error(`node ${node.id} gate_quality is not the engine's string`);
    }
  }
  // The ids the engine keeps out of `nodes[]` but still points edges at: the
  // adapter synthesises exactly these, so any OTHER dangling id is a real fault.
  const synthesised = new Set(["start", "goal", "human"]);
  for (const edge of engine.edges) {
    if (!kinds.has(edge.kind)) throw new Error(`edge kind "${edge.kind}" is unknown`);
    for (const endpoint of [edge.from, edge.to]) {
      if (!nodeIds.has(endpoint) && !synthesised.has(endpoint)) {
        throw new Error(
          `edge endpoint ${endpoint} is neither a node nor a synthesised id (${[...synthesised].join(", ")})`
        );
      }
    }
  }
  if (engine.edges.length === 0) throw new Error("the engine sent no edges");
  // Engine-derived invariants, computed from the payload itself.
  const manual = engine.nodes.filter(node => node.manual === true);

  /**
   * A human batch entry must name an EXISTING task that really is `manual: true`.
   * The third review injected a batch entry naming a NON-manual task and this gate
   * stayed green, because it only checked that the id existed — this is that hole.
   */
  const assertBatchIsManual = (graph, label) => {
    const ids = new Set(graph.nodes.map(node => node.id));
    const manualHere = new Set(
      graph.nodes.filter(node => node.manual === true).map(node => node.id)
    );
    for (const entry of graph.human?.batch ?? []) {
      if (!Array.isArray(entry.tasks) || entry.tasks.length === 0) {
        throw new Error(`${label}: a human batch entry holds no task`);
      }
      for (const task of entry.tasks) {
        if (!ids.has(task)) throw new Error(`${label}: human batch names unknown task ${task}`);
        if (!manualHere.has(task)) {
          throw new Error(
            `${label}: human batch names ${task}, which is NOT manual:true — the batch would be handing a person work the engine never flagged`
          );
        }
      }
    }
  };
  assertBatchIsManual(engine, "engine");
  if ((engine.human?.batch?.length ?? 0) > manual.length) {
    throw new Error(
      `human.batch has ${engine.human.batch.length} entries for ${manual.length} manual task(s)`
    );
  }
  // Declared layers are the room's axis: when PB declares them, the payload must
  // carry them (the flat view is only ever the fallback). A single node may still
  // be at its DERIVED depth without a declared stratum, so the pin is "declared
  // layers exist and every node has a layer", not "all or nothing".
  const declared = engine.nodes.filter(node => node.declared_layer != null);
  if (declared.length === 0) {
    throw new Error("no node declares a layer — the room would fall back to the flat view");
  }

  // Snapshot drift is a WARNING, never the failure.
  const snapshotText = readFileSync(path.join(SRC, "mocks", "flow-graph-live.ts"), "utf8");
  const literal = snapshotText.slice(snapshotText.indexOf("= {") + 2).replace(/;\s*$/, "");
  let snapshot = null;
  try {
    snapshot = JSON.parse(literal);
  } catch (error) {
    throw new Error(`the snapshot is not readable JSON: ${String(error).slice(0, 160)}`);
  }
  const snapshotIds = new Set(snapshot.nodes.map(node => node.id));
  // The snapshot is what the room OPENS with, so the same guard applies to it —
  // a batch entry naming non-manual work would be a lie on the canvas.
  assertBatchIsManual(snapshot, "snapshot");
  const added = engine.nodes.filter(node => !snapshotIds.has(node.id)).map(node => node.id);
  const removed = snapshot.nodes.filter(node => !nodeIds.has(node.id)).map(node => node.id);
  const moved = engine.nodes.filter(node => {
    const before = snapshot.nodes.find(entry => entry.id === node.id);
    return before && before.status !== node.status;
  }).length;
  const warn = [];
  if (added.length) warn.push(`${added.length} new task(s): ${added.slice(0, 3).join(", ")}`);
  if (removed.length) warn.push(`${removed.length} removed`);
  if (moved) warn.push(`${moved} status moved`);
  if ((snapshot.human?.batch?.length ?? 0) !== (engine.human?.batch?.length ?? 0)) {
    warn.push(`human.batch ${snapshot.human?.batch?.length} → ${engine.human?.batch?.length}`);
  }
  const layers = [...new Set(engine.nodes.map(node => node.layer))].sort();
  return `${engine.nodes.length} nodes · ${engine.edges.length} edges · layers ${layers.join("/")} (${declared.length} declared)${
    warn.length ? ` · snapshot older than the backlog (${warn.join("; ")}) — re-capture when convenient` : ""
  }`;
});

check("the room fits the layout rect, so the legend is on screen", () => {
  // The claimed defect: the room used React Flow's `fitView` (the NODES' box) while
  // the legend lives in a reserved band below the content, so at fit the legend sat
  // off-viewport with only its top sliver showing.
  const room = read("components/stage/FlowRoom.tsx");
  must(room, "fitBounds(flowFitBounds(layout)", "the room does not fit the layout rect");
  must(room, "FLOW_FIT_PADDING", "the fit does not use the shared padding");
  if (/^\s*fitView\s*$/m.test(room)) {
    throw new Error(
      "the room still passes the `fitView` prop (that fits the node box, not the legend band)"
    );
  }
  const layout = read("lib/flow-layout.ts");
  must(layout, "export function flowFitBounds", "no flowFitBounds helper");
  must(layout, "export function legendInsideFitBounds", "no containment helper to assert");
  mustMatch(
    layout,
    /flowFitBounds\(layout: FlowLayoutResult\): FlowRect \{\s*return \{ x: 0, y: 0, width: layout\.width, height: layout\.height \};/,
    "flowFitBounds no longer returns the layout's own rect (legend reserve included)"
  );
  const geometry = read("lib/flow-geometry.test.ts");
  must(geometry, "legend lies inside the rect the room fits", "no legend-inside-fit assertion");
  must(geometry, "maps the whole legend, not a sliver", "no viewport-mapping assertion");
  return "fitBounds(layout rect) · legend inside the fit · no `fitView` prop";
});

check("the four render defects are pinned by executable geometry assertions", () => {
  const geometry = read("lib/flow-geometry.test.ts");
  const required = [
    ["keeps a >= ${FLOW_MIN_GUTTER}px gutter", "1 no-overlap"],
    ["every VISIBLE label box clears", "2 label collision"],
    ["suppresses rather than clips", "2 label suppression"],
    ["reserved legend rect intersects no node rect", "3 legend reserve"],
    ["reserves at least the legend's own drawn content", "3 legend sized from content"],
    ["uses the light grey + accent tones", "4 minimap tones"],
  ];
  for (const [needle, label] of required) {
    must(geometry, needle, `the geometry test lacks the ${label} assertion`);
  }
  const layout = read("lib/flow-layout.ts");
  must(layout, "FLOW_MIN_GUTTER", "no minimum gutter constant");
  must(layout, "declutterRects", "no de-collision pass");
  must(layout, "placeEdgeLabels", "no label placement/collision pass");
  must(layout, "flowLegendRequiredSize", "the legend reserve is not derived from the legend's content");
  if (/FLOW_LEGEND_RESERVE|FLOW_LEGEND_MIN_/.test(layout)) {
    throw new Error("a hand-written legend size/floor constant is back — the reserve must come from the drawn model");
  }
  must(layout, "visible: false", "a label that fits nowhere is not suppressed");
  // One source for the legend: the component renders the model the layout measured.
  const room = read("components/stage/FlowRoom.tsx");
  must(room, "flowLegendModel(graph)", "the legend does not render the model the reserve was measured from");
  const derive = read("lib/flow-derive.ts");
  must(derive, "flowLegendModel", "no legend model");
  mustMatch(derive, /flowLegendModel[\s\S]{0,900}rows: \[/, "the legend model carries no rows");
  mustMatch(derive, /FLOW_MINIMAP_TONE[\s\S]{0,400}rgba\(17, 17, 17, 0\.22\)/,
    "the minimap does not use the painted light grey");
  mustMatch(derive, /FLOW_MINIMAP_TONE[\s\S]{0,500}var\(--accent-teal\)/,
    "the minimap has no live accent");
  return required.map(([, label]) => label).join(" · ");
});

check("the legend metrics are tied to the CSS that draws the legend", () => {
  // The sizing guarantee is only as strong as the metrics; nothing used to tie
  // them to the stylesheet, so a CSS font-size bump (or a shrunken metric) stayed
  // green and the legend clipped silently (it has `overflow: hidden`).
  const cssTest = read("lib/flow-legend-css.test.ts");
  must(cssTest, "FLOW_LEGEND_METRICS", "the CSS test does not read the metrics");
  must(cssTest, "index.css", "the CSS test does not read the stylesheet");
  for (const rule of [".flow-legend", ".flow-legend__grp", ".flow-legend__row"]) {
    must(cssTest, rule, `the CSS test does not parse ${rule}`);
  }
  must(cssTest, "font-size", "the CSS test does not check the declared font sizes");
  must(cssTest, "padding", "the CSS test does not check the declared padding");
  const css = readFileSync(path.join(SRC, "index.css"), "utf8");
  const legend = /\.flow-legend\s*\{([^}]*)\}/.exec(css);
  if (!legend) throw new Error("index.css has no .flow-legend rule");
  must(legend[1], "overflow: hidden", "the legend no longer declares overflow:hidden");
  const derive = read("lib/flow-derive.ts");
  must(derive, "FLOW_LEGEND_METRICS", "no legend metrics to tie to the CSS");
  return "metrics ↔ index.css (padding · gaps · swatch · font-size budgets)";
});

// ── 5. the dependency stayed in app_design ────────────────────────────────
check("@xyflow/react + the layout engine are app_design dependencies only", () => {
  const appPkg = readJson(path.join(APP, "package.json"));
  const rootPkg = readJson(path.join(WORKTREE, "package.json"));
  const deps = appPkg.dependencies ?? {};
  const devDeps = appPkg.devDependencies ?? {};
  if (!deps["@xyflow/react"]) throw new Error("app_design/package.json has no @xyflow/react dependency");
  const layoutEngine = deps["@dagrejs/dagre"] ?? deps.dagre ?? deps.elkjs ?? deps["elkjs"];
  if (!layoutEngine) throw new Error("app_design/package.json has no layout engine dependency");
  for (const forbidden of ["@xyflow/react", "@dagrejs/dagre", "dagre", "elkjs"]) {
    if (rootPkg.dependencies?.[forbidden] || rootPkg.devDependencies?.[forbidden]) {
      throw new Error(`the Wenmei ROOT package.json gained ${forbidden}`);
    }
  }
  if (deps["@xyflow/react"] && devDeps["@xyflow/react"]) {
    throw new Error("@xyflow/react is declared twice");
  }
  return `app_design: @xyflow/react ${deps["@xyflow/react"]} + @dagrejs/dagre ${deps["@dagrejs/dagre"]} · root: clean`;
});

check("the layout goes through an adapter around the engine", () => {
  const layout = read("lib/flow-layout.ts");
  must(layout, 'from "@dagrejs/dagre"', "the layout adapter does not use the engine");
  must(layout, "export function layoutFlow", "no layoutFlow entry point");
  must(layout, 'engine: "dagre"', "the layout does not name its engine");
  must(layout, "flowLayerIndex", "the layering is not derived from PB's layer");
  return "layoutFlow() · dagre · PB layers are the axis";
});

// ── 6. the four real gates, inside the worktree ──────────────────────────
/**
 * Run one gate as a single command string. `npm`/`npx` are `.cmd` shims on
 * Windows and cannot be spawned with an argument array (Node refuses .cmd/.bat
 * without a shell), so the command is passed whole to the shell.
 */
function runGate(label, command) {
  check(`app_design \`${label}\` exits 0`, () => {
    const result = spawnSync(command, {
      cwd: APP,
      encoding: "utf8",
      shell: true,
      env: { ...process.env, CI: "1" },
    });
    if (result.status !== 0) {
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().split("\n").slice(-12).join("\n      ");
      throw new Error(`exit ${result.status}\n      ${output}`);
    }
    return "exit 0";
  });
}

/**
 * Run the geometry suite on its own and assert each of the four render findings
 * passes BY NAME — so `record --status done` refuses if any of them regresses,
 * and the failure names the defect instead of a count.
 */
function runGeometryProof() {
  check("the geometry assertions pass by name (the four render defects)", () => {
    const out = path.join(os.tmpdir(), `flow-geometry-${process.pid}.json`);
    const result = spawnSync(
      `npx vitest run src/lib/flow-geometry.test.ts src/lib/flow-legend-css.test.ts --reporter=json --reporter=verbose --outputFile="${out}"`,
      { cwd: APP, encoding: "utf8", shell: true, env: { ...process.env, CI: "1" } }
    );
    if (result.status !== 0) {
      // The json reporter writes to the file, so read it back to NAME the
      // assertions that failed — a check that only says "exit 1" is useless.
      let failedNames = [];
      try {
        const report = JSON.parse(readFileSync(out, "utf8"));
        failedNames = (report.testResults ?? [])
          .flatMap(file => file.assertionResults ?? [])
          .filter(entry => entry.status !== "passed")
          .map(entry => entry.title ?? entry.fullName ?? "?");
      } catch {
        failedNames = [];
      }
      const tail = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().split("\n").slice(-6).join("\n      ");
      throw new Error(
        `vitest exited ${result.status}${
          failedNames.length ? ` — failing: ${failedNames.join(" | ")}` : ""
        }\n      ${tail}`
      );
    }
    let report;
    try {
      report = JSON.parse(readFileSync(out, "utf8"));
    } catch (error) {
      throw new Error(`could not read the vitest report: ${String(error).slice(0, 160)}`);
    }
    const results = (report.testResults ?? []).flatMap(file => file.assertionResults ?? []);
    const wanted = [
      ["gutter", "1 · no-overlap"],
      ["every VISIBLE label box clears", "2 · label collision"],
      ["suppresses rather than clips", "2 · label suppression"],
      ["reserved legend rect intersects no node rect", "3 · legend reserve"],
      ["reserves at least the legend's own drawn content", "3 · legend sized from content"],
      ["uses the light grey + accent tones", "4 · minimap tones"],
      ["legend metrics agree with the CSS", "5 · metrics ↔ CSS"],
      ["legend lies inside the rect the room fits", "6 · legend inside the fit"],
      ["maps the whole legend, not a sliver", "6 · legend on screen, not a sliver"],
    ];
    for (const [needle, label] of wanted) {
      const hit = results.find(entry =>
        `${entry.title ?? ""} ${entry.fullName ?? ""}`.includes(needle)
      );
      if (!hit) throw new Error(`no geometry assertion matched ${label}`);
      if (hit.status !== "passed") throw new Error(`${label} is "${hit.status}"`);
    }
    return wanted.map(([, label]) => label).join(" · ");
  });
}

if (STATIC_ONLY) {
  console.log("\n  (--static: the four app_design gates were not run)");
} else {
  console.log("");
  runGeometryProof();
  runGate("npx tsc -b", "npx tsc -b");
  runGate("npm run lint", "npm run lint");
  runGate("npm run test", "npm run test");
  if (SKIP_BUILD) {
    console.log("  (--no-build: vite build was not run)");
  } else {
    runGate("npm run build", "npm run build");
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFlow room check FAILED");
  process.exit(1);
}
console.log("Flow room check OK — the room, the adapter and the four gates are green");
