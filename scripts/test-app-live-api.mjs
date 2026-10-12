#!/usr/bin/env node
// ============================================================================
//  test-app-live-api.mjs — the Flow room's local server reads an engine and writes
//  ONLY through it.
// ----------------------------------------------------------------------------
//  Hermetic by construction: every run scaffolds its own playbook in a temp dir and
//  points the server at THAT. It never touches this repo's backlog or journal
//  (project rule 26 — a probe that can run a writer works in a scratch fixture).
//
//  What it proves, in the order the room would use it:
//    1. /api/health names the playbook it found
//    2. /api/graph returns a payload carrying the projection schema the room asserts
//    3. a POST with no session cookie is refused
//    4. a POST with a cookie but no `x-pb-ui` header is refused  (this is the CSRF gate:
//       a cross-origin caller must preflight to send a custom header, and we refuse that)
//    5. a POST claiming a foreign Origin is refused
//    6. a comment on a task that does not exist is REFUSED, not silently created
//    7. a comment on a real task lands a journal row, visible to `pb runcard show --json`
//    8. memory/backlog.yaml is byte-identical across the whole run — the app never
//       edits state, it only asks the engine to
//    9. starting the server wrote nothing: the journal is unchanged between the moment
//       before it booted and the moment it answered (invariant 4)
// ============================================================================

import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './lib/test-temp.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(ROOT, 'apps', 'flow-room', 'server.mjs');
const CSRF = { 'x-pb-ui': '1', 'content-type': 'application/json' };

