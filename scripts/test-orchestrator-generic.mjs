#!/usr/bin/env node
// scripts/test-orchestrator-generic.mjs
// ----------------------------------------------------------------------------
// Behavioral test for the mode-agnostic orchestrator (epoch loop-20260628-001,
// task orchestrator-generic). Proves:
//   1. NO REGRESSION: `--mode blogwatch` with the real pack still plans+drains
//      the example watches green.
//   2. GENERIC BY SHAPE: the orchestrator source carries no blogwatch scaffold
//      literals (the "watches" array key, the "watch-feeds" skill) — those are
//      read from the mode's scaffold descriptor.
//   3. GENERIC BY BEHAVIOR: a SYNTHETIC second mode ("probe") with a different
//      items key, skill, and goal template scaffolds + drains through the same
//      orchestrator — proof the shape comes from the mode, not the script.
// ----------------------------------------------------------------------------

import {
  mkdtempSync, mkdirSync, copyFileSync, cpSync, symlinkSync,
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

function baseRoot() {
  const root = tempDir('pbgen-');
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
  return root;
}

function writeMaster(root, modes) {
  const lines = [
    'name: t', 'index:', '  memory:',
    '    backlog: memory/backlog.yaml', '    journal: memory/journal.ndjson',
    '    loops: memory/loops.yaml', '    cycle: memory/cycle.md', '    processes: memory/processes.ndjson',
    'paths:', '  artifacts: artifacts', 'default_mode: coding', 'modes:',
  ];
  for (const [id, rel] of Object.entries(modes)) lines.push(`  ${id}: ${rel}`);
  lines.push('guardrails:', '  allowed_statuses: [todo, in_progress, blocked, done]', '');
  writeFileSync(join(root, 'playbook.yaml'), lines.join('\n'));
}

function runOrchestrator(root, extraArgs = []) {
  try {
    const out = execFileSync(process.execPath, [join(root, 'scripts/pb-daily-monitor.mjs'), ...extraArgs], {
      cwd: root, encoding: 'utf8', stdio: 'pipe',
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

function backlogState(root) {
  const tasks = yaml.load(readFileSync(join(root, 'memory/backlog.yaml'), 'utf8'))?.tasks || [];
  const state = existsSync(join(root, 'memory/backlog-state.json'))
    ? JSON.parse(readFileSync(join(root, 'memory/backlog-state.json'), 'utf8'))
    : {};
  return tasks.map((t) => ({ ...t, ...(state[t.id] || {}) }));
}

// ===========================================================================
// 2. GENERIC BY SHAPE — source carries no blogwatch scaffold literals
// ===========================================================================
const src = readFileSync(resolve(repoRoot, 'scripts/pb-daily-monitor.mjs'), 'utf8');
ok('orchestrator source has no "watch-feeds" skill literal', !/watch-feeds/.test(src));
ok('orchestrator source has no hardcoded "watches" items-key literal',
  !/['"]watches['"]/.test(src), 'the items key must come from the mode scaffold descriptor');

// ===========================================================================
// 1. NO REGRESSION — --mode blogwatch with the real pack drains green
// ===========================================================================
{
  const root = baseRoot();
  copyFileSync(resolve(repoRoot, 'modes/blogwatch.yaml'), join(root, 'modes/blogwatch.yaml'));
  cpSync(resolve(repoRoot, 'modes/blogwatch'), join(root, 'modes/blogwatch'), { recursive: true });
  writeMaster(root, { coding: 'modes/coding.yaml', blogwatch: 'modes/blogwatch.yaml' });
  writeFileSync(join(root, 'modes/blogwatch/config/daily-watches.yaml'), yaml.dump({
    watches: [
      { id: 'w1', source: 'feed-a', criteria: 'kw A', check: "node -e \"process.exit(0)\"" },
      { id: 'w2', source: 'feed-b', criteria: 'kw B', check: "node -e \"process.exit(0)\"" },
    ],
  }));
  const r = runOrchestrator(root, ['--mode', 'blogwatch']);
  ok('`--mode blogwatch` exits 0 (no regression)', r.code === 0, r.out);
  const st = backlogState(root);
  ok('blogwatch: two tasks planned and all done', st.length === 2 && st.every((t) => t.status === 'done'), JSON.stringify(st));
  rmSync(root, { recursive: true, force: true });
}

// ===========================================================================
// 3. GENERIC BY BEHAVIOR — a synthetic mode with a DIFFERENT shape drains too
// ===========================================================================
{
  const root = baseRoot();
  // probe pack: items key "targets", skill "probe-skill", id_field "name",
  // goal_template "Probe ${target}", check_field "cmd" — all different from blogwatch.
  mkdirSync(join(root, 'modes/probe/skills/probe-skill'), { recursive: true });
  mkdirSync(join(root, 'modes/probe/processes'), { recursive: true });
  mkdirSync(join(root, 'modes/probe/config'), { recursive: true });
  writeFileSync(join(root, 'modes/probe.yaml'), yaml.dump({
    id: 'probe',
    description: 'synthetic monitor pack for the generic-orchestrator test',
    directive: '',
    skills_index: 'modes/probe/skills/index.yaml',
    processes_index: 'modes/probe/processes/index.yaml',
    scaffold: {
      config: 'modes/probe/config/items.yaml',
      items: 'targets',
      skill: 'probe-skill',
      id_field: 'name',
      goal_template: 'Probe ${target}',
      check_field: 'cmd',
    },
    principles: [{ id: 'p', kind: 'advice', text: 'synthetic' }],
  }));
  writeFileSync(join(root, 'modes/probe/skills/index.yaml'), yaml.dump({
    skills: [{ id: 'probe-skill', file: 'modes/probe/skills/probe-skill/SKILL.md', process: 'probe-proc', summary: 'synthetic' }],
  }));
  writeFileSync(join(root, 'modes/probe/skills/probe-skill/SKILL.md'), '---\nname: probe-skill\ndescription: synthetic\n---\nProbe.\n');
  writeFileSync(join(root, 'modes/probe/processes/index.yaml'), yaml.dump({
    processes: [{ id: 'probe-proc', file: 'modes/probe/processes/probe-proc.yaml', owner: 'probe' }],
  }));
  writeFileSync(join(root, 'modes/probe/processes/probe-proc.yaml'), yaml.dump({ id: 'probe-proc', steps: [] }));
  writeFileSync(join(root, 'modes/probe/config/items.yaml'), yaml.dump({
    targets: [
      { name: 'p1', target: 'alpha', cmd: "node -e \"process.exit(0)\"" },
      { name: 'p2', target: 'beta', cmd: "node -e \"process.exit(0)\"" },
    ],
  }));
  writeMaster(root, { coding: 'modes/coding.yaml', probe: 'modes/probe.yaml' });

  const r = runOrchestrator(root, ['--mode', 'probe']);
  ok('`--mode probe` (synthetic shape) exits 0', r.code === 0, r.out);
  const st = backlogState(root);
  ok('probe: two tasks planned and all done', st.length === 2 && st.every((t) => t.status === 'done'), JSON.stringify(st));
  ok('probe: goal template rendered from the item (title = "Probe alpha")',
    st.some((t) => t.title === 'Probe alpha') && st.some((t) => t.title === 'Probe beta'),
    JSON.stringify(st.map((t) => t.title)));
  rmSync(root, { recursive: true, force: true });
}

console.log(`\ntest-orchestrator-generic: ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
