#!/usr/bin/env node
// scripts/test-tick.mjs — plan-20261010-039 (D27; rules O1–O3, V8)
// ----------------------------------------------------------------------------
//  O1  the same journal, backlog and clock give the same plan (--dry-run twice, diffed),
//      and a dry run writes nothing;
//  O3  every tick writes exactly ONE tick row — including a tick that did nothing, and why;
//  O2  a tick never answers a decision, opens or closes a version, merges, or plans work;
//  and the pass itself: it releases a quiet claim, asks an unanswered question (and asks
//  again only on schedule), routes around blocked / waiting / failing work with one
//  defer row each (not repeated tick after tick), proposes the next task without
//  starting anything, stops when paused, and proposes — never performs — the close.
//  V8: with no open version the tick does nothing but record why.
// ----------------------------------------------------------------------------
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, makeSuite, pbJson, readJournal, runPb } from './test-fixture-playbook.mjs';

const t = makeSuite('test-tick');
const { ok } = t;
const NOW = Date.parse('2026-10-12T12:00:00.000Z');
const at = (min) => new Date(NOW + min * 60000).toISOString();
const ORCH = '\norchestrator:\n  every_minutes: 15\n  stale_claim_minutes: 30\n  reprompt_minutes: [60, 240, 1440]\n';

function versionedFixture(tasks, { orchestrator = ORCH, open = true, stopCheck = 'node -e process.exit(0)' } = {}) {
  const root = t.track(makeFixture({ prefix: 'pbtick-', loops: 'active: null\nloops: []\n', tasks: tasks.map((x) => ({ ...x, extra: [...(x.extra || []), 'version: v0.1', 'kind: feature'] })) }));
  appendFileSync(join(root, 'playbook.yaml'), orchestrator);
  const v = runPb(root, ['version', 'new', '--name', 'v0.1', '--goal', 'the fixture goal', '--stop-check', stopCheck, ...(open ? [] : ['--draft'])]);
  if (v.code !== 0) throw new Error(v.combined);
  return root;
}
function setState(root, patch, rows = []) {
  const f = join(root, 'memory/backlog-state.json');
  const st = JSON.parse(readFileSync(f, 'utf8'));
  writeFileSync(f, JSON.stringify({ ...st, ...patch }, null, 2));
  for (const r of rows) appendFileSync(join(root, 'memory/journal.ndjson'), JSON.stringify(r) + '\n');
}
const tick = (root, args = [], minutes = 0) => runPb(root, ['tick', '--now', at(minutes), ...args], { agent: 'cron' });

// ── the main fixture ───────────────────────────────────────────────────────
const root = versionedFixture([
  { id: 'blk', title: 'blocked work', priority: 1 },
  { id: 'ask', title: 'Publish the package or close it', priority: 1, manual: true, extra: ['human:', '      question: "Publish 0.6.2, or close it as superseded?"', '      options:', '        - { id: publish, label: Publish, effect: "a person publishes" }', '        - { id: close, label: Close, effect: "closed as superseded" }', '      recommended: close', '      recommended_by: lead'] },
  { id: 'red', title: 'failed its checks twice', priority: 1 },
  { id: 'quiet', title: 'a claim nobody touched for two hours', priority: 3 },
  { id: 'next', title: 'the next claimable task', priority: 2 },
  { id: 'later', title: 'lower priority work', priority: 5 },
]);
setState(root, {
  blk: { status: 'blocked', seq: 1, updated_at: at(-300) },
  quiet: { status: 'in_progress', claimed_by: 'worker-1', agent_id: 'worker-1', claim_token: 'tok-q', seq: 2, updated_at: at(-120) },
}, [
  { ts: at(-200), task: 'red', agent: 'lead', action: 'execute', status: 'blocked', checks: 'failed', notes: 'first red', seq: 10 },
  { ts: at(-150), task: 'red', agent: 'lead', action: 'execute', status: 'blocked', checks: 'failed', notes: 'second red', seq: 11 },
  { ts: at(-120), task: 'quiet', agent: 'worker-1', action: 'claim', status: 'in_progress', checks: 'none', notes: 'claimed', seq: 12 },
]);

