#!/usr/bin/env node
// ============================================================================
//  check-version-migration.mjs — D28: a loop from before versions becomes a closed
//  version and the next one opens, in ONE batch a person reviews before it is applied.
// ----------------------------------------------------------------------------
//  On a fixture playbook (an active legacy loop with done, open, blocked and claimed
//  tasks, plus one finished task of an even older loop):
//    1. plan    writes the batch file and NOTHING else; refuses without a stop check
//    2. review  every open task is carry (default) or park (--park); done work of the loop
//               is history; the older loop's work is left alone; a claimed card is flagged
//    3. apply   refused from an agent context (V6), refused while a card is claimed,
//               refused once the backlog moved (fingerprint), refused for a bad decision —
//               each time with nothing written
//    4. apply   (a person): the loop is now a CLOSED version marked migrated — never
//               "passed" — with its stop text as description; the next version is open;
//               carried cards moved with carried_from, parked ones stay; journal holds two
//               version rows and one migrate row; pb validate passes; pb next offers only
//               the open version's work; the same batch cannot be applied twice
//
//  Usage: node scripts/check-version-migration.mjs
// ============================================================================
import { makeSuite, makeFixture, runPb, pbJson, readJournal } from './test-fixture-playbook.mjs';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';

const t = makeSuite('version migration (D28)');
const { ok } = t;
const iso = (min) => new Date(Date.now() - min * 60_000).toISOString();

const root = t.track(makeFixture({
  prefix: 'pbmig-',
  tasks: [
    { id: 'd-old', title: 'Finished in an older loop' },
    { id: 'd1', title: 'Finished in this loop' },
    { id: 'o1', title: 'Open work to carry' },
    { id: 'o2', title: 'Open work to park' },
    { id: 'b1', title: 'Blocked work' },
    { id: 'c1', title: 'Claimed work' },
  ],
  journal: [
    { ts: iso(600), loop_id: 'loop-old-001', task: 'd-old', agent: 'lead', agent_id: 'lead', action: 'execute', status: 'done', checks: 'passed', notes: 'done long ago', seq: 1 },
    { ts: iso(60), loop_id: 'loop-fix-001', task: 'd1', agent: 'lead', agent_id: 'lead', action: 'execute', status: 'done', checks: 'passed', notes: 'done', seq: 2 },
    { ts: iso(30), loop_id: 'loop-fix-001', task: 'b1', agent: 'lead', agent_id: 'lead', action: 'triage', status: 'blocked', checks: 'none', notes: 'blocked', seq: 3 },
    { ts: iso(5), loop_id: 'loop-fix-001', task: 'c1', agent: 'lead', agent_id: 'lead', action: 'claim', status: 'in_progress', checks: 'none', notes: 'claimed', seq: 4 },
  ],
  state: {
    'd-old': { status: 'done', loop_id: 'loop-old-001', seq: 1, updated_at: iso(600) },
    d1: { status: 'done', loop_id: 'loop-fix-001', seq: 2, updated_at: iso(60) },
    b1: { status: 'blocked', loop_id: 'loop-fix-001', seq: 3, updated_at: iso(30) },
    c1: { status: 'in_progress', claimed_by: 'lead', agent_id: 'lead', loop_id: 'loop-fix-001', seq: 4, updated_at: iso(5) },
  },
  loops: `active: loop-fix-001\nloops:\n  - id: loop-old-001\n    status: done\n    goal: an older loop\n    stop: older stop\n    started_at: ${iso(2000)}\n    closed_at: ${iso(500)}\n  - id: loop-fix-001\n    status: active\n    started_at: ${iso(1000)}\n    goal: build the first room\n    stop: the room draws the backlog\n    mode: coding\n`,
}));
const BATCH = 'artifacts/versions/migration-loop-fix-001.yaml';
const answeredBrief = readFileSync(join(root, 'memory/cycle.md'), 'utf8');
const files = ['memory/backlog-state.json', 'memory/loops.yaml', 'memory/journal.ndjson', 'memory/backlog.yaml', 'memory/cycle.md'];
const fp = () => files.map((f) => { const a = join(root, f); return existsSync(a) ? `${statSync(a).size}:${readFileSync(a, 'utf8')}` : 'absent'; }).join('|');
const PERSON = { agent: 'river' };
const planArgs = ['version', 'migrate', '--loop', 'loop-fix-001', '--name', 'v0.7', '--title', 'Flow room v1', '--next', 'v0.8', '--next-title', 'Flow room v2', '--next-goal', 'the room manages versions'];

// ── 1. plan ────────────────────────────────────────────────────────────────
let before = fp();
const noCheck = runPb(root, planArgs);
ok('plan refuses a next version without an executable stop check (V5), writing nothing', noCheck.code !== 0 && /V5/.test(noCheck.combined) && fp() === before && !existsSync(join(root, BATCH)), noCheck.combined);
const plan = runPb(root, [...planArgs, '--stop-check', 'node -e process.exit(0)', '--park', 'o2']);
ok('plan writes the batch file', plan.code === 0 && existsSync(join(root, BATCH)), plan.combined);
ok('plan writes nothing else (backlog, state, loops, journal, cycle unchanged)', fp() === before);
const badPark = runPb(root, [...planArgs, '--stop-check', 'node -e process.exit(0)', '--park', 'd1', '--out', 'artifacts/versions/x.yaml']);
ok('plan refuses to park a task that is not open', badPark.code !== 0 && /V4/.test(badPark.combined), badPark.combined);

