#!/usr/bin/env node
// test-claim-token-chain — a record proven by the claim TOKEN still says who wrote it.
//
// plan-20261009-007: verifyTaskClaim's token path returned no chain, so a delegated
// writer's `pb record` got ownership:token but NO agent_chain (journal seq 37), while
// `pb comment` from the same writer stamped one. The token proves the right to write;
// the chain says who wrote and on whose behalf. Both writers must agree.

import { makeSuite, makeFixture, runPb, readJournal } from './test-fixture-playbook.mjs';

const t = makeSuite('claim token chain');
const { ok } = t;
const root = t.track(makeFixture({ prefix: 'pbtokchain-', tasks: [{ id: 'T1', title: 'delegated work' }] }));

const claim = runPb(root, ['next', '--claim'], { agent: 'lead' });
const token = /Claim token: ([0-9a-f]+)/.exec(claim.combined)?.[1];
ok('the lead claims T1 and gets a token', claim.code === 0 && !!token, claim.combined.slice(0, 400));

const rowsFor = (action) => readJournal(root).filter((r) => r.task === 'T1' && r.action === action);

// 1. a sub-agent with ONLY the token (no chain in the environment)
const sub = { agent: 'worker', env: { PB_CLAIM_TOKEN: token } };
const rec = runPb(root, ['record', '--task', 'T1', '--action', 'progress', '--status', 'blocked', '--notes', 'half way'], sub);
const recRow = rowsFor('progress').at(-1);
ok('the token-proven record is accepted as ownership:token', rec.code === 0 && recRow?.ownership === 'token', `${rec.combined.slice(0, 300)}\n${JSON.stringify(recRow)}`);
ok('…and carries an agent_chain naming the writer', Array.isArray(recRow?.agent_chain) && recRow.agent_chain.includes('worker'), JSON.stringify(recRow));

const com = runPb(root, ['comment', '--task', 'T1', '--text', 'note from the worker'], sub);
const comRow = rowsFor('comment').at(-1);
ok('pb comment from the same writer stamps the same chain', com.code === 0 &&
  JSON.stringify(comRow?.agent_chain) === JSON.stringify(recRow?.agent_chain), `record=${JSON.stringify(recRow?.agent_chain)} comment=${JSON.stringify(comRow?.agent_chain)}`);

// 2. the token plus a declared delegation chain: the chain is kept whole, in order
const both = { agent: 'worker', env: { PB_CLAIM_TOKEN: token, PB_AGENT_CHAIN: 'lead,worker' } };
runPb(root, ['record', '--task', 'T1', '--action', 'progress2', '--status', 'blocked', '--notes', 'more'], both);
const bothRow = rowsFor('progress2').at(-1);
ok('token + PB_AGENT_CHAIN: ownership stays token and the chain is lead → worker',
  bothRow?.ownership === 'token' && JSON.stringify(bothRow?.agent_chain) === '["lead","worker"]', JSON.stringify(bothRow));

// 3. the chain path is unchanged
const viaChain = runPb(root, ['comment', '--task', 'T1', '--text', 'via chain'], { agent: 'worker', env: { PB_AGENT_CHAIN: 'lead,worker' } });
ok('a chain-only writer still works', viaChain.code === 0, viaChain.combined.slice(0, 300));

const val = runPb(root, ['validate']);
ok('pb validate passes', val.code === 0, val.combined.slice(-500));

t.finish();