// O1 + dry run
{
  const before = readFileSync(join(root, 'memory/journal.ndjson'), 'utf8');
  const a = pbJson(root, ['tick', '--dry-run', '--json', '--now', at(0)]);
  const b = pbJson(root, ['tick', '--dry-run', '--json', '--now', at(0)]);
  ok('O1: two dry runs on the same inputs give the same plan', JSON.stringify(a) === JSON.stringify(b), JSON.stringify(a).slice(0, 300));
  ok('a dry run writes nothing', readFileSync(join(root, 'memory/journal.ndjson'), 'utf8') === before);
  ok('the plan releases the quiet claim', a.release.map((x) => x.task).join() === 'quiet' && a.release[0].quiet_minutes === 120, JSON.stringify(a.release));
  ok('the plan asks the open question, with the recommendation', a.ask.length === 1 && a.ask[0].task === 'ask' && a.ask[0].question === 'Publish 0.6.2, or close it as superseded?' && a.ask[0].recommended === 'close', JSON.stringify(a.ask));
  ok('the plan routes around blocked, waiting and failing work', a.defer.map((x) => `${x.task}:${x.reason}`).sort().join('|') === 'ask:waiting on your decision|blk:blocked|red:failed its checks twice', JSON.stringify(a.defer));
  ok('the plan proposes the next task, and starts nothing', a.chosen?.task === 'next' && a.dispatch?.mode === 'propose', JSON.stringify(a.dispatch));
}

// the real tick: O3 + effects + O2
{
  const before = readJournal(root).length;
  const r = tick(root);
  const rows = readJournal(root).slice(before);
  const ticks = rows.filter((x) => x.action === 'tick');
  ok('O3: one tick row', r.code === 0 && ticks.length === 1 && ticks[0].agent === 'orchestrator', r.combined + JSON.stringify(rows.map((x) => x.action)));
  ok('the quiet claim is released, in the orchestrator\'s voice with the reason', rows.some((x) => x.action === 'release' && x.task === 'quiet' && x.agent === 'orchestrator' && /no journal row for 120 min/.test(x.notes)));
  ok('…and the card is back in the pool', pbJson(root, ['graph', '--json']).nodes.find((n) => n.id === 'quiet').status === 'todo');
  ok('the question is asked as a question row', rows.some((x) => x.action === 'ask' && x.task === 'ask' && x.intent === 'question' && x.attempt === 1));
  ok('each routed-around card gets a defer row naming the choice', ['blk', 'ask', 'red'].every((id) => rows.some((x) => x.action === 'defer' && x.task === id && x.chose === 'next' && /took next instead/.test(x.notes))));
  ok('O2: the tick answered nothing, closed nothing, merged nothing, planned nothing', !rows.some((x) => ['decide', 'version', 'merge', 'spawn', 'claim', 'execute'].includes(x.action)), rows.map((x) => x.action).join());
  ok('O2: the version is still open', pbJson(root, ['version', 'list', '--json']).versions[0].state === 'open');
  ok('the state bar sees the tick', pbJson(root, ['state', '--json']).orchestrator.last_tick?.summary.startsWith('Tick:'));
}

// the next ticks: no repeats; the question re-asked only on schedule
{
  const before = readJournal(root).length;
  tick(root, [], 10);
  const rows = readJournal(root).slice(before);
  ok('ten minutes later: one tick row, no repeated defer or ask', rows.length === 1 && rows[0].action === 'tick', rows.map((x) => `${x.action}:${x.task}`).join());
  const b2 = readJournal(root).length;
  tick(root, [], 61);
  const again = readJournal(root).slice(b2).filter((x) => x.action === 'ask');
  ok('an hour later the question is asked again (attempt 2)', again.length === 1 && again[0].attempt === 2 && /^Asking again \(2\)/.test(again[0].notes), JSON.stringify(again));
}