const problems = [];
const check = (condition, message) => { if (!condition) problems.push(message); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pb(cwd, args) {
  try {
    const stdout = execFileSync(process.execPath, [join(cwd, 'scripts', 'pb.mjs'), ...args], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return { code: err.status ?? 1, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') };
  }
}

const work = tempDir('pb-flow-api-');
const pbRoot = join(work, 'scratch-playbook');
let server = null;
let base = '';
let cookie = '';

try {
  // ── 0. a scratch playbook with exactly one real task ───────────────────────
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'pb.mjs'), 'scaffold', '--target', pbRoot], {
    cwd: work, encoding: 'utf8',
  });
  // the target's pb.mjs needs js-yaml; hydrate by REAL copy (rule 27 — never a junction)
  mkdirSync(join(pbRoot, 'node_modules'), { recursive: true });
  for (const dep of ['js-yaml', 'argparse']) {
    cpSync(join(ROOT, 'node_modules', dep), join(pbRoot, 'node_modules', dep), { recursive: true });
  }

  const step = (args, label) => {
    const r = pb(pbRoot, args);
    check(r.code === 0, `scratch setup: \`pb ${args.join(' ')}\` (${label}) exited ${r.code}: ${(r.stderr || r.stdout).trim().split('\n')[0]}`);
    return r;
  };
  step(['loop', 'new'], 'open the loop');
  step(['cycle', '--new', '--goal', 'scratch goal', '--stop', 'scratch goal is met'], 'cycle brief');

  // The real first-run gate, pinned rather than worked around: `pb plan` REFUSES until
  // the cycle brief's Q5 placeholder is answered, and `pb cycle` has no flag for it —
  // answering means editing memory/cycle.md. Asserting the refusal here keeps that
  // friction visible instead of letting the fixture silently sidestep it.
  const refused = pb(pbRoot, ['plan', '--goal', 'should be refused', '--check', 'node -v']);
  check(refused.code !== 0,
    'the planner ACCEPTED a task with an unanswered cycle brief — the phase-loop guardrail did not fire');
  check(/Q5|memory-conflict/i.test(refused.stderr + refused.stdout),
    'the planner refused but did not name the cycle-brief Q5 gate');

  const cycleFile = join(pbRoot, 'memory', 'cycle.md');
  const answered = readFileSync(cycleFile, 'utf8').replace(
    /\(Your host memory is the PAST[\s\S]*?memory\.\)/,
    'None for this fixture: the playbook folder is the truth.'
  );
  writeFileSync(cycleFile, answered, 'utf8');

  const planned = step(['plan', '--goal', 'scratch task for the api test', '--check', 'node -v'], 'seed a task');
  const taskId = /Planned \[([^\]]+)\]/.exec(planned.stdout)?.[1] ?? null;
  check(Boolean(taskId), 'scratch setup: could not read the planned task id');
  if (!taskId) throw new Error('no task id — cannot continue');

  const backlogFile = join(pbRoot, 'memory', 'backlog.yaml');
  const journalFile = join(pbRoot, 'memory', 'journal.ndjson');
  const decisionPlan = step(['plan', '--goal', 'decision fixture', '--check', 'node -v', '--manual'], 'seed a human ask');
  const decisionTask = /Planned \[([^\]]+)\]/.exec(decisionPlan.stdout)?.[1];
  check(Boolean(decisionTask), 'decision fixture has no task id');
  const backlogBefore = readFileSync(backlogFile);
  const journalBeforeBoot = readFileSync(journalFile).length;

  // ── the server ─────────────────────────────────────────────────────────────
  const port = 9600 + Math.floor(Math.random() * 300);
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [SERVER, '--root', pbRoot, '--port', String(port), '--no-open'], {
    stdio: 'ignore',
  });

  let health = null;
  for (let i = 0; i < 60 && !health; i += 1) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) health = await res.json();
    } catch { /* not up yet */ }
    if (!health) await sleep(200);
  }
  check(Boolean(health), `the server never answered /api/health on ${base}`);
  if (!health) throw new Error('server never came up');

  // 9. boot must not have written to the engine
  check(readFileSync(journalFile).length === journalBeforeBoot,
    'starting the server appended to the journal — invariant 4 (nothing writes on startup) is broken');

  // 1. health names the playbook
  check(health.root === pbRoot, `/api/health reported root ${health.root}, expected the scratch playbook`);

  // 2. the projection schema the room asserts on load
  const graphRes = await fetch(`${base}/api/graph`);
  const graph = await graphRes.json();
  check(graphRes.ok, `/api/graph failed with ${graphRes.status}`);
  check(graph?.schema === 'agent-playbook.graph.v1', `/api/graph schema is ${graph?.schema}`);
  check(Array.isArray(graph?.nodes) && Array.isArray(graph?.edges), '/api/graph has no nodes/edges arrays');

  // the session cookie
  const sessionRes = await fetch(`${base}/api/session`);
  const setCookie = sessionRes.headers.getSetCookie?.() ?? [];
  cookie = (setCookie[0] ?? '').split(';')[0];
  check(cookie.startsWith('pb_ui_session='), `no session cookie was issued (got ${setCookie.join(' | ') || 'nothing'})`);

  // 3. no cookie → refused
  const noCookie = await fetch(`${base}/api/comment`, {
    method: 'POST', headers: CSRF, body: JSON.stringify({ task: taskId, text: 'x' }),
  });
  check(noCookie.status === 403, `a POST with no session cookie returned ${noCookie.status}, expected 403`);

  // 4. cookie but no CSRF header → refused
  const noHeader = await fetch(`${base}/api/comment`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ task: taskId, text: 'x' }),
  });
  check(noHeader.status === 403, `a POST without the x-pb-ui header returned ${noHeader.status}, expected 403`);

  // 5. a foreign Origin → refused
  const foreign = await fetch(`${base}/api/comment`, {
    method: 'POST',
    headers: { ...CSRF, cookie, origin: 'http://evil.local' },
    body: JSON.stringify({ task: taskId, text: 'x' }),
  });
  check(foreign.status === 403, `a POST claiming a foreign Origin returned ${foreign.status}, expected 403`);

  // 6. an unknown task is REFUSED, not created
  const ghost = await fetch(`${base}/api/comment`, {
    method: 'POST', headers: { ...CSRF, cookie },
    body: JSON.stringify({ task: 'no-such-task-xyz', text: 'hello' }),
  });
  check(ghost.status === 422, `a comment on a nonexistent task returned ${ghost.status}, expected 422 (refused)`);
  const ghostBacklog = readFileSync(backlogFile, 'utf8');
  check(!ghostBacklog.includes('no-such-task-xyz'), 'the refused comment created a task anyway');

  // 7. a real comment lands a journal row the engine can show
  const text = `api test comment ${Date.now()}`;
  const ok = await fetch(`${base}/api/comment`, {
    method: 'POST', headers: { ...CSRF, cookie },
    body: JSON.stringify({ task: taskId, text }),
  });
  const okBody = await ok.json().catch(() => null);
  check(ok.status === 200, `a valid comment returned ${ok.status}: ${JSON.stringify(okBody)}`);

  const runcard = pb(pbRoot, ['runcard', 'show', taskId, '--json']);
  check(runcard.code === 0, `pb runcard show failed: ${(runcard.stderr || runcard.stdout).trim().split('\n')[0]}`);
  check(runcard.stdout.includes(text),
    'the comment is not visible to `pb runcard show --json` — it did not land as a journal row');
  check(/comment/i.test(runcard.stdout), 'the journal row does not carry action: comment');

  // 7b. M3: the message's intent reaches the journal row; an unknown intent is refused
  const asked = await fetch(`${base}/api/comment`, {
    method: 'POST', headers: { ...CSRF, cookie },
    body: JSON.stringify({ task: taskId, text: 'what does the launcher cost?', intent: 'question' }),
  });
  check(asked.status === 200, `a question returned ${asked.status}`);
  const lastRow = readFileSync(journalFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).pop();
  check(lastRow.intent === 'question' && lastRow.notes === 'what does the launcher cost?', `the question's row carries intent ${lastRow.intent}`);
  const shout = await fetch(`${base}/api/comment`, {
    method: 'POST', headers: { ...CSRF, cookie },
    body: JSON.stringify({ task: taskId, text: 'x', intent: 'shout' }),
  });
  check(shout.status === 400, `an unknown intent returned ${shout.status}, expected 400`);

  // 8. the engine still owns state: backlog.yaml is untouched by the whole run
  const beforeDecide = readFileSync(journalFile, 'utf8').trim().split('\n').length;
  const decisionPayload = { task: decisionTask, option: 'approve', reason: 'Proceed with the verified path.' };
  const unauthDecision = await fetch(`${base}/api/decide`, { method: 'POST', headers: CSRF, body: JSON.stringify(decisionPayload) });
  check(unauthDecision.status === 403, 'a decision without a cookie was not refused');
  const invalidDecision = await fetch(`${base}/api/decide`, { method: 'POST', headers: { ...CSRF, cookie }, body: JSON.stringify({ ...decisionPayload, option: 'nonexistent' }) });
  const refusal = await invalidDecision.json();
  check(invalidDecision.status === 422 && /has no option/.test(refusal.detail ?? ''), 'an unknown decision option did not show the engine refusal');
  check(readFileSync(journalFile, 'utf8').trim().split('\n').length === beforeDecide, 'a refused decision wrote a row');
  const decisionRes = await fetch(`${base}/api/decide`, { method: 'POST', headers: { ...CSRF, cookie }, body: JSON.stringify(decisionPayload) });
  const decision = await decisionRes.json();
  check(decisionRes.status === 200 && decision.row?.action === 'decide' && decision.row.option === 'approve' && decision.row.reason === decisionPayload.reason,
    `decision did not return its recorded row: ${JSON.stringify(decision)}`);
  const decidedRows = readFileSync(journalFile, 'utf8').trim().split('\n').map(JSON.parse);
  check(decidedRows.length === beforeDecide + 1 && decidedRows.at(-1).seq === decision.row?.seq, 'a successful decision did not write exactly one matching row');
  check(decidedRows.at(-1).status === 'todo', 'recording a decision changed task status');
  for (const field of ['task', 'option', 'reason']) {
    const r = await fetch(`${base}/api/decide`, { method: 'POST', headers: { ...CSRF, cookie }, body: JSON.stringify({ ...decisionPayload, [field]: '--force' }) });
    check(r.status === 400, `decision ${field} accepted an argument shaped as a flag`);
  }
  check(readFileSync(backlogFile).equals(backlogBefore),
    'memory/backlog.yaml changed during the run — the app must never edit state directly');

  // 10. v2 jump-in (D22, J2/J3): Create is the only write, and it goes through the engine.
  //     A follow-up is `pb plan --dep <card>`: a new task linked at birth.
  const follow = await fetch(`${base}/api/fork`, {
    method: 'POST', headers: { ...CSRF, cookie },
    body: JSON.stringify({ goal: 'follow-up drafted in the room', from: taskId }),
  });
  const followBody = await follow.json().catch(() => null);
  check(follow.status === 200 && followBody?.task, `a follow-up Create returned ${follow.status}: ${JSON.stringify(followBody)}`);
  const afterFollow = readFileSync(backlogFile, 'utf8');
  check(afterFollow.includes('follow-up drafted in the room') && new RegExp(`dependencies:\\s*\\n\\s*-\\s*${taskId}`).test(afterFollow),
    'the follow-up was not written by pb plan with its --dep link to the card it came from');
  //     A layer the playbook does not declare is REFUSED by the engine, verbatim.
  const badLayer = await fetch(`${base}/api/fork`, {
    method: 'POST', headers: { ...CSRF, cookie },
    body: JSON.stringify({ goal: 'card in a layer that does not exist', layer: 'L9' }),
  });
  const badLayerBody = await badLayer.json().catch(() => null);
  check(badLayer.status === 422 && /layer/i.test(badLayerBody?.detail ?? ''), `a card in an undeclared layer returned ${badLayer.status}: ${JSON.stringify(badLayerBody)}`);
  //     A fork is `pb worker create`; outside a git repository the engine refuses, and the
  //     room shows that refusal instead of pretending (this scratch playbook has no git).
  const forkRes = await fetch(`${base}/api/worker`, {
    method: 'POST', headers: { ...CSRF, cookie },
    body: JSON.stringify({ task: taskId }),
  });
  const forkBody = await forkRes.json().catch(() => null);
  check(forkRes.status === 422 && /git/i.test(forkBody?.detail ?? ''), `a fork outside git returned ${forkRes.status}: ${JSON.stringify(forkBody)}`);
  const badId = await fetch(`${base}/api/worker`, {
    method: 'POST', headers: { ...CSRF, cookie },
    body: JSON.stringify({ task: '../etc; rm -rf /' }),
  });
  check(badId.status === 400, `a fork with a malformed task id returned ${badId.status}, expected 400`);
  //     nothing the room sends may become a pb flag (checker note on plan-20261010-031)
  for (const [payload, why] of [
    [{ goal: 'ok goal', layer: '--force' }, 'a layer that is a flag'],
    [{ goal: 'ok goal', from: '--x' }, 'a from that is a flag'],
    [{ goal: '--skip-checks' }, 'a goal that is a flag'],
  ]) {
    const res = await fetch(`${base}/api/fork`, { method: 'POST', headers: { ...CSRF, cookie }, body: JSON.stringify(payload) });
    check(res.status === 400, `/api/fork with ${why} returned ${res.status}, expected 400`);
  }
} catch (err) {
  problems.push(`harness error: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  if (server) server.kill();
  rmSync(work, { recursive: true, force: true });
}

console.log('Flow room ⇄ local server');
console.log(`  scratch playbook : a temp scaffold, never this repo`);
console.log(`  server           : apps/flow-room/server.mjs`);
console.log(`  refusals checked : no cookie / no x-pb-ui / foreign Origin / unknown task`);
console.log(`  state ownership  : backlog.yaml byte-identical, journal untouched at boot`);

if (problems.length) {
  console.error(`\nLIVE API FAILED (${problems.length} problem(s)):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('\nThe room reads the engine and writes only through it.');
