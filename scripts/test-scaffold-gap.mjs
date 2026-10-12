#!/usr/bin/env node
// scripts/test-scaffold-gap.mjs
// ----------------------------------------------------------------------------
// Behavioral test for scaffold gap detection (epoch loop-20260628-001, task
// scaffold-gap-proposal). Proves:
//   GAP:    a scaffold skill absent from the mode's menu yields EXACTLY ONE
//           pending building-plan proposal naming the missing capability, and
//           NO task is scaffolded (no unroutable/blocked task).
//   NO GAP: a scaffold skill present in the menu plans+drains normally and
//           writes NO proposal.
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

// Build a temp playbook with a single synthetic mode whose scaffold routes to
// `scaffoldSkill`, while the mode's skill index registers `menuSkill`.
function buildRoot(menuSkill, scaffoldSkill) {
  const root = tempDir('pbgap-');
  for (const d of ['scripts', 'scripts/lib', 'memory', 'modes', 'skills', 'processes', 'artifacts/reports']) {
    mkdirSync(join(root, d), { recursive: true });
  }
  copyFileSync(resolve(repoRoot, 'scripts/pb.mjs'), join(root, 'scripts/pb.mjs'));
  copyFileSync(resolve(repoRoot, 'scripts/pb-daily-monitor.mjs'), join(root, 'scripts/pb-daily-monitor.mjs'));
  copyFileSync(resolve(repoRoot, 'scripts/lib/loop-lib.mjs'), join(root, 'scripts/lib/loop-lib.mjs'));
  copyModules(resolve(repoRoot, 'node_modules'), join(root, 'node_modules'));
  copyFileSync(resolve(repoRoot, 'modes/coding.yaml'), join(root, 'modes/coding.yaml'));
  writeFileSync(join(root, 'skills/index.yaml'), 'skills: []\n');
  writeFileSync(join(root, 'processes/index.yaml'), 'processes: []\n');
  writeFileSync(join(root, 'memory/journal.ndjson'), '');
  writeFileSync(join(root, 'memory/backlog.yaml'), 'tasks:\n');
  writeFileSync(join(root, 'memory/processes.ndjson'), '');

  mkdirSync(join(root, `modes/m/skills/${menuSkill}`), { recursive: true });
  mkdirSync(join(root, 'modes/m/processes'), { recursive: true });
  mkdirSync(join(root, 'modes/m/config'), { recursive: true });
  writeFileSync(join(root, 'modes/m.yaml'), yaml.dump({
    id: 'm', description: 'gap-test mode', directive: '',
    skills_index: 'modes/m/skills/index.yaml',
    processes_index: 'modes/m/processes/index.yaml',
    scaffold: {
      config: 'modes/m/config/items.yaml', items: 'targets', skill: scaffoldSkill,
      id_field: 'name', goal_template: 'Do ${name}', check_field: 'cmd',
    },
    principles: [{ id: 'p', kind: 'advice', text: 'x' }],
  }));
  writeFileSync(join(root, 'modes/m/skills/index.yaml'), yaml.dump({
    skills: [{ id: menuSkill, file: `modes/m/skills/${menuSkill}/SKILL.md`, process: 'm-proc', summary: 'x' }],
  }));
  writeFileSync(join(root, `modes/m/skills/${menuSkill}/SKILL.md`), `---\nname: ${menuSkill}\ndescription: x\n---\nx\n`);
  writeFileSync(join(root, 'modes/m/processes/index.yaml'), yaml.dump({
    processes: [{ id: 'm-proc', file: 'modes/m/processes/m-proc.yaml', owner: 'm' }],
  }));
  writeFileSync(join(root, 'modes/m/processes/m-proc.yaml'), yaml.dump({ id: 'm-proc', steps: [] }));
  writeFileSync(join(root, 'modes/m/config/items.yaml'), yaml.dump({
    targets: [{ name: 't1', cmd: "node -e \"process.exit(0)\"" }],
  }));
  writeFileSync(join(root, 'playbook.yaml'), [
    'name: t', 'index:', '  memory:',
    '    backlog: memory/backlog.yaml', '    journal: memory/journal.ndjson',
    '    loops: memory/loops.yaml', '    cycle: memory/cycle.md', '    processes: memory/processes.ndjson',
    'paths:', '  artifacts: artifacts', 'default_mode: coding',
    'modes:', '  coding: modes/coding.yaml', '  m: modes/m.yaml',
    'guardrails:', '  allowed_statuses: [todo, in_progress, blocked, done]', '',
  ].join('\n'));
  return root;
}

function run(root) {
  try {
    const out = execFileSync(process.execPath, [join(root, 'scripts/pb-daily-monitor.mjs'), '--mode', 'm'], {
      cwd: root, encoding: 'utf8', stdio: 'pipe',
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}
function iterations(root) {
  const p = join(root, 'artifacts/reports/orchestrator-iterations.ndjson');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}
function tasks(root) {
  return yaml.load(readFileSync(join(root, 'memory/backlog.yaml'), 'utf8'))?.tasks || [];
}

// --- GAP: scaffold skill "ghost" not in the menu (menu has "real") -------------
{
  const root = buildRoot('real-skill', 'ghost-skill');
  const r = run(root);
  const iters = iterations(root);
  ok('gap: orchestrator exits non-zero (surfaced)', r.code !== 0, `code=${r.code}`);
  ok('gap: exactly ONE proposal line written', iters.length === 1, JSON.stringify(iters));
  ok('gap: proposal is pending and names the missing skill',
    iters[0] && iters[0].status === 'pending' && iters[0].target === 'ghost-skill' && iters[0].kind === 'skill',
    JSON.stringify(iters[0]));
  ok('gap: proposal carries a building_plan',
    iters[0] && typeof iters[0].building_plan === 'string' && iters[0].building_plan.length > 0, JSON.stringify(iters[0]));
  ok('gap: NO task was scaffolded (no unroutable/blocked task)', tasks(root).length === 0,
    JSON.stringify(tasks(root)));
  rmSync(root, { recursive: true, force: true });
}

// --- NO GAP: scaffold skill present in the menu -------------------------------
{
  const root = buildRoot('real-skill', 'real-skill');
  const r = run(root);
  ok('no-gap: orchestrator exits 0', r.code === 0, r.out);
  const ts = tasks(root);
  ok('no-gap: one task scaffolded', ts.length === 1, JSON.stringify(ts));
  ok('no-gap: NO proposal written', iterations(root).length === 0, JSON.stringify(iterations(root)));
  rmSync(root, { recursive: true, force: true });
}

console.log(`\ntest-scaffold-gap: ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
