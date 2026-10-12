#!/usr/bin/env node
// scripts/pb-daily-monitor.mjs
// ----------------------------------------------------------------------------
// Mode-agnostic closed-loop monitoring orchestrator.
// Heartbeat -> activate a mode -> scaffold its backlog from the mode's own
// `scaffold` descriptor -> auto-run -> surface errors. Writes auto-logs for
// errors, self-reflections, and process/skill iteration proposals. Exits 0 only
// when every scaffolded task is done.
//
// The orchestrator hardcodes NO pack's shape. It reads `--mode <id>` (default
// the orchestrator's reference mode) and that mode's `scaffold` descriptor from
// the master's modes registry; the descriptor names the config file, the item
// array, the planning skill, and how each item maps to a task.
// ----------------------------------------------------------------------------

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import yaml from 'js-yaml';
import { readActiveLoop } from './lib/loop-lib.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PB = resolve(ROOT, 'scripts/pb.mjs');
const REPORTS_DIR = resolve(ROOT, 'artifacts/reports');
const ERRORS_LOG = resolve(REPORTS_DIR, 'orchestrator-errors.ndjson');
const REFLECTIONS_LOG = resolve(REPORTS_DIR, 'orchestrator-reflections.ndjson');
const ITERATIONS_LOG = resolve(REPORTS_DIR, 'orchestrator-iterations.ndjson');

// The reference monitor mode is declared in the master (playbook.yaml
// `default_monitor_mode`), NOT baked into the engine — falls back to default_mode,
// then the first registered mode. Override per-run with --mode.
const _bootMaster = loadMaster();
const DEFAULT_MONITOR_MODE =
  (typeof _bootMaster.default_monitor_mode === 'string' && _bootMaster.default_monitor_mode.trim())
    ? _bootMaster.default_monitor_mode.trim()
    : (typeof _bootMaster.default_mode === 'string' && _bootMaster.default_mode.trim())
      ? _bootMaster.default_mode.trim()
      : Object.keys(_bootMaster.modes || {})[0];

const USAGE = `Usage: node scripts/pb-daily-monitor.mjs [--mode <id>] [--config <file>] [--project <id>] [--window <w>]
                                       [--input <dir>] [--output <dir>] [--dry-run] [--reset-cycle] [--adopt-loop]

One monitoring iteration: open (or reuse) the monitor's loop, scaffold the mode's backlog,
auto-run it and surface errors. It WRITES (backlog, journal, loops, reports) unless --dry-run.

  --adopt-loop   run inside an active loop the monitor did not open (pb-flow passes this
                 for its own flow loop). Without it, an unrelated active loop is refused.
  --help, -h     print this and exit; nothing is read or written.`;

// Every flag is known, or the run is refused BEFORE anything is read or written: a
// --help that ran a real iteration wrote a false `done` into an unrelated loop once.
function parseArgs(argv) {
  const args = { mode: DEFAULT_MONITOR_MODE, project: null, window: null, config: null, input: null, output: null, dryRun: false, resetCycle: false, adoptLoop: false, help: false };
  const VALUED = { '--mode': 'mode', '--project': 'project', '--window': 'window', '--config': 'config',
    '--input': 'input',    // flow handoff: read scaffold from a prior step's output dir
    '--output': 'output' }; // flow handoff: write this step's output for the next step
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a in VALUED) {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) return { error: `${a} needs a value` };
      args[VALUED[a]] = v;
    }
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--reset-cycle') args.resetCycle = true;
    else if (a === '--adopt-loop') args.adoptLoop = true;
    else return { error: `unknown argument: ${a}` };
  }
  return args;
}

