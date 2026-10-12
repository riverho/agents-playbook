#!/usr/bin/env node
// scripts/test-flow-runner.mjs
// ----------------------------------------------------------------------------
// Behavioral test for the flow runner (epoch loop-20260628-001, task flow-runner).
// Proves:
//   CHAIN:     a 2-mode flow A->B where B scaffolds from A's OUTPUT dir runs A
//              then B and exits 0; both steps' tasks drain; all under ONE epoch.
//   FAIL-FAST: a flow whose FIRST step fails halts before the second step runs.
// ----------------------------------------------------------------------------

import {
  mkdtempSync, mkdirSync, copyFileSync, symlinkSync,
  writeFileSync, readFileSync, existsSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import yaml from 'js-yaml';
import { tempDir, copyModules } from './lib/test-temp.mjs';

const repoRoot = process.cwd();
let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.error(`  FAIL  ${name}${extra ? `\n        ${extra}` : ''}`); fail++; }
}

// A monitor mode 'name' whose scaffold reads `itemsKey` and plans `skill`.
function writeMode(root, name, { itemsKey, skill, goal, configRel }) {
  mkdirSync(join(root, `modes/${name}/skills/${skill}`), { recursive: true });
  mkdirSync(join(root, `modes/${name}/processes`), { recursive: true });
  writeFileSync(join(root, `modes/${name}.yaml`), yaml.dump({
    id: name, description: `${name} monitor`, directive: '',
    skills_index: `modes/${name}/skills/index.yaml`,
    processes_index: `modes/${name}/processes/index.yaml`,
    scaffold: { config: configRel, items: itemsKey, skill, id_field: 'name', goal_template: goal, check_field: 'cmd' },
    principles: [{ id: 'p', kind: 'advice', text: 'x' }],
  }));
  writeFileSync(join(root, `modes/${name}/skills/index.yaml`), yaml.dump({
    skills: [{ id: skill, file: `modes/${name}/skills/${skill}/SKILL.md`, process: `${name}-proc`, summary: 'x' }],
  }));
  writeFileSync(join(root, `modes/${name}/skills/${skill}/SKILL.md`), `---\nname: ${skill}\ndescription: x\n---\nx\n`);
  writeFileSync(join(root, `modes/${name}/processes/index.yaml`), yaml.dump({
    processes: [{ id: `${name}-proc`, file: `modes/${name}/processes/${name}-proc.yaml`, owner: name }],
  }));
  writeFileSync(join(root, `modes/${name}/processes/${name}-proc.yaml`), yaml.dump({ id: `${name}-proc`, steps: [] }));
}

function buildRoot(aCmd) {
  const root = tempDir('pbflow-');
  for (const d of ['scripts', 'scripts/lib', 'memory', 'modes', 'skills', 'processes', 'artifacts/reports', 'flows']) {
    mkdirSync(join(root, d), { recursive: true });
  }
  for (const f of ['scripts/pb.mjs', 'scripts/pb-daily-monitor.mjs', 'scripts/pb-flow.mjs', 'scripts/check-flow.mjs', 'scripts/lib/loop-lib.mjs']) {
    copyFileSync(resolve(repoRoot, f), join(root, f));
  }
  copyModules(resolve(repoRoot, 'node_modules'), join(root, 'node_modules'));
  copyFileSync(resolve(repoRoot, 'modes/coding.yaml'), join(root, 'modes/coding.yaml'));
  writeFileSync(join(root, 'skills/index.yaml'), 'skills: []\n');
  writeFileSync(join(root, 'processes/index.yaml'), 'processes: []\n');
  writeFileSync(join(root, 'memory/journal.ndjson'), '');
  writeFileSync(join(root, 'memory/backlog.yaml'), 'tasks:\n');
  writeFileSync(join(root, 'memory/processes.ndjson'), '');

  // Step A: mode 'alpha', static config; passes (or fails, per aCmd). Its items
  // carry name+cmd so the handoff records satisfy step B's descriptor.
  mkdirSync(join(root, 'modes/alpha/config'), { recursive: true });
  writeMode(root, 'alpha', { itemsKey: 'sources', skill: 'a-skill', goal: 'A ${name}', configRel: 'modes/alpha/config/items.yaml' });
  writeFileSync(join(root, 'modes/alpha/config/items.yaml'), yaml.dump({
    sources: [{ name: 's1', cmd: aCmd }],
  }));
  // Step B: mode 'beta', reads its scaffold from the handoff (--input), so its
  // static config is unused; still declare one for the descriptor.
  writeMode(root, 'beta', { itemsKey: 'unused', skill: 'b-skill', goal: 'B ${name}', configRel: 'modes/beta/config/items.yaml' });
  mkdirSync(join(root, 'modes/beta/config'), { recursive: true });
  writeFileSync(join(root, 'modes/beta/config/items.yaml'), yaml.dump({ unused: [] }));

  writeFileSync(join(root, 'flows/toy.yaml'), yaml.dump({
    id: 'toy',
    steps: [
      { mode: 'alpha', output: 'artifacts/flows/toy/a' },
      { mode: 'beta', input: 'artifacts/flows/toy/a', output: 'artifacts/flows/toy/b' },
    ],
  }));

  writeFileSync(join(root, 'playbook.yaml'), [
    'name: t', 'index:', '  memory:',
    '    backlog: memory/backlog.yaml', '    journal: memory/journal.ndjson',
    '    loops: memory/loops.yaml', '    cycle: memory/cycle.md', '    processes: memory/processes.ndjson',
    'paths:', '  artifacts: artifacts', 'default_mode: coding',
    'modes:', '  coding: modes/coding.yaml', '  alpha: modes/alpha.yaml', '  beta: modes/beta.yaml',
    'guardrails:', '  allowed_statuses: [todo, in_progress, blocked, done]', '',
  ].join('\n'));
  return root;
}

