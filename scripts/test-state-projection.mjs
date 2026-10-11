#!/usr/bin/env node
// scripts/test-state-projection.mjs — plan-20261010-038 (D25; rules S3, S4, S6)
// ----------------------------------------------------------------------------
//  1. pb state --json: the open version, the phase, the orchestrator, counts (needs you,
//     stale claims) and journal_seq — the change token.
//  2. pb graph --version: one version per graph (S6) — its own tasks only, its start goal,
//     its stop checks as the end goal's conditions (never evaluated by the graph); the
//     default is the open version; an unknown version is refused.
//  3. pb version list --json carries the legacy loops too (History is the whole record).
//  4. The room server: /api/state answers 304 when the room's seq is current (S4) — and
//     without running pb when the journal file is unchanged; a new row → 200 with a new seq;
//     ten refreshes of state, graph and history write nothing (S3); /api/graph?version=
//     and /api/history pass through.
//  5. A playbook without versions: the active loop is an unnamed version; --version refused.
// ----------------------------------------------------------------------------
import { spawn } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeFixture, makeSuite, pbJson, readJournal, runPb } from './test-fixture-playbook.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(ROOT, 'apps', 'flow-room', 'server.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t = makeSuite('test-state-projection');
const { ok } = t;
const iso = (minAgo) => new Date(Date.now() - minAgo * 60000).toISOString();

// a playbook with two versions: v0.1 open, v0.2 drafted
const root = t.track(makeFixture({
  prefix: 'pbstate-',
  loops: 'active: null\nloops: []\n',
  tasks: [
    { id: 'a1', title: 'v0.1 work in progress', extra: ['version: v0.1', 'kind: feature'] },
    { id: 'a2', title: 'v0.1 needs a person', manual: true, extra: ['version: v0.1', 'kind: feature'] },
    { id: 'a3', title: 'v0.1 done', extra: ['version: v0.1', 'kind: fix'] },
    { id: 'b1', title: 'v0.2 planned work', extra: ['version: v0.2', 'kind: feature'] },
  ],
}));
const mk = (args) => runPb(root, ['version', 'new', ...args]);
const v1 = mk(['--name', 'v0.1', '--goal', 'first version goal', '--stop-check', 'node -e process.exit(0)']);
const v2 = mk(['--name', 'v0.2', '--goal', 'second version goal', '--stop-check', 'node -e process.exit(0)', '--draft']);
ok('fixture: two versions created (v0.1 open, v0.2 draft)', v1.code === 0 && v2.code === 0, v1.combined + v2.combined);
// state: a1 claimed two hours ago (stale), a3 done
const statePath = join(root, 'memory/backlog-state.json');
const st = JSON.parse(readFileSync(statePath, 'utf8'));
st.a1 = { status: 'in_progress', claimed_by: 'lead', agent_id: 'lead', seq: 1, updated_at: iso(120) };
st.a3 = { status: 'done', seq: 2, updated_at: iso(60) };
(await import('node:fs')).writeFileSync(statePath, JSON.stringify(st, null, 2));
(await import('node:fs')).appendFileSync(join(root, 'memory/journal.ndjson'),
  JSON.stringify({ ts: iso(120), task: 'a1', agent: 'lead', action: 'claim', status: 'in_progress', checks: 'none', notes: 'claimed', seq: 90 }) + '\n');

// ── 1. pb state ────────────────────────────────────────────────────────────
const s1 = pbJson(root, ['state', '--json']);
ok('state names its schema and the open version', s1.schema === 'agent-playbook.state.v1' && s1.version?.version === 'v0.1' && s1.version.state === 'open', JSON.stringify(s1.version));
ok('state carries the journal seq and a change token', typeof s1.journal_seq === 'number' && s1.journal_seq >= 90 && /^\d+:\d+$/.test(s1.change_token), s1.change_token);
ok('state counts this version only: a person is needed once, one stale claim', s1.counts.needs_you === 1 && s1.counts.stale === 1 && s1.counts.in_progress === 1 && s1.counts.done === 1, JSON.stringify(s1.counts));
ok('with no orchestrator block the state says so instead of inventing one', s1.orchestrator.state === 'not-scheduled' && s1.orchestrator.last_tick === null, JSON.stringify(s1.orchestrator));