const args = parseArgs(process.argv);
if (args.help) { console.log(USAGE); process.exit(0); }
if (args.error) { console.error(`pb-daily-monitor: ${args.error}. Nothing was run or written.

${USAGE}`); process.exit(2); }
const DRY_RUN = args.dryRun;
const MODE = args.mode;
const PROJECT = args.project;
const WINDOW = args.window;
const WORKSPACE_PROJECTS = process.env.PB_WORKSPACE_PROJECTS || '/Users/river/.openclaw/workspace/projects';
// Artifact-dir handoff (decided design): a step reads its scaffold from the prior
// step's OUTPUT dir (`--input`) and writes its own OUTPUT for the next step
// (`--output`). The handoff file is a fixed-name, fixed-key contract so modes need
// not share an items key — only the per-record fields the consumer's descriptor needs.
const HANDOFF_FILE = 'handoff.yaml';
const HANDOFF_KEY = 'handoff';
const INPUT_DIR = args.input ? resolve(ROOT, args.input) : null;
const OUTPUT_DIR = args.output ? resolve(ROOT, args.output) : null;

function runPb(argv, opts = {}) {
  const { ok = true, cwd = ROOT } = opts;
  try {
    const out = execFileSync(process.execPath, [PB, ...argv], { cwd, encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, out: out || '' };
  } catch (e) {
    if (ok) throw e;
    return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

function nowISO() {
  return new Date().toISOString();
}

function heartbeat() {
  console.log(`[heartbeat ${nowISO()}] ${MODE} monitor`);
}

// --- mode + scaffold descriptor --------------------------------------------
function loadMaster() {
  return yaml.load(readFileSync(resolve(ROOT, 'playbook.yaml'), 'utf8')) || {};
}

function loadScaffold(modeId) {
  const master = loadMaster();
  const rel = master.modes && master.modes[modeId];
  if (!rel) throw new Error(`Mode "${modeId}" is not registered in playbook.yaml modes:`);
  const doc = yaml.load(readFileSync(resolve(ROOT, rel), 'utf8')) || {};
  const sc = doc.scaffold;
  if (!sc || typeof sc !== 'object') {
    throw new Error(`Mode "${modeId}" declares no scaffold descriptor — cannot build a backlog from it.`);
  }
  for (const k of ['config', 'items', 'skill', 'goal_template', 'check_field']) {
    if (!sc[k]) throw new Error(`Mode "${modeId}" scaffold descriptor is missing "${k}".`);
  }
  return sc;
}

const SCAFFOLD = loadScaffold(MODE);
const ID_FIELD = SCAFFOLD.id_field || 'id';

function projectRoot(projectId) {
  return projectId ? resolve(WORKSPACE_PROJECTS, projectId) : null;
}

function loadYamlAbs(path) {
  return yaml.load(readFileSync(path, 'utf8')) || {};
}

function resolveConfigPath() {
  if (args.config) return resolve(ROOT, args.config);
  if (PROJECT) {
    const root = projectRoot(PROJECT);
    const projectFile = resolve(root, 'project.yaml');
    if (!existsSync(projectFile)) throw new Error(`Project descriptor not found: ${projectFile}`);
    const projectDoc = loadYamlAbs(projectFile);
    // project.yaml paths are relative to the PROJECT root, not the playbook repo.
    // resolve() is a no-op when the declared value is already absolute.
    const fromProject = (val) => resolve(root, val);
    const modeCfg = projectDoc.modes && projectDoc.modes[MODE];
    if (modeCfg) {
      if (typeof modeCfg === 'string') return fromProject(modeCfg);
      if (WINDOW && modeCfg[WINDOW]) return fromProject(modeCfg[WINDOW]);
      if (modeCfg.default_scaffold) return fromProject(modeCfg.default_scaffold);
    }
    const idxPath = resolve(root, 'scaffolds/index.yaml');
    if (existsSync(idxPath)) {
      const idx = loadYamlAbs(idxPath);
      const found = (idx.scaffolds || []).find((s) => s.mode === MODE && (!WINDOW || s.window === WINDOW));
      if (found?.run_config) return fromProject(found.run_config);
      if (found?.file) return fromProject(found.file);
    }
    const candidate = resolve(root, `scaffolds/modes/${MODE}/${WINDOW || 'default'}-run.yaml`);
    if (existsSync(candidate)) return candidate;
  }
  return SCAFFOLD.config;
}

const CONFIG_PATH = resolveConfigPath();

// The loop this monitor opens for itself; any OTHER active loop is someone's phase.
const OWN_LOOP_GOAL = `Daily ${MODE} monitoring`;

function ensureLoop() {
  const loop = readActiveLoop(ROOT);
  if (loop && loop.goal !== OWN_LOOP_GOAL && !args.adoptLoop) {
    console.error(`pb-daily-monitor: the active loop ${loop.id} ("${loop.goal ?? loop.title ?? 'no goal'}") was not opened by this monitor. ` +
      'Scaffolding watch tasks into it would mix them into that phase. Close it first, or pass --adopt-loop to run inside it on purpose. Nothing was written.');
    process.exit(3);
  }
  if (loop) return loop;
  if (DRY_RUN) {
    console.log('[dry-run] would create a new loop');
    return { id: 'DRY' };
  }
  runPb(['loop', 'new', '--fresh', '--goal', OWN_LOOP_GOAL, '--stop', 'Backlog drained and errors surfaced']);
  return readActiveLoop(ROOT);
}

function ensureCycle(reset) {
  const path = resolve(ROOT, 'memory/cycle.md');
  const exists = existsSync(path);
  if (reset || !exists) {
    if (DRY_RUN) {
      console.log('[dry-run] would create cycle brief');
    } else {
      runPb(['cycle', '--new', '--force', '--goal', `Daily ${MODE} monitoring`, '--stop', 'Backlog drained and errors surfaced']);
    }
  }
  if (DRY_RUN) return;
  let text = readFileSync(path, 'utf8');
  const placeholder = /\(Your host memory is the PAST[\s\S]*?do not silently follow memory\.\)/;
  if (placeholder.test(text)) {
    text = text.replace(placeholder, 'No conflicts.');
    writeFileSync(path, text, 'utf8');
  }
}

function setMode() {
  if (DRY_RUN) {
    console.log(`[dry-run] would set mode ${MODE}`);
    return;
  }
  runPb(['mode', 'set', MODE]);
}

// The mode's resolved skill menu (engine globals ∪ pack-local), as ids.
function menuSkillIds() {
  const { out } = runPb(['mode', 'skills', MODE], { ok: false });
  return new Set(out.split('\n').map((l) => l.trim()).filter(Boolean));
}

// Capability gap: the scaffold routes work to a skill that is NOT in the mode's
// menu. The heartbeat stays READ-ONLY on its own machinery — it does NOT plan an
// unroutable task and does NOT edit skills/processes. It logs a building-plan
// proposal for the separate evolution loop to pick up, and surfaces the gap.
function logGapProposal(loopId, skillId) {
  appendLog(ITERATIONS_LOG, {
    ts: nowISO(),
    loop_id: loopId,
    mode: MODE,
    task_id: null,
    kind: 'skill',
    target: skillId,
    reason: `scaffold skill "${skillId}" is not in mode "${MODE}" menu — capability gap`,
    building_plan:
      `Create skills/${skillId}/SKILL.md + processes/<proc>.yaml (or pack-local under modes/${MODE}/), ` +
      `register both in the mode's indices, then re-run the ${MODE} monitor.`,
    status: 'pending',
  });
}

function loadConfig() {
  // Source: a prior step's output dir (flow handoff), an explicit/project config, OR the mode fallback config.
  const abs = INPUT_DIR ? resolve(INPUT_DIR, HANDOFF_FILE) : resolve(ROOT, CONFIG_PATH);
  const itemsKey = INPUT_DIR ? HANDOFF_KEY : SCAFFOLD.items;
  if (!existsSync(abs)) throw new Error(`Config not found: ${abs}`);
  const doc = yaml.load(readFileSync(abs, 'utf8'));
  const items = doc && doc[itemsKey];
  if (!Array.isArray(items)) throw new Error(`Config must have a "${itemsKey}" array (source: ${abs})`);
  // Every ${field} the goal_template substitutes must be present and non-empty on
  // each item — otherwise renderGoal silently emits an empty goal (e.g. "Monitor
  // for ") and a meaningless task gets planned. Derived from the mode's own
  // template so this stays generic across packs (restores the old per-scaffold guard).
  const templateFields = [...String(SCAFFOLD.goal_template).matchAll(/\$\{(\w+)\}/g)].map((m) => m[1]);
  for (const it of items) {
    if (!it || !it[ID_FIELD] || !it[SCAFFOLD.check_field]) {
      throw new Error(`Item missing ${ID_FIELD}/${SCAFFOLD.check_field}: ${JSON.stringify(it)}`);
    }
    // Inject the project id BEFORE validating template fields — a goal_template may
    // reference ${project}, which is supplied by the --project arg, not the item.
    if (PROJECT && !it.project) it.project = PROJECT;
    for (const f of templateFields) {
      if (it[f] == null || String(it[f]).trim() === '') {
        throw new Error(`Item "${it[ID_FIELD]}" missing goal_template field "${f}" ` +
          `(goal_template: ${SCAFFOLD.goal_template}) — would render an empty goal`);
      }
    }
  }
  return items;
}

// Write this step's output for the next step in a flow (artifact-dir handoff).
// Pass-through here proves the wire; a real mode would transform what it forwards.
function writeHandoff(items) {
  if (DRY_RUN || !OUTPUT_DIR) return;
  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(resolve(OUTPUT_DIR, HANDOFF_FILE), yaml.dump({ [HANDOFF_KEY]: items }), 'utf8');
}

// Render "${field}" placeholders in the goal template from an item.
function renderGoal(template, item) {
  return String(template).replace(/\$\{(\w+)\}/g, (_, k) => (item[k] != null ? String(item[k]) : ''));
}

// Plan one task per config item; return [{ taskId, item }] so logs can map a
// task back to its source item without string-matching the title.
function planItems(items) {
  const planned = [];
  for (const item of items) {
    const goal = renderGoal(SCAFFOLD.goal_template, item);
    const check = item[SCAFFOLD.check_field];
    if (DRY_RUN) {
      console.log(`[dry-run] would plan: ${goal}`);
      planned.push({ taskId: `dry-${item[ID_FIELD]}`, item });
      continue;
    }
    const { out } = runPb(['plan', '--goal', goal, '--skill', SCAFFOLD.skill, '--check', check]);
    const m = out.match(/Planned \[([^\]]+)\]/);
    if (!m) throw new Error(`Could not parse planned task id from output:\n${out}`);
    planned.push({ taskId: m[1], item });
  }
  return planned;
}

function writeProjectScaffoldTrace(loopId, items, planned) {
  if (!PROJECT) return;
  const root = projectRoot(PROJECT);
  const stamp = WINDOW ? `${loopId}-${WINDOW}` : loopId;
  const dir = resolve(root, `scaffolds/generated/${stamp}`);
  if (DRY_RUN) {
    console.log(`[dry-run] would write project scaffold trace: ${dir}`);
    return;
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, 'scaffold-input.yaml'), readFileSync(resolve(ROOT, CONFIG_PATH), 'utf8'), 'utf8');
  writeFileSync(resolve(dir, 'planned-tasks.yaml'), yaml.dump({ mode: MODE, project: PROJECT, window: WINDOW, config: CONFIG_PATH, planned }), 'utf8');
  writeFileSync(resolve(dir, 'scaffold-report.md'), `# Scaffold Report — ${MODE}\n\n- project: ${PROJECT}\n- window: ${WINDOW || ''}\n- loop_id: ${loopId}\n- config: ${CONFIG_PATH}\n- planned: ${planned.length}\n\n`, 'utf8');
}

function runAuto() {
  if (DRY_RUN) {
    console.log('[dry-run] would run pb loop run --auto --defer-blocked');
    return { code: 0, out: '' };
  }
  return runPb(['loop', 'run', '--auto', '--defer-blocked'], { ok: false });
}

function readBacklog() {
  const tasksPath = resolve(ROOT, 'memory/backlog.yaml');
  const statePath = resolve(ROOT, 'memory/backlog-state.json');
  const tasks = yaml.load(readFileSync(tasksPath, 'utf8'))?.tasks || [];
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
  return tasks.map((t) => ({ ...t, ...(state[t.id] || {}) }));
}

function summarize(planned) {
  const ids = planned.map((p) => p.taskId);
  const tasks = readBacklog();
  const watched = tasks.filter((t) => ids.includes(t.id));
  const done = watched.filter((t) => t.status === 'done');
  const blocked = watched.filter((t) => t.status === 'blocked');
  const todo = watched.filter((t) => t.status !== 'done' && t.status !== 'blocked');
  return { watched, done, blocked, todo };
}

function appendLog(path, obj) {
  if (DRY_RUN) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(obj) + '\n', { flag: 'a' });
}

