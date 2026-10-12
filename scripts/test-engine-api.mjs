#!/usr/bin/env node
// scripts/test-engine-api.mjs
// ----------------------------------------------------------------------------
// The engine must be usable two ways from ONE implementation:
//   1. as a CLI (`node scripts/pb.mjs <cmd>`), which is the primary surface;
//   2. as an import (`import { api, paths } from './scripts/pb.mjs'`), so a host
//      runtime (the DeepSeek Harness plugin) reads the canonical JSON projections
//      instead of scraping human text.
// Two regressions this pins:
//   - the CLI dispatch must NOT run on import (a stray `process.argv` read or an
//     unguarded switch would execute a command — or crash — merely by importing);
//   - the API must expose the SAME truth as the CLI, not a parallel implementation.
// Mutations are deliberately absent from the in-process API: every `pb` command
// calls `process.exit()` on refusal, which would kill a host process rather than
// return an error. This test asserts that boundary explicitly.
// ----------------------------------------------------------------------------

import { mkdirSync, mkdtempSync, copyFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tempDir, copyModules } from './lib/test-temp.mjs';

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.error(`  FAIL  ${name}${extra ? `\n        ${extra}` : ''}`); fail++; }
}

const root = tempDir('pbapi-');
for (const d of ['scripts', 'memory', 'modes']) mkdirSync(join(root, d), { recursive: true });
copyFileSync(resolve('scripts/pb.mjs'), join(root, 'scripts/pb.mjs'));
copyModules(resolve('node_modules'), join(root, 'node_modules'));

writeFileSync(join(root, 'playbook.yaml'),
  'name: api-test\nversion: 9.9.9\nentry: SKILL.md\n' +
  'paths:\n  scripts: scripts\n  memory: memory\n  modes: modes\n  artifacts: artifacts\n  reports: artifacts/reports\n' +
  'index:\n  cli: scripts/pb.mjs\n  memory:\n    backlog: memory/backlog.yaml\n    journal: memory/journal.ndjson\n    loops: memory/loops.yaml\n    cycle: memory/cycle.md\n' +
  'loop:\n  description: test\n  steps:\n    - id: orient\n      do: orient\n      command: node scripts/pb.mjs status\n' +
  'default_mode: coding\nmodes:\n  coding: modes/coding.yaml\n' +
  'guardrails:\n  allowed_statuses: [todo, in_progress, blocked, done]\n');
writeFileSync(join(root, 'modes/coding.yaml'), 'id: coding\ndirective: ""\n');
writeFileSync(join(root, 'memory/journal.ndjson'), JSON.stringify({
  seq: 1, ts: '2026-01-01T00:00:01.000Z', loop_id: 'L1', task: 'A', agent: 'alice',
  action: 'claim', status: 'in_progress', claimed_by: 'alice',
}) + '\n');
writeFileSync(join(root, 'memory/loops.yaml'), 'active: L1\nloops:\n  - {id: L1, status: active}\n');
writeFileSync(join(root, 'memory/cycle.md'), '# c\n## 5. Do I have any conflicting memory?\nNone\n');
writeFileSync(join(root, 'memory/backlog.yaml'),
  'tasks:\n' +
  '  - {id: A, title: claimed, status: todo, priority: 1, skill: run-task}\n' +
  '  - {id: B, title: queued, status: todo, priority: 2}\n');
writeFileSync(join(root, 'memory/backlog-state.json'), JSON.stringify({
  A: { status: 'in_progress', claimed_by: 'alice', agent_id: 'alice', claimed_at: '2026-01-01T00:00:01.000Z', loop_id: 'L1', seq: 1, updated_by: 'alice' },
  __seq: 1, __journal_seq: 1, __written_at: '2026-01-01T00:00:01.000Z', __written_by: 'alice',
}, null, 2) + '\n');

const pbPath = join(root, 'scripts/pb.mjs');
const importUrl = `file:///${pbPath.replace(/\\/g, '/')}`;

// --- 1. importing the engine is side-effect free ------------------------------
{
  // If import ran the CLI, a bare import would print help (or crash on a missing
  // command) and exit non-zero. It must do neither.
  const r = spawnSync(process.execPath, ['-e',
    `import('${importUrl}').then(m => { console.log('IMPORTED:' + m.api.schema); }).catch(e => { console.error('ERR:' + e.message); process.exit(3); })`,
  ], { cwd: root, encoding: 'utf8' });
  ok('importing the engine does not execute a command', r.status === 0 && /IMPORTED:agent-playbook\.api\.v1/.test(r.stdout),
    `exit=${r.status} out=${r.stdout} err=${r.stderr}`);
  ok('importing the engine prints no human CLI output',
    !/pb — Agent-Playbook loop CLI|Usage: pb/.test(r.stdout), r.stdout.slice(0, 200));
}

