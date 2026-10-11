#!/usr/bin/env node
// scripts/test-comment-intent.mjs — plan-20261010-032 (D16; contract K2, M2, M3)
// ----------------------------------------------------------------------------
//  1. `pb comment --intent steer|question|finding|comment` stamps the intent on the row;
//     no --intent means `comment`; an unknown intent is REFUSED and writes nothing.
//  2. pb graph carries the human-facing text with its documented fallbacks, each saying
//     where it came from:
//       headline        task's own, else the title's first sentence cut at a word (≤ 72)
//       now             task's own, else "Nobody has picked this up" for untouched todo,
//                       else the newest row's summary
//       journal[].summary  the row's own, else its first sentence, out of all-caps
//       check_names     task's check_names, else the script's file name in words
// ----------------------------------------------------------------------------
import { makeFixture, makeSuite, pbJson, readJournal, runPb } from './test-fixture-playbook.mjs';

const t = makeSuite('test-comment-intent');
const { ok } = t;
const LONG = 'Engine (D16): headline, now, journal summary and check names in pb graph with the documented fallbacks, and much more prose after that';

const root = t.track(makeFixture({
  tasks: [
    { id: 'plain', title: LONG, checks: ['node scripts/test-graph-layers-live.mjs', 'npm --prefix apps/flow-room test'] },
    { id: 'named', title: 'Short title', extra: ['headline: "Kill the check tree"', 'now: "writing the test"', 'check_names: ["the tree dies"]'] },
    { id: 'worked', title: 'A task with history' },
  ],
  journal: [
    { ts: new Date().toISOString(), loop_id: 'loop-fix-001', task: 'worked', agent: 'lead', action: 'implement', status: 'in_progress', checks: 'none', notes: 'DEMONSTRATED the fix, not just described it. More detail here.', seq: 1 },
  ],
  state: { worked: { status: 'in_progress', claimed_by: 'lead', agent_id: 'lead', seq: 1, loop_id: 'loop-fix-001' } },
}));

// ── 1. intent ──────────────────────────────────────────────────────────────
for (const intent of ['steer', 'question', 'finding', 'comment']) {
  const r = runPb(root, ['comment', '--task', 'plain', '--text', `a ${intent} from a person`, '--intent', intent], { agent: 'human' });
  const row = readJournal(root).pop();
  ok(`--intent ${intent} is stamped on the row`, r.code === 0 && row.action === 'comment' && row.intent === intent && row.notes === `a ${intent} from a person`, r.combined + JSON.stringify(row));
}
{
  const r = runPb(root, ['comment', '--task', 'plain', '--text', 'no intent given'], { agent: 'human' });
  ok('no --intent means comment', r.code === 0 && readJournal(root).pop().intent === 'comment', r.combined);
}
{
  const before = readJournal(root).length;
  const r = runPb(root, ['comment', '--task', 'plain', '--text', 'bad', '--intent', 'shout'], { agent: 'human' });
  ok('an unknown intent is refused', r.code !== 0 && /--intent must be one of/.test(r.combined), r.combined);
  ok('a refused comment writes nothing', readJournal(root).length === before);
}
{
  const g = pbJson(root, ['graph', '--json']);
  const plain = g.nodes.find((n) => n.id === 'plain');
  ok('pb graph shows each row\'s intent', plain.journal.filter((r) => r.action === 'comment').map((r) => r.intent).join() === 'steer,question,finding,comment,comment');
}

// ── 2. text fields and fallbacks ───────────────────────────────────────────
{
  const g = pbJson(root, ['graph', '--json']);
  const n = (id) => g.nodes.find((x) => x.id === id);
  const plain = n('plain'), named = n('named'), worked = n('worked');
  if (!('headline' in plain)) { ok('pb graph carries headline/now/check_names', false, Object.keys(plain).join(', ')); t.finish(); }
  ok('a declared headline wins', named.headline === 'Kill the check tree' && named.headline_source === 'task');
  ok('a fallback headline is at most 72 characters', plain.headline.length <= 72 && plain.headline_source === 'title', plain.headline);
  const body = plain.headline.replace(/…$/, '');
  ok('a fallback headline never cuts a word', LONG.startsWith(body) && /[\s.,;:)—-]/.test(LONG.charAt(body.length)), plain.headline);
  ok('a declared now wins', named.now === 'writing the test' && named.now_source === 'task');
  ok('a worked task\'s now is its newest row\'s summary', worked.now === 'Demonstrated the fix, not just described it.' && worked.now_source === 'journal', JSON.stringify([worked.now, worked.now_source]));
  ok('a row summary is the first sentence, out of all-caps', worked.journal[0].summary === 'Demonstrated the fix, not just described it.', worked.journal[0].summary);
  ok('the row\'s own notes are untouched', worked.journal[0].notes.startsWith('DEMONSTRATED'));
  ok('a check name falls back to the script name in words', plain.check_names.join('|') === 'test graph layers live|npm --prefix apps/flow-room test', plain.check_names.join('|'));
  ok('a declared check name wins', named.check_names[0] === 'the tree dies');
}
{
  // an untouched todo (no rows at all) gets the documented sentence
  const root2 = t.track(makeFixture({ tasks: [{ id: 'fresh', title: 'Nothing has happened here' }] }));
  const fresh = pbJson(root2, ['graph', '--json']).nodes.find((x) => x.id === 'fresh');
  ok('an untouched todo says "Nobody has picked this up"', fresh.now === 'Nobody has picked this up' && fresh.now_source === 'fallback', JSON.stringify(fresh.now));
}

t.finish();