function writeLogs(loopId, planned, summary, autoOut) {
  const ts = nowISO();
  const itemFor = (taskId) => (planned.find((p) => p.taskId === taskId) || {}).item || {};

  for (const t of summary.blocked) {
    const item = itemFor(t.id);
    appendLog(ERRORS_LOG, {
      ts,
      loop_id: loopId,
      mode: MODE,
      item_id: item[ID_FIELD] || null,
      task_id: t.id,
      title: t.title,
      command: item[SCAFFOLD.check_field] || null,
      status: t.status,
      output_snippet: autoOut.slice(-2000),
    });
  }

  const proposed = summary.blocked.map((t) => {
    const item = itemFor(t.id);
    return {
      item_id: item[ID_FIELD] || null,
      task_id: t.id,
      target: item[ID_FIELD] ? `${MODE} item check command` : `${SCAFFOLD.skill} process/skill`,
      reason: `Task ${t.id} blocked during ${MODE} monitor`,
      status: 'pending',
    };
  });

  appendLog(REFLECTIONS_LOG, {
    ts,
    loop_id: loopId,
    mode: MODE,
    items_count: planned.length,
    done_count: summary.done.length,
    blocked_count: summary.blocked.length,
    todo_count: summary.todo.length,
    notes: `${MODE} monitor completed. ${summary.blocked.length ? 'Blocked items require review.' : 'All items passed.'}`,
    proposed_changes: proposed,
  });

  for (const p of proposed) {
    appendLog(ITERATIONS_LOG, { ts, loop_id: loopId, mode: MODE, ...p });
  }
}

