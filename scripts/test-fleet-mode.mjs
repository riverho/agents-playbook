#!/usr/bin/env node
// scripts/test-fleet-mode.mjs
// ----------------------------------------------------------------------------
// Behavioral test for the `fleet` pack and the surface the mode promises.
//
//   A. THE PACK MOUNTS FROM YAML ALONE. The real modes/fleet pack is copied into
//      a temp playbook and driven by the real CLI: its skill/process resolve under
//      `fleet` and NOT under `coding`, the engine's own skills stay visible
//      (additive union), and scripts/pb.mjs contains no fleet-specific code —
//      resolution is data, not a hard-coded pack.
//
//   B. THE LOCAL SERVER SERVES THE FLOW ROOM. The mode's first promise is that
//      the person has a live room. So the REAL server (apps/flow-room/server.mjs,
//      the one `pb ui` spawns) is started against this repo and asked for the
//      room, its health, the state projection the mode polls, the change-token
//      304, and the graph. `pb ui` itself is then run where no app exists and must
//      REFUSE honestly rather than pretend to serve.
// ----------------------------------------------------------------------------

import { spawn, spawnSync, execSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tempDir, copyModules } from './lib/test-temp.mjs';

const repoRoot = process.cwd();
const PB = resolve(repoRoot, 'scripts/pb.mjs');
const SERVER = resolve(repoRoot, 'apps', 'flow-room', 'server.mjs');
const DIST_INDEX = resolve(repoRoot, 'apps', 'flow-room', 'dist', 'index.html');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.error(`  FAIL  ${name}${extra ? `\n        ${extra}` : ''}`); fail++; }
}
function done() {
  console.log(`\ntest-fleet-mode: ${pass} pass, ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}

// ============================================================================
// A. The pack mounts from YAML alone
// ============================================================================
const scratch = tempDir('pbfleet-');
for (const d of ['scripts', 'memory', 'modes', 'skills', 'processes']) mkdirSync(join(scratch, d), { recursive: true });
copyFileSync(resolve('scripts/pb.mjs'), join(scratch, 'scripts', 'pb.mjs'));
copyModules(resolve('node_modules'), join(scratch, 'node_modules'));
copyFileSync(resolve('modes/coding.yaml'), join(scratch, 'modes', 'coding.yaml'));
copyFileSync(resolve('modes/fleet.yaml'), join(scratch, 'modes', 'fleet.yaml'));
cpSync(resolve('modes/fleet'), join(scratch, 'modes', 'fleet'), { recursive: true });

writeFileSync(join(scratch, 'playbook.yaml'),
  'name: t\n' +
  'index:\n' +
  '  memory:\n' +
  '    backlog: memory/backlog.yaml\n' +
  '    journal: memory/journal.ndjson\n' +
  '    loops: memory/loops.yaml\n' +
  'default_mode: coding\n' +
  'modes:\n' +
  '  coding: modes/coding.yaml\n' +
  '  fleet: modes/fleet.yaml\n' +
  'guardrails:\n' +
  '  allowed_statuses: [todo, in_progress, blocked, done]\n');
writeFileSync(join(scratch, 'skills/index.yaml'), 'skills:\n  - {id: core, file: skills/core.md}\n');
writeFileSync(join(scratch, 'processes/index.yaml'), 'processes: []\n');
writeFileSync(join(scratch, 'memory/journal.ndjson'), '');
writeFileSync(join(scratch, 'memory/backlog.yaml'), 'tasks: []\n'); // no in_progress task pins the mode

const scratchPb = join(scratch, 'scripts', 'pb.mjs');
const setMode = (mode) => writeFileSync(join(scratch, 'memory', 'loops.yaml'),
  `active: L1\nloops:\n  - {id: L1, status: active, mode: ${mode}}\n`);
const run = (a) => execSync(`node "${scratchPb}" ${a}`, { cwd: scratch, stdio: ['ignore', 'pipe', 'pipe'] }).toString();

setMode('fleet');
let out = run('list skills');
ok('fleet-orchestration resolves under the fleet mode', /fleet-orchestration/.test(out), out);
ok('engine skill (core) still resolves under fleet (additive union)', /\bcore\b/.test(out), out);
out = run('list processes');
ok('fleet-orchestration process resolves under the fleet mode', /fleet-orchestration/.test(out), out);

setMode('coding');
out = run('list skills');
ok('fleet-orchestration is NOT visible under coding', !/fleet-orchestration/.test(out) && /\bcore\b/.test(out), out);
out = run('list processes');
ok('fleet-orchestration process is NOT visible under coding', !/fleet-orchestration/.test(out), out);

const engineSrc = readFileSync(resolve('scripts/pb.mjs'), 'utf8');
ok('scripts/pb.mjs contains no fleet-specific code (mounts purely from YAML)', !/fleet/i.test(engineSrc),
  'found "fleet" in pb.mjs — the mechanism should be data-driven, not hard-coded');

ok('`pb ui` exists as a verb and refuses honestly when no app is present', (() => {
  const empty = mkdtempSync(join(tempDir('pbfleet-noapp-'), 'empty-'));
  const r = spawnSync(process.execPath, [scratchPb, 'ui', '--port', '47311'], {
    cwd: scratch, encoding: 'utf8', env: { ...process.env, PB_APP_DIR: empty },
  });
  const said = `${r.stdout || ''}${r.stderr || ''}`;
  return r.status === 1 && /no Flow room app found/i.test(said);
})(), 'expected exit 1 naming the missing Flow room app');

// ============================================================================
// B. The local server serves the Flow room
// ============================================================================
if (!existsSync(DIST_INDEX)) {
  ok('the Flow room app is built (apps/flow-room/dist/index.html)', false, 'run: node scripts/build-app.mjs');
  done();
}
if (!existsSync(SERVER)) {
  ok('the Flow room server exists (apps/flow-room/server.mjs)', false);
  done();
}

async function startRoom() {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const port = 9750 + Math.floor(Math.random() * 200);
    const child = spawn(process.execPath, [SERVER, '--root', repoRoot, '--port', String(port), '--no-open'],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (d) => { stderr += String(d); });
    child.stdout?.on('data', () => {});
    for (let i = 0; i < 60; i += 1) {
      if (child.exitCode !== null) break;
      try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return { child, port }; } catch { /* not up */ }
      await sleep(250);
    }
    child.kill();
    if (attempt === 2) throw new Error(`the room server never answered.\n${stderr.trim()}`);
  }
  throw new Error('unreachable');
}

let room = null;
try {
  room = await startRoom();
  const base = `http://127.0.0.1:${room.port}`;

  const page = await fetch(`${base}/`);
  const html = await page.text();
  ok('the room is served at / (200 + the app shell)', page.status === 200 && /Flow room/.test(html) && /id="root"/.test(html),
    `status=${page.status}`);

  const stateRes = await fetch(`${base}/api/state`);
  const state = await stateRes.json();
  ok('GET /api/state serves the projection the mode polls', stateRes.status === 200
    && state.schema === 'agent-playbook.state.v1', JSON.stringify(state).slice(0, 200));
  ok('the projection carries the room\'s change token',
    typeof state.change_token === 'string' && !!state.change_token && typeof state.journal_seq === 'number',
    `change_token=${String(state.change_token)} journal_seq=${String(state.journal_seq)}`);

  const polled = await fetch(`${base}/api/state?since=${encodeURIComponent(state.change_token)}`);
  ok('an unchanged playbook answers 304 (the room polls a token, not the world)', polled.status === 304,
    `status=${polled.status}`);

  const graphRes = await fetch(`${base}/api/graph`);
  const graph = await graphRes.json();
  ok('GET /api/graph serves the graph schema', graphRes.status === 200
    && graph.schema === 'agent-playbook.graph.v1', JSON.stringify(graph).slice(0, 200));
} catch (err) {
  ok('the Flow room server boots and serves this playbook', false, err.message);
} finally {
  if (room) {
    room.child.kill();
    for (let i = 0; i < 40 && room.child.exitCode === null; i += 1) await sleep(100);
  }
}

done();