// ── 2. the batch a person reviews ──────────────────────────────────────────
const batch = yaml.load(readFileSync(join(root, BATCH), 'utf8'));
const dec = Object.fromEntries(batch.tasks.map((x) => [x.id, x.decision]));
ok('the batch names the old loop as v0.7 and the next version v0.8 with its goal and stop check',
  batch.close.loop === 'loop-fix-001' && batch.close.version === 'v0.7' && batch.close.description === 'the room draws the backlog'
  && batch.open.version === 'v0.8' && batch.open.goal === 'the room manages versions' && batch.open.stop_checks.length === 1, JSON.stringify({ close: batch.close, open: batch.open }));
ok('open tasks default to carry, --park parks, the loop\'s done work is history, the older loop\'s is left alone',
  dec.o1 === 'carry' && dec.b1 === 'carry' && dec.o2 === 'park' && dec.d1 === 'history' && dec['d-old'] === 'legacy', JSON.stringify(dec));
ok('a claimed card is flagged in the batch', /release or finish/.test(batch.tasks.find((x) => x.id === 'c1')?.note ?? ''), JSON.stringify(batch.tasks.find((x) => x.id === 'c1')));

// ── 3. apply refusals, each writing nothing ────────────────────────────────
before = fp();
const asAgent = runPb(root, ['version', 'migrate', '--apply', BATCH], { env: { PB_RUNTIME: 'opencode', PB_SESSION_ID: 's1' } });
ok('apply is refused from an agent context (V6)', asAgent.code !== 0 && /V6/.test(asAgent.combined) && fp() === before, asAgent.combined);
const claimed = runPb(root, ['version', 'migrate', '--apply', BATCH], PERSON);
ok('apply is refused while a card is claimed (V6)', claimed.code !== 0 && /c1 is claimed/.test(claimed.combined) && fp() === before, claimed.combined);
// the holder lets go: the backlog moved, so the reviewed batch is stale
const rel = runPb(root, ['release', '--task', 'c1'], { agent: 'lead' });
const released = rel.code === 0;
if (!released) {
  // no release command in this build: clear the claim the way a release would
  const sp = join(root, 'memory/backlog-state.json');
  const st = JSON.parse(readFileSync(sp, 'utf8'));
  st.c1 = { status: 'todo', loop_id: 'loop-fix-001', seq: 5, updated_at: iso(1) };
  writeFileSync(sp, JSON.stringify(st, null, 2));
}
before = fp();
const stale = runPb(root, ['version', 'migrate', '--apply', BATCH], PERSON);
ok('apply is refused once the backlog moved since the batch was written', stale.code !== 0 && /changed since this batch/.test(stale.combined) && fp() === before, stale.combined);
const fresh = runPb(root, [...planArgs, '--stop-check', 'node -e process.exit(0)', '--park', 'o2']);
ok('a fresh batch is written for review', fresh.code === 0, fresh.combined);
const reviewed = yaml.load(readFileSync(join(root, BATCH), 'utf8'));
reviewed.tasks.find((x) => x.id === 'b1').decision = 'maybe';
writeFileSync(join(root, 'artifacts/versions/bad.yaml'), yaml.dump(reviewed));
before = fp();
const bad = runPb(root, ['version', 'migrate', '--apply', 'artifacts/versions/bad.yaml'], PERSON);
ok('apply is refused for a decision other than carry or park', bad.code !== 0 && /b1: decision must be carry or park/.test(bad.combined) && fp() === before, bad.combined);
// the person's review: park b1 by hand
reviewed.tasks.find((x) => x.id === 'b1').decision = 'park';
writeFileSync(join(root, BATCH), yaml.dump(reviewed));