function printSummary(summary) {
  console.log(`\n${MODE} monitor summary:`);
  console.log(`  planned : ${summary.watched.length}`);
  console.log(`  done    : ${summary.done.length}`);
  console.log(`  blocked : ${summary.blocked.length}`);
  console.log(`  todo    : ${summary.todo.length}`);
  if (summary.blocked.length) {
    console.log('\nBlocked items:');
    for (const t of summary.blocked) console.log(`  - [${t.id}] ${t.title}`);
  }
  if (summary.todo.length) {
    console.log('\nRemaining todo items:');
    for (const t of summary.todo) console.log(`  - [${t.id}] ${t.title}`);
  }
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------
heartbeat();
const loop = ensureLoop();
ensureCycle(args.resetCycle);
setMode();

// Gap gate: if the scaffold skill is not in the mode's menu, propose building it
// (read-only) and stop — do NOT scaffold unroutable tasks.
if (!DRY_RUN && !menuSkillIds().has(SCAFFOLD.skill)) {
  logGapProposal(loop?.id || 'legacy', SCAFFOLD.skill);
  console.error(
    `\nCapability gap: scaffold skill "${SCAFFOLD.skill}" is not in mode "${MODE}" menu.\n` +
    `Logged a pending building-plan proposal to artifacts/reports/orchestrator-iterations.ndjson.\n` +
    `No tasks were scaffolded. Build the skill in a separate loop, then re-run.`,
  );
  process.exit(2);
}

const items = loadConfig();
const planned = planItems(items);
writeProjectScaffoldTrace(loop?.id || 'legacy', items, planned);
const auto = runAuto();
const summary = summarize(planned);
writeLogs(loop?.id || 'legacy', planned, summary, auto.out);
printSummary(summary);

if (summary.blocked.length || summary.todo.length) {
  console.error('\nOrchestrator finished with unresolved items.');
  process.exit(1);
}
// Clean drain — forward this step's output for the next flow step (if any).
writeHandoff(items);
console.log('\nOrchestrator finished cleanly.');