function runFlow(root) {
  try {
    const out = execFileSync(process.execPath, [join(root, 'scripts/pb-flow.mjs'), '--flow', 'toy'], {
      cwd: root, encoding: 'utf8', stdio: 'pipe',
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}
function tasks(root) {
  const t = yaml.load(readFileSync(join(root, 'memory/backlog.yaml'), 'utf8'))?.tasks || [];
  const state = existsSync(join(root, 'memory/backlog-state.json'))
    ? JSON.parse(readFileSync(join(root, 'memory/backlog-state.json'), 'utf8')) : {};
  return t.map((x) => ({ ...x, ...(state[x.id] || {}) }));
}
function loops(root) {
  return yaml.load(readFileSync(join(root, 'memory/loops.yaml'), 'utf8')) || {};
}

// --- check-flow validates the toy flow structurally ----------------------------
{
  const root = buildRoot("node -e \"process.exit(0)\"");
  const r = (() => { try {
    execFileSync(process.execPath, [join(root, 'scripts/check-flow.mjs')], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
    return { code: 0 };
  } catch (e) { return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` }; } })();
  ok('check-flow passes on a well-formed flow', r.code === 0, r.out);
  rmSync(root, { recursive: true, force: true });
}

// --- CHAIN: A -> B, B scaffolds from A's output dir ----------------------------
{
  const root = buildRoot("node -e \"process.exit(0)\"");
  const r = runFlow(root);
  ok('chain: flow exits 0', r.code === 0, r.out);
  ok('chain: A wrote its handoff output', existsSync(join(root, 'artifacts/flows/toy/a/handoff.yaml')), r.out);
  const ts = tasks(root);
  ok('chain: step A task done (title "A s1")', ts.some((t) => t.title === 'A s1' && t.status === 'done'), JSON.stringify(ts.map((t) => [t.title, t.status])));
  ok('chain: step B task done, scaffolded from A output (title "B s1")',
    ts.some((t) => t.title === 'B s1' && t.status === 'done'), JSON.stringify(ts.map((t) => [t.title, t.status])));
  ok('chain: exactly ONE loop epoch for the whole flow', (loops(root).loops || []).length === 1, JSON.stringify(loops(root)));
  rmSync(root, { recursive: true, force: true });
}

// --- FAIL-FAST: step A fails -> B never runs -----------------------------------
{
  const root = buildRoot("node -e \"process.exit(1)\"");
  const r = runFlow(root);
  ok('fail-fast: flow exits non-zero', r.code !== 0, `code=${r.code}`);
  ok('fail-fast: runner reports halt at step 1', /HALTED at step 1/.test(r.out), r.out);
  const ts = tasks(root);
  ok('fail-fast: step B never scaffolded a task', !ts.some((t) => String(t.title).startsWith('B ')),
    JSON.stringify(ts.map((t) => t.title)));
  ok('fail-fast: B input handoff was never produced', !existsSync(join(root, 'artifacts/flows/toy/b/handoff.yaml')));
  rmSync(root, { recursive: true, force: true });
}

console.log(`\ntest-flow-runner: ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