// --- 2. the API exposes the same truth as the CLI -----------------------------
{
  const r = spawnSync(process.execPath, ['-e', `
    const m = await import('${importUrl}');
    const out = {
      version: m.api.version,
      name: m.api.name,
      counts: m.api.status().backlog.counts,
      tasks: m.api.tasks().map(t => t.id + ':' + t.status),
      next: m.api.nextClaimable().task?.id ?? null,
      journalRows: m.api.journal().length,
      loop: m.api.activeLoop()?.id ?? null,
      validateFailures: m.api.validate().length,
      drift: m.api.stateDrift().drift.length,
      pathKeys: Object.keys(m.paths).sort(),
    };
    console.log(JSON.stringify(out));
  `], { cwd: root, encoding: 'utf8' });
  let out = {};
  try { out = JSON.parse(r.stdout); } catch { /* reported below */ }
  ok('the API reports the master identity', out.version === '9.9.9' && out.name === 'api-test', JSON.stringify(out).slice(0, 200));
  ok('the API merges the state projection into task status (same as the CLI)',
    out.tasks?.includes('A:in_progress') && out.tasks?.includes('B:todo'), JSON.stringify(out.tasks));
  ok('the API reports backlog counts identical to `pb status`', out.counts?.in_progress === 1 && out.counts?.todo === 1,
    JSON.stringify(out.counts));
  ok('the API selects the same next claimable task the CLI would', out.next === 'B', `next=${out.next}`);
  ok('the API reads the journal', out.journalRows === 1, `rows=${out.journalRows}`);
  ok('the API reads loop epochs', out.loop === 'L1', `loop=${out.loop}`);
  ok('the API exposes resolved paths for a host to consume',
    Array.isArray(out.pathKeys) && out.pathKeys.includes('journal') && out.pathKeys.includes('backlogState'),
    JSON.stringify(out.pathKeys));
  const cli = spawnSync(process.execPath, [pbPath, 'status', '--json'], { cwd: root, encoding: 'utf8' });
  const cliJson = JSON.parse(cli.stdout);
  ok('API and CLI agree on the backlog counts (one implementation, not two)',
    JSON.stringify(out.counts) === JSON.stringify(cliJson.backlog.counts),
    `api=${JSON.stringify(out.counts)} cli=${JSON.stringify(cliJson.backlog.counts)}`);
}

// --- 3. mutations stay on the CLI (exit codes are the contract) ---------------
{
  const r = spawnSync(process.execPath, ['-e', `
    const m = await import('${importUrl}');
    const names = Object.keys(m.api);
    console.log(JSON.stringify(names));
  `], { cwd: root, encoding: 'utf8' });
  const names = JSON.parse(r.stdout);
  const mutators = names.filter((n) => /^(claim|record|release|plan|loopNew|workerCreate)$/.test(n));
  ok('the in-process API exposes no mutating verbs', mutators.length === 0,
    `unexpected mutators: ${mutators.join(',')} (in ${names.join(',')})`);
  ok('the API still exposes the read helpers a host needs',
    ['status', 'tasks', 'task', 'journal', 'validate', 'workerStatus', 'mergeReady', 'claimOwnership']
      .every((n) => names.includes(n)), names.join(','));
}

// --- 4. the CLI path is unchanged by the guard --------------------------------
{
  const help = spawnSync(process.execPath, [pbPath, 'help'], { cwd: root, encoding: 'utf8' });
  ok('invoking the CLI still dispatches commands', help.status === 0 && /loop CLI/.test(help.stdout), `exit=${help.status}`);
  const unknown = spawnSync(process.execPath, [pbPath, 'definitely-not-a-command'], { cwd: root, encoding: 'utf8' });
  ok('an unknown command still exits non-zero', unknown.status === 1, `exit=${unknown.status}`);
  const status = spawnSync(process.execPath, [pbPath, 'status', '--json'], { cwd: root, encoding: 'utf8' });
  const payload = JSON.parse(status.stdout);
  ok('the CLI JSON surface is still parseable (stdout is a machine channel)',
    payload.schema === 'agent-playbook.status.v1', status.stdout.slice(0, 200));
}

console.log(`\ntest-engine-api: ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
