// scripts/test-fixture-playbook.mjs
// ----------------------------------------------------------------------------
// Shared fixture for the v2 engine suites (graph layers/live, comment intent, decide,
// versions, state, tick). Not a test itself — it is imported. Each fixture is a temp
// playbook root: the engine under test is COPIED in, node_modules is COPIED (never
// linked — a recursive delete once followed a link and emptied the source), and every
// state file is written here, so no suite ever touches the real playbook's memory/.
// ----------------------------------------------------------------------------
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const ENGINE = resolve('scripts/pb.mjs');
const MODULES = resolve('node_modules');

// Scrub the identity a recording parent stamps on the environment (record --status done
// runs these suites with PB_CLAIM_TOKEN set), so assertions about authority are real.
export const BASE_ENV = (() => {
  const e = { ...process.env };
  for (const k of ['PB_CLAIM_TOKEN', 'PB_AGENT_CHAIN', 'PB_PARENT_AGENT_ID', 'PB_AGENT_ID', 'PB_SESSION_ID', 'PB_RUNTIME', 'PB_CHECK_TIMEOUT_MS']) delete e[k];
  return e;
})();

export function makeSuite(name) {
  let pass = 0;
  let fail = 0;
  const roots = [];
  return {
    ok(label, cond, extra = '') {
      if (cond) { console.log(`  PASS  ${label}`); pass++; }
      else { console.error(`  FAIL  ${label}${extra ? `\n        ${String(extra).slice(0, 1200)}` : ''}`); fail++; }
    },
    track(root) { roots.push(root); return root; },
    finish() {
      for (const r of roots) { try { rmSync(r, { recursive: true, force: true }); } catch { /* temp */ } }
      console.log(`\n${name}: ${pass} passed, ${fail} failed`);
      process.exit(fail ? 1 : 0);
    },
  };
}