// ── 2. pb graph --version ──────────────────────────────────────────────────
const gOpen = pbJson(root, ['graph', '--json']);
ok('the default graph is the open version only (S6)', gOpen.version?.version === 'v0.1' && gOpen.nodes.filter((n) => (n.kind ?? 'task') === 'task' && n.id !== 'start' && n.id !== 'goal').map((n) => n.id).sort().join() === 'a1,a2,a3', gOpen.nodes.map((n) => n.id).join());
ok('it opens with the version\'s start goal', gOpen.start.goal === 'first version goal' && gOpen.start.version === 'v0.1', JSON.stringify(gOpen.start));
ok('it ends with the version\'s stop checks, not evaluated by the graph', gOpen.goal.conditions.length === 1 && gOpen.goal.conditions[0].command === 'node -e process.exit(0)' && gOpen.goal.conditions[0].met === null, JSON.stringify(gOpen.goal));
const g2 = pbJson(root, ['graph', '--json', '--version', 'v0.2']);
ok('--version v0.2 draws only v0.2', g2.version?.version === 'v0.2' && g2.nodes.map((n) => n.id).includes('b1') && !g2.nodes.map((n) => n.id).includes('a1') && g2.start.goal === 'second version goal');
const bad = runPb(root, ['graph', '--json', '--version', 'v9']);
ok('an unknown version is refused, naming the versions', bad.code !== 0 && /No version named v9\. Versions: v0\.1, v0\.2/.test(bad.err), bad.combined);

// ── 3. history data ────────────────────────────────────────────────────────
const h = pbJson(root, ['version', 'list', '--json']);
ok('version list carries every version and the legacy loops', h.versions.map((v) => v.version).join() === 'v0.1,v0.2' && Array.isArray(h.legacy_loops), JSON.stringify(h).slice(0, 300));

// ── 4. the room server ─────────────────────────────────────────────────────
const port = 9500 + Math.floor(Math.random() * 400);
const server = spawn(process.execPath, [SERVER, '--root', root, '--port', String(port), '--no-open'], { stdio: 'ignore' });
const base = `http://127.0.0.1:${port}`;
try {
  for (let i = 0; i < 50; i += 1) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* not up */ } await sleep(200); }
  const first = await fetch(`${base}/api/state`);
  const body = await first.json();
  ok('/api/state answers the projection', first.status === 200 && body.journal_seq === s1.journal_seq, JSON.stringify(body).slice(0, 200));
  const journal = join(root, 'memory/journal.ndjson');
  const before = { rows: readJournal(root).length, mtime: statSync(journal).mtimeMs };
  let notModified = 0;
  for (let i = 0; i < 10; i += 1) {
    const r = await fetch(`${base}/api/state?since=${encodeURIComponent(body.change_token)}`);
    if (r.status === 304) notModified += 1;
    await (await fetch(`${base}/api/graph`)).text();
    await (await fetch(`${base}/api/history`)).text();
  }
  ok('a refresh with nothing new answers 304 (S4)', notModified === 10, `${notModified}/10`);
  ok('ten refreshes of state, graph and history wrote nothing (S3)', readJournal(root).length === before.rows && statSync(journal).mtimeMs === before.mtime);
  runPb(root, ['comment', '--task', 'a1', '--text', 'a new row arrives'], { agent: 'human' });
  const after = await fetch(`${base}/api/state?since=${encodeURIComponent(body.change_token)}`);
  const afterBody = after.status === 200 ? await after.json() : null;
  ok('a new journal row → 200 with a new change token', after.status === 200 && afterBody.change_token !== body.change_token, `${after.status} ${afterBody?.change_token}`);
  const gv = await (await fetch(`${base}/api/graph?version=v0.2`)).json();
  ok('/api/graph?version= passes the version through', gv.version?.version === 'v0.2', JSON.stringify(gv.version));
  const badV = await fetch(`${base}/api/graph?version=${encodeURIComponent('v0.1;rm')}`);
  ok('/api/graph rejects a version that is not a name', badV.status === 400);
  const hist = await (await fetch(`${base}/api/history`)).json();
  ok('/api/history passes pb version list through', hist.versions?.length === 2 && Array.isArray(hist.legacy_loops));
} finally { server.kill(); }

// ── 5. a playbook without versions ─────────────────────────────────────────
const plain = t.track(makeFixture({ prefix: 'pbstate-plain-', tasks: [{ id: 'p1' }] }));
const sp = pbJson(plain, ['state', '--json']);
ok('without versions the active loop is an unnamed version', sp.version?.unnamed === true && sp.version.version === null && sp.version.id === 'loop-fix-001', JSON.stringify(sp.version));
ok('without versions the graph has no version and draws everything', pbJson(plain, ['graph', '--json']).version === null);
ok('without versions --version is refused', runPb(plain, ['graph', '--json', '--version', 'v1']).code !== 0);

t.finish();
