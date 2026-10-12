#!/usr/bin/env node
// scripts/test-daily-monitor-help-inert.mjs
// ----------------------------------------------------------------------------
// A read is a read (monitor-help-must-not-mutate). Observed 2026-10-09: a probe ran
// `pb-daily-monitor.mjs --help`, the script ran a full iteration, scaffolded watch
// tasks into an unrelated ACTIVE phase loop and recorded them done against dummy
// checks. Two defects, two guards:
//   1. --help, an unknown flag, or a flag missing its value writes NOTHING;
//   2. a run refuses to adopt an active loop it did not open, unless --adopt-loop
//      says so (pb-flow passes it for the loop it opened for its steps).
// Every case snapshots memory/ and artifacts/ byte for byte before and after.
// ----------------------------------------------------------------------------

import { cpSync, mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';
import { BASE_ENV } from './test-fixture-playbook.mjs';
import { tempDir } from './lib/test-temp.mjs';

const repo = process.cwd();
const roots = [];
let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.error(`  FAIL  ${name}${extra ? `\n        ${String(extra).slice(0, 1200)}` : ''}`); fail++; }
}

const UNRELATED = 'active: loop-design-001\nloops:\n  - id: loop-design-001\n    status: active\n' +
  `    started_at: ${new Date().toISOString()}\n    goal: Paint the design for approval\n    stop: design approved\n    mode: coding\n`;

function buildRoot(loops) {
  const root = tempDir('pbmoninert-');
  roots.push(root);
  for (const d of ['scripts/lib', 'memory', 'modes', 'skills', 'processes', 'artifacts/reports']) mkdirSync(join(root, d), { recursive: true });
  for (const f of ['scripts/pb.mjs', 'scripts/pb-daily-monitor.mjs', 'scripts/lib/loop-lib.mjs', 'modes/coding.yaml', 'modes/blogwatch.yaml']) {
    copyFileSync(resolve(repo, f), join(root, f));
  }
  cpSync(resolve(repo, 'modes/blogwatch'), join(root, 'modes/blogwatch'), { recursive: true });
  // copied, never linked: a recursive delete once followed a link and emptied the source
  cpSync(resolve(repo, 'node_modules'), join(root, 'node_modules'), { recursive: true });
  writeFileSync(join(root, 'modes/blogwatch/config/daily-watches.yaml'), yaml.dump({ watches: [
    { id: 'w1', source: 'feed-a', criteria: 'keyword A', check: 'node -e "process.exit(0)"' },
  ] }));
  writeFileSync(join(root, 'playbook.yaml'), [
    'name: t', 'index:', '  memory:', '    backlog: memory/backlog.yaml', '    journal: memory/journal.ndjson',
    '    loops: memory/loops.yaml', '    cycle: memory/cycle.md', '    processes: memory/processes.ndjson',
    'paths:', '  artifacts: artifacts', 'default_mode: coding', 'default_monitor_mode: blogwatch',
    'modes:', '  coding: modes/coding.yaml', '  blogwatch: modes/blogwatch.yaml',
    'guardrails:', '  allowed_statuses: [todo, in_progress, blocked, done]', '',
  ].join('\n'));
  writeFileSync(join(root, 'skills/index.yaml'), 'skills: []\n');
  writeFileSync(join(root, 'processes/index.yaml'), 'processes: []\n');
  writeFileSync(join(root, 'memory/journal.ndjson'), '');
  writeFileSync(join(root, 'memory/backlog.yaml'), 'tasks:\n');
  writeFileSync(join(root, 'memory/processes.ndjson'), '');
  if (loops) writeFileSync(join(root, 'memory/loops.yaml'), loops);
  return root;
}

// every file under memory/ and artifacts/, with its bytes
function snapshot(root) {
  const out = {};
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[p.slice(root.length)] = readFileSync(p, 'utf8');
    }
  };
  walk(join(root, 'memory'));
  walk(join(root, 'artifacts'));
  return out;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const diffKeys = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]).join(', ');

function monitor(root, args) {
  const r = spawnSync(process.execPath, [join(root, 'scripts/pb-daily-monitor.mjs'), ...args], { cwd: root, encoding: 'utf8', env: BASE_ENV });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

// ── 1. reads and bad flags write nothing, even with an active loop to adopt ──
const root = buildRoot(UNRELATED);
const inert = (label, args, check) => {
  const before = snapshot(root);
  const r = monitor(root, args);
  const after = snapshot(root);
  ok(`${label}: nothing under memory/ or artifacts/ changed`, same(before, after), `changed: ${diffKeys(before, after)}\n${r.out}`);
  ok(`${label}: ${check.name}`, check.test(r), `exit=${r.code}\n${r.out}`);
};
inert('--help', ['--help'], { name: 'prints usage and exits 0', test: (r) => r.code === 0 && /Usage: node scripts\/pb-daily-monitor\.mjs/.test(r.out) && !/heartbeat/.test(r.out) });
inert('-h', ['-h'], { name: 'prints usage and exits 0', test: (r) => r.code === 0 && /Usage:/.test(r.out) });
inert('an unknown flag', ['--bogus'], { name: 'refuses with exit 2 and names the flag', test: (r) => r.code === 2 && /unknown argument: --bogus/.test(r.out) && /Nothing was run or written/.test(r.out) });
inert('a flag missing its value', ['--mode'], { name: 'refuses with exit 2', test: (r) => r.code === 2 && /--mode needs a value/.test(r.out) });
inert('--help after a real flag', ['--mode', 'blogwatch', '--help'], { name: 'still only prints usage', test: (r) => r.code === 0 && /Usage:/.test(r.out) });

// ── 2. an unrelated active loop is refused, not adopted ──────────────────────
inert('a run while an unrelated loop is active', [], {
  name: 'refuses with exit 3, naming the loop and --adopt-loop',
  test: (r) => r.code === 3 && /loop-design-001/.test(r.out) && /--adopt-loop/.test(r.out) && /Nothing was written/.test(r.out),
});

// ── 3. adopting is possible, on purpose ──────────────────────────────────────
const adopted = monitor(root, ['--adopt-loop']);
const loopsAfter = yaml.load(readFileSync(join(root, 'memory/loops.yaml'), 'utf8'));
ok('--adopt-loop runs inside the active loop on purpose', adopted.code === 0 && loopsAfter.active === 'loop-design-001', `exit=${adopted.code}\n${adopted.out}`);

// ── 4. the monitor's OWN loop is reused without a flag ───────────────────────
const own = buildRoot(null);
const first = monitor(own, []);
const ownLoop = yaml.load(readFileSync(join(own, 'memory/loops.yaml'), 'utf8'));
ok('a first run opens the monitor\'s own loop', first.code === 0 && !!ownLoop.active, `exit=${first.code}\n${first.out}`);
const second = monitor(own, []);
const ownLoop2 = yaml.load(readFileSync(join(own, 'memory/loops.yaml'), 'utf8'));
ok('a second run reuses that loop without --adopt-loop', second.code === 0 && ownLoop2.active === ownLoop.active && !/was not opened/.test(second.out),
  `exit=${second.code}\n${second.out}`);

// ── 5. the flow runner adopts its own flow loop explicitly ───────────────────
ok('pb-flow passes --adopt-loop for the loop it opened', /'--adopt-loop'/.test(readFileSync(resolve(repo, 'scripts/pb-flow.mjs'), 'utf8')));

for (const r of roots) { try { rmSync(r, { recursive: true, force: true }); } catch { /* temp */ } }
console.log(`\ntest-daily-monitor-help-inert: ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
