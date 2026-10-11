#!/usr/bin/env node
// scripts/test-decide.mjs — plan-20261010-033 (D17; contract H1–H3)
// ----------------------------------------------------------------------------
//  1. pb graph: a task's human: block (question, options with effect, recommended,
//     recommended_by, waiting_on) with fallbacks for a manual task that declares none:
//     "Approve: {headline}?", Approve / Reject / Ask, waiting_on from the dependency edges.
//  2. pb decide writes exactly ONE row (action decide, option, reason) and moves no
//     status; an unknown option, a missing reason, a task that asks nothing, an unknown
//     task and a done task are refused verbatim and write nothing.
//  3. pb validate: a malformed human: block FAILS (H1/H2); a manual task with no
//     question only WARNS.
// ----------------------------------------------------------------------------
import { makeFixture, makeSuite, pbJson, readJournal, runPb } from './test-fixture-playbook.mjs';

const t = makeSuite('test-decide');
const { ok } = t;
const HUMAN = [
  'human:',
  '      question: "Publish 0.6.2 to npm, or close it as superseded?"',
  '      options:',
  '        - { id: publish, label: Publish, effect: "a person runs npm publish; the task closes" }',
  '        - { id: close, label: Close, effect: "closed as superseded by 0.7.0" }',
  '      recommended: close',
  '      recommended_by: lead',
];
const tasks = [
  { id: 'asks', title: 'Publish the renamed plugin', manual: true, extra: HUMAN },
  { id: 'bare', title: 'Mount the plugin in the live profile. More words.', manual: true },
  { id: 'after', title: 'Depends on the bare one', dependencies: ['bare'] },
  { id: 'agent-only', title: 'An ordinary task' },
];
const root = t.track(makeFixture({ tasks }));

// ── 1. the projection ──────────────────────────────────────────────────────
{
  const g = pbJson(root, ['graph', '--json']);
  const n = (id) => g.nodes.find((x) => x.id === id);
  if (!n('asks') || !('human' in n('asks'))) { ok('pb graph carries human', false); t.finish(); }
  const asks = n('asks').human;
  ok('a declared question, options with effects, and a signed recommendation', asks.question === 'Publish 0.6.2 to npm, or close it as superseded?'
    && asks.question_source === 'task' && asks.options.map((o) => o.id).join() === 'publish,close' && asks.options.every((o) => o.effect)
    && asks.recommended === 'close' && asks.recommended_by === 'lead' && asks.decided === null, JSON.stringify(asks));
  const bare = n('bare').human;
  ok('a manual task without a block asks "Approve: {headline}?"', bare.question === 'Approve: Mount the plugin in the live profile?' && bare.question_source === 'fallback', bare.question);
  ok('…with Approve / Reject / Ask, each with an effect', bare.options.map((o) => o.id).join() === 'approve,reject,ask' && bare.options.every((o) => o.effect));
  ok('…and waiting_on from the tasks that depend on it', JSON.stringify(bare.waiting_on) === '["after"]' && bare.waiting_on_source === 'dependencies', JSON.stringify(bare));
  ok('a task that asks nobody has no human block', n('agent-only').human === null);
}

// ── 2. pb decide ───────────────────────────────────────────────────────────
const rows = () => readJournal(root).length;
const refused = (args, why, pattern) => {
  const before = rows();
  const r = runPb(root, ['decide', ...args], { agent: 'human' });
  ok(`refused: ${why}`, r.code !== 0 && pattern.test(r.combined) && rows() === before, r.combined);
};
refused(['--task', 'asks', '--option', 'maybe', '--reason', 'x'], 'an option the task does not offer', /has no option "maybe"\. Options: publish, close/);
refused(['--task', 'asks', '--option', 'close'], 'no reason', /Usage: pb decide/);
refused(['--task', 'agent-only', '--option', 'approve', '--reason', 'x'], 'a task that asks a person nothing', /does not ask a person anything/);
refused(['--task', 'ghost', '--option', 'approve', '--reason', 'x'], 'an unknown task', /Task not found/);
{
  const before = rows();
  const r = runPb(root, ['decide', '--task', 'asks', '--option', 'close', '--reason', '0.7.0 already shipped this'], { agent: 'human' });
  const after = readJournal(root);
  const row = after[after.length - 1];
  ok('a decision writes exactly one row', r.code === 0 && after.length === before + 1, r.combined);
  ok('the row carries action decide, the option and the reason', row.action === 'decide' && row.option === 'close' && row.reason === '0.7.0 already shipped this' && row.intent === 'decision' && row.agent === 'human', JSON.stringify(row));
  ok('the decision does not move the task', row.status === 'todo' && pbJson(root, ['graph', '--json']).nodes.find((x) => x.id === 'asks').status === 'todo');
  ok('the engine says the chosen effect back', /Close\. Effect: closed as superseded by 0\.7\.0/.test(r.out), r.out);
  const decided = pbJson(root, ['graph', '--json']).nodes.find((x) => x.id === 'asks').human.decided;
  ok('pb graph shows the decision', decided && decided.option === 'close' && decided.by === 'human' && typeof decided.seq === 'number', JSON.stringify(decided));
}
{
  const r = runPb(root, ['decide', '--task', 'bare', '--option', 'approve', '--reason', 'go'], { agent: 'human' });
  ok('a manual task without a block accepts the fallback options', r.code === 0, r.combined);
}

// ── 3. pb validate ─────────────────────────────────────────────────────────
{
  const v = runPb(root, ['validate']);
  ok('validate passes with a well-formed block', v.code === 0, v.combined);
  ok('validate warns about the manual task with no question', /\[bare\] is manual: true but declares no human\.question/.test(v.out), v.out);
  ok('validate does not warn about the task that asks properly', !/\[asks\]/.test(v.out));
}
const bad = (lines, why, pattern) => {
  const r2 = t.track(makeFixture({ tasks: [{ id: 'x', title: 'x', manual: true, extra: lines }] }));
  const v = runPb(r2, ['validate']);
  ok(`validate FAILS: ${why}`, v.code === 1 && pattern.test(v.combined), v.combined);
};
bad(['human:', '      question: "Publish it"'], 'a question that is not a question', /must be a question ending in "\?"/);
bad(['human:', '      question: "Publish?"', '      options:', '        - { id: a, effect: "x" }'], 'one option', /at least two options/);
bad(['human:', '      question: "Publish?"', '      options:', '        - { id: a, effect: "x" }', '        - { id: b }'], 'an option with no effect', /"b" must state its effect/);
bad(['human:', '      question: "Publish?"', '      options:', '        - { id: a, effect: "x" }', '        - { id: b, effect: "y" }', '      recommended: a'], 'a recommendation nobody signs', /needs recommended_by/);
bad(['human:', '      question: "Publish?"', '      options:', '        - { id: a, effect: "x" }', '        - { id: b, effect: "y" }', '      recommended: c', '      recommended_by: lead'], 'a recommendation that is not an option', /"c" is not one of its options/);

t.finish();