export function runPb(root, args, { agent = 'agent', env = {}, input } = {}) {
  const r = spawnSync(process.execPath, [join(root, 'scripts/pb.mjs'), ...args], {
    cwd: root, encoding: 'utf8', input, env: { ...BASE_ENV, PB_AGENT_ID: agent, ...env },
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '', combined: `${r.stdout || ''}${r.stderr || ''}` };
}

export function pbJson(root, args, opts) {
  const r = runPb(root, args, opts);
  try { return JSON.parse(r.out); }
  catch (e) { throw new Error(`pb ${args.join(' ')}: no JSON (exit ${r.code}): ${e.message}\n${r.combined.slice(0, 800)}`); }
}

export const readJournal = (root) => readFileSync(join(root, 'memory/journal.ndjson'), 'utf8')
  .split(/\r?\n/).filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

const yamlScalar = (v) => JSON.stringify(String(v));

// tasks: [{ id, title, layer?, dependencies?, priority?, manual?, checks?, extra? (raw yaml lines) }]
// layers: [{ id, name, about?, gate?, human? }] or null for an unlayered playbook
// journal: array of row objects; state: backlog-state.json object (without __ fields)
export function makeFixture({ prefix = 'pbv2-', layers = null, tasks = [], journal = [], state = {}, loops = null, cycle = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  for (const d of ['scripts', 'memory', 'modes', 'processes', 'skills/run-task', 'artifacts/reports']) mkdirSync(join(root, d), { recursive: true });
  cpSync(ENGINE, join(root, 'scripts/pb.mjs'));
  cpSync(MODULES, join(root, 'node_modules'), { recursive: true });
  writeFileSync(join(root, 'SKILL.md'), '---\nname: v2-test\ndescription: t\n---\n');
  writeFileSync(join(root, 'processes/index.yaml'), 'processes:\n  - id: run-task\n    file: processes/run-task.yaml\n');
  writeFileSync(join(root, 'processes/run-task.yaml'), 'id: run-task\n');
  writeFileSync(join(root, 'skills/index.yaml'), 'skills:\n  - id: run-task\n    file: skills/run-task/SKILL.md\n    process: run-task\n');
  writeFileSync(join(root, 'skills/run-task/SKILL.md'), '---\nname: run-task\ndescription: t\n---\n');
  writeFileSync(join(root, 'modes/coding.yaml'), 'id: coding\ndirective: ""\n');
  writeFileSync(join(root, 'memory/project-memory.md'), '# memory\n');
  writeFileSync(join(root, 'memory/lessons.ndjson'), '');
  writeFileSync(join(root, 'memory/processes.ndjson'), '');
  writeFileSync(join(root, 'memory/loops.yaml'), loops ??
    `active: loop-fix-001\nloops:\n  - id: loop-fix-001\n    status: active\n    started_at: ${new Date().toISOString()}\n    goal: fixture loop\n    stop: fixture stop\n    mode: coding\n`);
  if (cycle) {
    writeFileSync(join(root, 'memory/cycle.md'),
      `---\nphase: 1\nstarted: "${new Date().toISOString()}"\ngoal: "fixture goal"\nstop: "fixture stop"\n---\n# Cycle Brief — phase 1\n## 1. What is this cycle's goal?\nfixture goal\n`);
  }
  const lines = [
    'name: v2-test', 'version: 0.0.1', 'entry: SKILL.md',
    'north_star: Make "done" mean a verified exit code, not a claim.',
    'paths:', '  scripts: scripts', '  processes: processes', '  skills: skills', '  memory: memory',
    '  modes: modes', '  artifacts: artifacts', '  reports: artifacts/reports',
    'index:', '  processes_index: processes/index.yaml', '  skills_index: skills/index.yaml', '  memory:',
    '    project_memory: memory/project-memory.md', '    backlog: memory/backlog.yaml',
    '    journal: memory/journal.ndjson', '    cycle: memory/cycle.md', '    loops: memory/loops.yaml',
    '    lessons: memory/lessons.ndjson', '    processes: memory/processes.ndjson',
    'loop:', '  description: test loop', '  steps:',
    '    - id: orient', '      do: orient', '    - id: select', '      do: select', '    - id: act', '      do: act',
    '    - id: verify', '      do: verify', '    - id: record', '      do: record', '    - id: report', '      do: report',
    'default_mode: coding', 'modes:', '  coding: modes/coding.yaml',
    'guardrails:', '  allowed_statuses: [todo, in_progress, blocked, done]',
  ];
  if (layers) {
    lines.push('layers:');
    for (const l of layers) {
      lines.push(`  - id: ${l.id}`, `    name: ${yamlScalar(l.name || l.id)}`);
      if (l.about) lines.push(`    about: ${yamlScalar(l.about)}`);
      if (l.human) lines.push('    human: true');
      if (l.gate) lines.push(`    gate: ${yamlScalar(l.gate)}`);
    }
  }
  writeFileSync(join(root, 'playbook.yaml'), lines.join('\n') + '\n');
  writeBacklog(root, tasks);
  writeFileSync(join(root, 'memory/journal.ndjson'), journal.map((r) => JSON.stringify(r)).join('\n') + (journal.length ? '\n' : ''));
  const lastSeq = journal.reduce((m, r) => Math.max(m, typeof r.seq === 'number' ? r.seq : 0), 0);
  writeFileSync(join(root, 'memory/backlog-state.json'), JSON.stringify({
    ...state, __seq: lastSeq, __written_at: new Date().toISOString(), __written_by: 'fixture',
  }, null, 2) + '\n');
  return root;
}

export function writeBacklog(root, tasks) {
  const out = ['tasks:'];
  for (const t of tasks) {
    out.push(`  - id: ${t.id}`, `    title: ${yamlScalar(t.title || t.id)}`, '    status: todo', '    skill: run-task',
      '    mode: coding', `    priority: ${t.priority ?? 1}`);
    if (t.layer) out.push(`    layer: ${t.layer}`);
    if (t.dependencies?.length) out.push(`    dependencies: [${t.dependencies.join(', ')}]`);
    if (t.manual) out.push('    manual: true');
    out.push('    acceptance_checks:');
    for (const c of t.checks || ['node -e process.exit(0)']) out.push(`      - ${yamlScalar(c)}`);
    for (const x of t.extra || []) out.push(`    ${x}`);
  }
  writeFileSync(join(root, 'memory/backlog.yaml'), out.join('\n') + '\n');
}