// ── 4. apply ───────────────────────────────────────────────────────────────
const journalBefore = readJournal(root).length;
const apply = runPb(root, ['version', 'migrate', '--apply', BATCH], PERSON);
ok('a person applies the reviewed batch', apply.code === 0 && /Migrated: v0\.7 closed/.test(apply.combined), apply.combined);
const list = pbJson(root, ['version', 'list', '--json']);
const v7 = list.versions.find((v) => v.version === 'v0.7');
const v8 = list.versions.find((v) => v.version === 'v0.8');
ok('the loop is now v0.7, closed, its stop text as description', v7?.id === 'loop-fix-001' && v7.state === 'closed' && v7.title === 'Flow room v1' && v7.description === 'the room draws the backlog', JSON.stringify(v7));
ok('v0.7 closed as migrated, never claiming a stop check passed', v7?.stop_result?.outcome === 'migrated' && v7.stop_checks.length === 0, JSON.stringify(v7?.stop_result));
ok('v0.8 is the one open version, with its goal and stop check', v8?.state === 'open' && v8.goal === 'the room manages versions' && v8.stop_checks[0] === 'node -e process.exit(0)' && list.versions.filter((v) => v.state === 'open').length === 1, JSON.stringify(v8));
ok('the older loop is still a legacy loop in History', list.legacy_loops?.some((l) => l.id === 'loop-old-001'), JSON.stringify(list.legacy_loops));
const g8 = pbJson(root, ['graph', '--json', '--version', 'v0.8']).nodes.filter((n) => (n.kind ?? 'task') === 'task');
const g7 = pbJson(root, ['graph', '--json', '--version', 'v0.7']).nodes.filter((n) => (n.kind ?? 'task') === 'task');
const n8 = Object.fromEntries(g8.map((n) => [n.id, n]));
const n7 = Object.fromEntries(g7.map((n) => [n.id, n]));
ok('carried cards are in v0.8, from v0.7', ['o1', 'c1'].every((id) => n8[id]?.carried_from === 'v0.7') && Object.keys(n8).sort().join() === 'c1,o1', JSON.stringify(Object.keys(n8)));
ok('parked and finished cards stay in v0.7; carried ones appear there as carried', n7.o2?.disposition === 'parked' && n7.b1?.disposition === 'parked' && n7.d1?.status === 'done' && n7.o1?.disposition === 'carried' && !n7['d-old'], JSON.stringify(Object.fromEntries(Object.entries(n7).map(([k, v]) => [k, v.disposition ?? v.status]))));
const rows = readJournal(root).slice(journalBefore);
ok('the journal holds two version rows and one migrate row with every assignment',
  rows.filter((r) => r.action === 'version').length === 2 && rows.filter((r) => r.action === 'migrate').length === 1
  && Object.keys(rows.find((r) => r.action === 'migrate').assignments).sort().join() === 'b1,c1,d1,o1,o2', JSON.stringify(rows.map((r) => r.action)));
const seqs = rows.map((r) => r.seq);
ok('the rows carry fresh, increasing seqs', seqs.every((s, i) => i === 0 || s > seqs[i - 1]) && seqs[0] > 4, JSON.stringify(seqs));
const state = pbJson(root, ['state', '--json']);
ok('pb state reports v0.8 open', state.version?.version === 'v0.8' && state.version.state === 'open', JSON.stringify(state.version));
const v = runPb(root, ['validate']);
ok('pb validate passes after the migration', v.code === 0, v.combined.slice(-800));
const again = runPb(root, ['version', 'migrate', '--apply', BATCH], PERSON);
ok('the same batch cannot be applied twice', again.code !== 0 && /already a version/.test(again.combined), again.combined);
// v0.8's brief was reseeded with its questions open; once a person answers them, only the
// open version's work is offered
const brief = readFileSync(join(root, 'memory/cycle.md'), 'utf8');
ok('the cycle brief was reseeded for v0.8', /the room manages versions/.test(brief), brief.slice(0, 300));
// a person answers the brief (the fixture puts back its answered one)
writeFileSync(join(root, 'memory/cycle.md'), answeredBrief);
const next = runPb(root, ['next'], { agent: 'lead' });
ok('pb next offers the open version\'s work, never a parked or closed card',
  /Next task: \[(o1|c1)\]/.test(next.combined), next.combined.slice(0, 600));
const v8row = rows.find((r) => r.action === 'version' && r.version === 'v0.8');
const lines = readFileSync(join(root, 'memory/journal.ndjson'), 'utf8').split(/\r?\n/).filter((l) => l.trim());
ok('v0.8\'s journal range starts at its own version row', JSON.parse(lines[v8.journal.first_line - 1] ?? 'null')?.seq === v8row?.seq, `first_line ${v8.journal.first_line}`);

// a carried card that depends on a parked one would wait forever (checker note, seq 291)
{
  const r2 = t.track(makeFixture({ prefix: 'pbmig2-', tasks: [{ id: 'base', title: 'parked base' }, { id: 'top', title: 'carried, depends on base', dependencies: ['base'] }] }));
  const p2 = runPb(r2, ['version', 'migrate', '--loop', 'loop-fix-001', '--name', 'v0.1', '--next', 'v0.2', '--next-goal', 'g', '--stop-check', 'node -e process.exit(0)', '--park', 'base']);
  const b2 = yaml.load(readFileSync(join(r2, 'artifacts/versions/migration-loop-fix-001.yaml'), 'utf8'));
  ok('the batch warns that a carried card depends on a parked one', p2.code === 0 && /depends on parked base/.test(b2.tasks.find((x) => x.id === 'top')?.note ?? ''), JSON.stringify(b2.tasks));
  const a2 = runPb(r2, ['version', 'migrate', '--apply', 'artifacts/versions/migration-loop-fix-001.yaml'], PERSON);
  ok('apply refuses to carry a card whose dependency is parked', a2.code !== 0 && /top → base/.test(a2.combined), a2.combined);
}

t.finish();