// stop conditions
{
  const none = t.track(makeFixture({ prefix: 'pbtick-none-', loops: 'active: null\nloops: []\n', tasks: [{ id: 'x' }] }));
  const before = readJournal(none).length;
  const r = tick(none);
  const rows = readJournal(none).slice(before);
  ok('V8: with no open version the tick does nothing but record why', r.code === 0 && rows.length === 1 && rows[0].action === 'tick' && rows[0].tick.stop_reason === 'no-open-version', JSON.stringify(rows));

  const paused = versionedFixture([{ id: 'p' }], { orchestrator: '\norchestrator:\n  paused: true\n' });
  const bp = readJournal(paused).length;
  tick(paused);
  const prow = readJournal(paused).slice(bp);
  ok('a paused orchestrator records one row and does nothing', prow.length === 1 && prow[0].tick.stop_reason === 'paused');

  const draft = versionedFixture([{ id: 'd' }], { open: false });
  const rd = pbJson(draft, ['tick', '--dry-run', '--json', '--now', at(0)]);
  ok('an unopened (draft) version is never adopted', rd.stop_reason === 'no-open-version' || rd.stop_reason === 'version-draft', rd.stop_reason);
}
// the end goal: propose closing, never close
{
  const done = versionedFixture([{ id: 'only' }]);
  setState(done, { only: { status: 'done', seq: 3, updated_at: at(-5) } });
  const before = readJournal(done).length;
  tick(done);
  const rows = readJournal(done).slice(before);
  ok('all done + stop checks pass → it proposes closing', rows.length === 1 && rows[0].tick.stop_reason === 'goal-met-propose-close' && /a person closes/.test(rows[0].notes), JSON.stringify(rows));
  ok('O2: …and the version stays open', pbJson(done, ['version', 'list', '--json']).versions[0].state === 'open');
}

// checker finding (seq 289): a quiet journal is not a dead worker — a claim whose tracked
// process is still running (a lifecycle lease, or a live pid) is never released
{
  const r = versionedFixture([{ id: 'busy', title: 'a worker is running, quietly' }, { id: 'gone', title: 'its worker is gone' }]);
  const loopId = pbJson(r, ['state', '--json']).version.id;
  setState(r, {
    busy: { status: 'in_progress', claimed_by: 'w1', agent_id: 'w1', claim_token: 'tok-b', seq: 2, updated_at: at(-120) },
    gone: { status: 'in_progress', claimed_by: 'w2', agent_id: 'w2', claim_token: 'tok-g', seq: 3, updated_at: at(-120) },
  }, [
    { ts: at(-120), task: 'busy', agent: 'w1', action: 'claim', status: 'in_progress', checks: 'none', notes: 'claimed', seq: 20 },
    { ts: at(-120), task: 'gone', agent: 'w2', action: 'claim', status: 'in_progress', checks: 'none', notes: 'claimed', seq: 21 },
  ]);
  appendFileSync(join(r, 'memory/processes.ndjson'),
    JSON.stringify({ ts: at(-120), loop_id: loopId, task: 'busy', pid: process.pid, status: 'running', lifecycle_lease: true }) + '\n'
    + JSON.stringify({ ts: at(-120), loop_id: loopId, task: 'gone', pid: 2147480000, status: 'running' }) + '\n');
  const p = pbJson(r, ['tick', '--dry-run', '--json', '--now', at(0)]);
  ok('a claim whose worker process still runs is not released; a dead one is', p.release.map((x) => x.task).join() === 'gone', JSON.stringify(p.release));
}
// checker finding (seq 289): --dry-run does not run the version's stop checks
{
  const r = versionedFixture([{ id: 'only', title: 'the only task' }], { stopCheck: 'node -e "require(\'fs\').writeFileSync(\'side-effect.txt\',\'x\')"' });
  setState(r, { only: { status: 'done', seq: 2, updated_at: at(-10) } });
  const p = pbJson(r, ['tick', '--dry-run', '--json', '--now', at(0)]);
  ok('a dry run does not run the stop checks; it says they would run', !existsSync(join(r, 'side-effect.txt')) && p.goal_check?.ran === false && p.goal_check.would_run?.length === 1, JSON.stringify(p.goal_check));
  const real = tick(r, ['--json']);
  ok('a real tick runs them', existsSync(join(r, 'side-effect.txt')), real.combined.slice(0, 400));
}

t.finish();
