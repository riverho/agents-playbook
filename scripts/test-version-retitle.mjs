#!/usr/bin/env node
// test-version-retitle — `pb version retitle` corrects a version's words by APPENDING.
//
//   1. a person retitles a CLOSED version: the title changes everywhere it is read, the
//      version stays closed with its proof, and the old title stays on the record;
//   2. the open version's goal and stop change, and pb state / pb graph read the new words;
//   3. the journal only grows: every earlier row is byte-identical, one version row per retitle;
//   4. refusals write nothing: an agent context, an unknown version, no --reason, an empty
//      field, no field, and a retitle that changes nothing.

import { makeSuite, makeFixture, runPb, pbJson, readJournal } from './test-fixture-playbook.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const t = makeSuite('version retitle');
const { ok } = t;
const PERSON = { agent: 'river' };
const root = t.track(makeFixture({ prefix: 'pbretitle-', loops: 'active: null\nloops: []\n', tasks: [] }));
const journalText = () => readFileSync(join(root, 'memory/journal.ndjson'), 'utf8');
const pass = 'node -e process.exit(0)';

const mk1 = runPb(root, ['version', 'new', '--name', 'v0.1', '--title', 'Flow room v1', '--goal', 'build the room', '--stop-check', pass], PERSON);
const close1 = runPb(root, ['version', 'close'], PERSON);
const mk2 = runPb(root, ['version', 'new', '--name', 'v0.2', '--title', 'Flow room v2', '--goal', 'build the room again', '--stop', 'the room is built again', '--stop-check', pass], PERSON);
ok('fixture: v0.1 closed, v0.2 open', mk1.code === 0 && close1.code === 0 && mk2.code === 0, `${mk1.combined}${close1.combined}${mk2.combined}`.slice(0, 600));

const list = () => pbJson(root, ['version', 'list', '--json']).versions;
const v = (name) => list().find((x) => x.version === name);
const before = v('v0.1');

// ── 1. a closed version gets its real name ─────────────────────────────────────────
const j0 = journalText();
const r1 = runPb(root, ['version', 'retitle', 'v0.1', '--title', 'Flow room v2 build', '--reason', 'it holds the v2 build'], PERSON);
ok('a person retitles a closed version', r1.code === 0, r1.combined.slice(0, 400));
const after = v('v0.1');
ok('the new title is what pb version list reads', after.title === 'Flow room v2 build', after.title);
ok('it stays closed, with its proof and its range', after.state === 'closed' && after.stop_result?.outcome === before.stop_result?.outcome &&
  JSON.stringify(after.journal) === JSON.stringify(before.journal) && after.closed_at === before.closed_at, JSON.stringify(after).slice(0, 500));
ok('the old title stays on the record', after.retitles?.length === 1 && after.retitles[0].was.title === 'Flow room v1' &&
  after.retitles[0].now.title === 'Flow room v2 build' && after.retitles[0].reason === 'it holds the v2 build' && after.retitles[0].by === 'river',
  JSON.stringify(after.retitles));
const j1 = journalText();
ok('the journal only grew: every earlier byte is unchanged', j1.startsWith(j0), 'an earlier row changed');
const added = readJournal(root).slice(j0.split(/\r?\n/).filter((l) => l.trim()).length);
ok('exactly one row was appended, a version row naming the change', added.length === 1 && added[0].action === 'version' &&
  added[0].retitle?.was?.title === 'Flow room v1' && /retitled/.test(added[0].notes), JSON.stringify(added));
ok('pb version list prints the new title', /v0\.1 · Flow room v2 build · closed/.test(runPb(root, ['version', 'list']).out));
const g1 = pbJson(root, ['graph', '--json', '--version', 'v0.1']);
ok('the graph of the closed version carries the new title and its history', g1.version?.title === 'Flow room v2 build' && g1.version?.retitles?.length === 1,
  JSON.stringify(g1.version));

// ── 2. the open version's goal and stop ───────────────────────────────────────────
const r2 = runPb(root, ['version', 'retitle', 'v0.2', '--goal', 'harden what was built', '--stop', 'every card done or dropped', '--reason', 'the goal repeated v0.1'], PERSON);
ok('a person corrects the open version\'s goal and stop', r2.code === 0, r2.combined.slice(0, 400));
const s2 = pbJson(root, ['state', '--json']);
ok('pb state reads the new goal and keeps the version open', s2.version?.goal === 'harden what was built' && s2.version?.state === 'open', JSON.stringify(s2.version));
const g2 = pbJson(root, ['graph', '--json']);
ok('the graph\'s start card reads the new goal and stop', g2.start?.goal === 'harden what was built' && g2.start?.stop === 'every card done or dropped', JSON.stringify(g2.start));
const v2 = v('v0.2');
ok('only the fields given changed; the title is untouched', v2.title === 'Flow room v2' && v2.retitles?.length === 1 &&
  Object.keys(v2.retitles[0].was).sort().join() === 'goal,stop' && v2.retitles[0].was.goal === 'build the room again', JSON.stringify(v2.retitles));
const r3 = runPb(root, ['version', 'retitle', 'v0.1', '--title', 'Flow room, the v2 build', '--reason', 'clearer'], PERSON);
const v1b = v('v0.1');
ok('a second retitle appends to the history, oldest first', r3.code === 0 && v1b.retitles?.length === 2 && v1b.retitles[0].was.title === 'Flow room v1' &&
  v1b.retitles[1].was.title === 'Flow room v2 build', JSON.stringify(v1b.retitles));
ok('the active version did not move', pbJson(root, ['state', '--json']).version?.version === 'v0.2');
const val = runPb(root, ['validate']);
ok('pb validate passes after retitles', val.code === 0, val.combined.slice(-600));

// ── 3. refusals write nothing ─────────────────────────────────────────────────────
const refused = (label, args, opts = PERSON, re = /./) => {
  const jBefore = journalText();
  const loopsBefore = readFileSync(join(root, 'memory/loops.yaml'), 'utf8');
  const r = runPb(root, ['version', 'retitle', ...args], opts);
  ok(`refuses ${label}, and writes nothing`, r.code !== 0 && re.test(r.combined) && journalText() === jBefore &&
    readFileSync(join(root, 'memory/loops.yaml'), 'utf8') === loopsBefore, `exit ${r.code}: ${r.combined.slice(0, 300)}`);
};
refused('an agent context (V6)', ['v0.1', '--title', 'x', '--reason', 'r'], { agent: 'lead', env: { PB_RUNTIME: 'opencode' } }, /V6: .*person/);
refused('an unknown version', ['v9.9', '--title', 'x', '--reason', 'r'], PERSON, /existing version/);
refused('a retitle without --reason', ['v0.1', '--title', 'x'], PERSON, /--reason/);
refused('an empty title', ['v0.1', '--title', '  ', '--reason', 'r'], PERSON, /cannot be empty/);
refused('no field to change', ['v0.1', '--reason', 'r'], PERSON, /--title, --goal, --stop or --stop-check/);
refused('a retitle that changes nothing', ['v0.1', '--title', 'Flow room, the v2 build', '--reason', 'r'], PERSON, /Nothing changes/);

// ── 4. it is discoverable ─────────────────────────────────────────────────────────
ok('pb help documents version retitle', /version retitle <version>/.test(runPb(root, ['help']).combined));

t.finish();
