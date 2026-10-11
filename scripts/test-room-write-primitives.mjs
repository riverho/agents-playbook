#!/usr/bin/env node
// ============================================================================
//  test-room-write-primitives.mjs — the two write primitives the room was missing.
// ----------------------------------------------------------------------------
//  The room could not steer a GOAL and could not ATTACH a document, and it said so rather than
//  pretending: /api/steer hardcoded `goal_applied: false` ("the engine has no primitive to edit an
//  open cycle brief") and /api/attach answered 501 ("no pb command writes a task's docs: field").
//  Both statements were true, and both were gaps in the ENGINE, not the room.
//
//  This gate proves the primitives exist and that the room now uses them:
//    1. `pb cycle --edit` rewrites the OPEN brief in BOTH places the answer lives — the YAML front
//       matter that every command reads and the numbered question a human reads — journals the
//       change, refuses an empty edit, and is a no-op when the text already says that.
//    2. `pb attach` writes a card's `docs:`, refuses an absolute path and a path that is not there,
//       and the entry it writes PASSES `pb validate` (which is the reader that already existed).
//    3. The routes: /api/steer's goal half really edits the brief, /api/attach really writes docs,
//       and a refusal from the engine is passed through as 422 rather than softened into a 200.
// ============================================================================

import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const work = mkdtempSync(join(tmpdir(), 'pb-room-writes-'));
const pbRoot = join(work, 'scratch-playbook');
let server = null;
let base = '';

try {
  // ── a scratch playbook with one real task ────────────────────────────────
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'pb.mjs'), 'scaffold', '--target', pbRoot], {
    cwd: work, encoding: 'utf8',
  });
  mkdirSync(join(pbRoot, 'node_modules'), { recursive: true });
  for (const dep of ['js-yaml', 'argparse']) {
    const from = join(ROOT, 'node_modules', dep);
    if (existsSync(from)) cpSync(from, join(pbRoot, 'node_modules', dep), { recursive: true });
  }
  const step = (args, label) => {
    const r = pb(pbRoot, args);
    check(r.code === 0, `scratch setup: \`pb ${args.join(' ')}\` (${label}) exited ${r.code}: ${(r.stderr || r.stdout).trim().split('\n')[0]}`);
    return r;
  };
  step(['loop', 'new'], 'open the loop');
  step(['cycle', '--new', '--goal', 'scratch goal', '--stop', 'the original stop'], 'cycle brief');

  // `pb plan` refuses until Q5 is answered, and no flag answers it — the same friction
  // scripts/test-app-live-api.mjs pins. Edited directly here because this gate is about the
  // primitives it does have.
  const cycleFile = join(pbRoot, 'memory', 'cycle.md');
  writeFileSync(cycleFile, readFileSync(cycleFile, 'utf8').replace(
    /\(Your host memory is the PAST[\s\S]*?memory\.\)/,
    'None for this fixture: the playbook folder is the truth.'
  ), 'utf8');
  const planned = step(['plan', '--goal', 'a card to steer and attach to', '--check', 'node -v'], 'seed a task');
  const taskId = /Planned \[([^\]]+)\]/.exec(planned.stdout)?.[1] ?? null;
  check(Boolean(taskId), 'scratch setup: could not read the planned task id');
  if (!taskId) throw new Error('no task id — cannot continue');

  const backlogFile = join(pbRoot, 'memory', 'backlog.yaml');
  const journalFile = join(pbRoot, 'memory', 'journal.ndjson');
  const journalRows = () => readFileSync(journalFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

  // ── 1. pb cycle --edit ───────────────────────────────────────────────────
  const edited = pb(pbRoot, ['cycle', '--edit', '--stop', 'the revised stop']);
  check(edited.code === 0, `pb cycle --edit --stop exited ${edited.code}: ${(edited.stderr || edited.stdout).trim()}`);
  const brief = readFileSync(cycleFile, 'utf8');
  const frontMatter = brief.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? '';
  check(/^stop: "the revised stop"$/m.test(frontMatter),
    'pb cycle --edit did not rewrite the front-matter stop — the half every command reads');
  const section4 = brief.split(/^##\s*4\./m)[1]?.split(/^##\s/m)[0] ?? '';
  check(/the revised stop/.test(section4),
    'pb cycle --edit did not rewrite question 4 — the half a human reads, so the brief would contradict itself');
  check(!/the original stop/.test(frontMatter), 'the old stop is still in the front matter');
  const view = pb(pbRoot, ['cycle']);
  check(/the revised stop/.test(view.stdout), 'pb cycle no longer prints the edited stop — the brief was written but not parseable');
  const editRow = journalRows().filter((r) => r.action === 'cycle-edit');
  check(editRow.length === 1, `expected exactly one cycle-edit journal row, found ${editRow.length}`);
  check(JSON.stringify(editRow[0]?.before ?? {}).includes('the original stop'),
    'the cycle-edit journal row did not record what the brief said BEFORE the edit');
  const noFlags = pb(pbRoot, ['cycle', '--edit']);
  check(noFlags.code === 2, `pb cycle --edit with nothing to change exited ${noFlags.code}, expected 2 (a refused usage, not a crash)`);
  const before = readFileSync(cycleFile, 'utf8');
  const again = pb(pbRoot, ['cycle', '--edit', '--stop', 'the revised stop']);
  check(again.code === 0 && /No change/.test(again.stdout), 're-applying the same stop did not report "No change"');
  check(readFileSync(cycleFile, 'utf8') === before, 'a no-op --edit rewrote the brief anyway');

  // ── 2. pb attach ─────────────────────────────────────────────────────────
  mkdirSync(join(pbRoot, 'docs'), { recursive: true });
  writeFileSync(join(pbRoot, 'docs', 'evidence.md'), '# Evidence\n', 'utf8');
  writeFileSync(join(pbRoot, 'docs', 'evidence-2.md'), '# More evidence\n', 'utf8');

  const attach = pb(pbRoot, ['attach', '--task', taskId, '--path', 'docs/evidence.md']);
  check(attach.code === 0, `pb attach exited ${attach.code}: ${(attach.stderr || attach.stdout).trim()}`);
  check(/docs:\s*\n?\s*(- )?docs\/evidence\.md/.test(readFileSync(backlogFile, 'utf8')),
    'pb attach did not write the docs: entry into the backlog');
  check(journalRows().filter((r) => r.action === 'attach').length === 1, 'pb attach wrote no journal row (the association would be unattributable)');
  const validAfterAttach = pb(pbRoot, ['validate']);
  check(validAfterAttach.code === 0,
    `pb validate fails on the entry pb attach just wrote — the writer and the checker disagree:\n      ${(validAfterAttach.stderr || validAfterAttach.stdout).trim().split('\n').slice(0, 3).join('\n      ')}`);

  const dup = pb(pbRoot, ['attach', '--task', taskId, '--path', 'docs/evidence.md']);
  check(dup.code === 0 && /already lists/.test(dup.stdout), 'attaching the same document twice was not a stated no-op');
  check(journalRows().filter((r) => r.action === 'attach').length === 1, 'the duplicate attach wrote a second journal row');

  const absolute = pb(pbRoot, ['attach', '--task', taskId, '--path', join(pbRoot, 'docs', 'evidence-2.md')]);
  check(absolute.code !== 0, 'pb attach ACCEPTED an absolute path, which pb validate rejects as not root-relative');
  check(/absolute/i.test(absolute.stderr + absolute.stdout), 'the absolute-path refusal did not say why');
  const missing = pb(pbRoot, ['attach', '--task', taskId, '--path', 'docs/never-written.md']);
  check(missing.code !== 0, 'pb attach ACCEPTED a path that does not exist — that is a claim, not a document');
  check(journalRows().filter((r) => r.action === 'attach').length === 1, 'a refused attach wrote a journal row anyway');
  check(!/never-written/.test(readFileSync(backlogFile, 'utf8')), 'a refused attach still recorded the path');

  // TEETH: the reader that already existed must actually bite when the document disappears.
  const docPath = join(pbRoot, 'docs', 'evidence.md');
  const docBytes = readFileSync(docPath);
  rmSync(docPath, { force: true });
  const validGone = pb(pbRoot, ['validate']);
  check(validGone.code !== 0, 'pb validate passed with a docs: path that no longer exists — the association is unverified');
  check(/evidence\.md/.test(validGone.stderr + validGone.stdout), 'validate failed but did not name the missing document');
  writeFileSync(docPath, docBytes);

  // ── 2b. a JSON backlog ───────────────────────────────────────────────────
  // The master may point `backlog:` at a .json file and writeBacklog supports it, so the writer
  // must not assume YAML: a textual insertion into a JSON document would corrupt it.
  {
    const master = join(pbRoot, 'playbook.yaml');
    const masterBefore = readFileSync(master, 'utf8');
    const flipped = masterBefore.replace(/backlog:\s*memory\/backlog\.yaml/, 'backlog: memory/backlog.json');
    check(flipped !== masterBefore, 'the scratch master does not name a backlog file to flip — the JSON case cannot be tested');
    writeFileSync(master, flipped, 'utf8');
    const jsonBacklog = {
      tasks: [{ id: taskId, title: 'a card to steer and attach to', status: 'todo', skill: 'run-task', mode: 'coding', priority: 1, acceptance_checks: ['node -v'] }],
    };
    writeFileSync(join(pbRoot, 'memory', 'backlog.json'), `${JSON.stringify(jsonBacklog, null, 2)}\n`, 'utf8');

    const jsonAttach = pb(pbRoot, ['attach', '--task', taskId, '--path', 'docs/evidence-2.md']);
    check(jsonAttach.code === 0, `pb attach against a JSON backlog exited ${jsonAttach.code}: ${(jsonAttach.stderr || jsonAttach.stdout).trim().split('\n')[0]}`);
    let jsonAfter = null;
    try { jsonAfter = JSON.parse(readFileSync(join(pbRoot, 'memory', 'backlog.json'), 'utf8')); } catch { jsonAfter = null; }
    check(jsonAfter !== null, 'pb attach CORRUPTED a JSON backlog — the file no longer parses');
    check(jsonAfter?.tasks?.[0]?.docs?.includes('docs/evidence-2.md') === true,
      'pb attach did not record the document in the JSON backlog');
    const jsonValidate = pb(pbRoot, ['validate']);
    check(jsonValidate.code === 0, `pb validate fails on a JSON backlog pb attach wrote:\n      ${(jsonValidate.stderr || jsonValidate.stdout).trim().split('\n').slice(0, 2).join('\n      ')}`);

    writeFileSync(master, masterBefore, 'utf8');
    rmSync(join(pbRoot, 'memory', 'backlog.json'), { force: true });
  }

  // ── 3. the room's routes ─────────────────────────────────────────────────
  const port = 9800 + Math.floor(Math.random() * 150);
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [SERVER, '--root', pbRoot, '--port', String(port), '--no-open'], { stdio: 'ignore' });
  let health = null;
  for (let i = 0; i < 60 && !health; i += 1) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) health = await res.json();
    } catch { /* not up yet */ }
    if (!health) await sleep(200);
  }
  check(Boolean(health), `the server never answered /api/health on ${base}`);
  if (health) {
    const sessionRes = await fetch(`${base}/api/session`);
    const cookie = (sessionRes.headers.getSetCookie?.() ?? [''])[0].split(';')[0];
    check(Boolean(cookie), 'no session cookie was issued, so the write routes cannot be exercised');

    // attach: the route that used to answer 501
    const attachRes = await fetch(`${base}/api/attach`, {
      method: 'POST', headers: { ...CSRF, cookie },
      body: JSON.stringify({ task: taskId, path: 'docs/evidence-2.md' }),
    });
    const attachBody = await attachRes.json().catch(() => null);
    check(attachRes.status === 200, `/api/attach returned ${attachRes.status} (was 501) — body ${JSON.stringify(attachBody)}`);
    check(/evidence-2\.md/.test(readFileSync(backlogFile, 'utf8')), '/api/attach answered 200 but the backlog has no entry for the document');
    check(attachBody?.count === 2, `/api/attach reported count ${attachBody?.count}, expected 2 after the second document`);

    // a refusal must survive the route rather than being softened into a success
    const refusedRes = await fetch(`${base}/api/attach`, {
      method: 'POST', headers: { ...CSRF, cookie },
      body: JSON.stringify({ task: taskId, path: join(pbRoot, 'docs', 'evidence.md') }),
    });
    const refusedBody = await refusedRes.json().catch(() => null);
    check(refusedRes.status === 422, `an absolute path through /api/attach returned ${refusedRes.status}, expected 422`);
    check(/absolute/i.test(String(refusedBody?.detail ?? '')), 'the 422 did not carry the engine\'s own reason');

    const badShape = await fetch(`${base}/api/attach`, {
      method: 'POST', headers: { ...CSRF, cookie }, body: JSON.stringify({ task: taskId }),
    });
    check(badShape.status === 400, `/api/attach with no path returned ${badShape.status}, expected 400`);

    // steer: the goal half that used to be hardcoded false
    const steerRes = await fetch(`${base}/api/steer`, {
      method: 'POST', headers: { ...CSRF, cookie },
      body: JSON.stringify({ tasks: [taskId], text: 'steer the room toward the gate', goal: 'the stop the room set' }),
    });
    const steerBody = await steerRes.json().catch(() => null);
    check(steerRes.status === 200, `/api/steer returned ${steerRes.status}`);
    check(steerBody?.goal_applied === true,
      `goal_applied was ${JSON.stringify(steerBody?.goal_applied)} — the goal half is still not applied${steerBody?.goal_note ? `: ${steerBody.goal_note}` : ''}`);
    check(/the stop the room set/.test(readFileSync(cycleFile, 'utf8')),
      'goal_applied said true but the brief does not carry the new stop — the route reported a write it did not make');
    check(steerBody?.ok === true, 'the steer reported not-ok although both halves landed');

    const steerGuard = await fetch(`${base}/api/steer`, {
      method: 'POST', headers: { ...CSRF, cookie },
      body: JSON.stringify({ tasks: [taskId], text: 'x', goal: '--force' }),
    });
    check(steerGuard.status === 400, `a goal starting with "-" returned ${steerGuard.status}, expected 400 (it would be read as a flag)`);
  }
} catch (err) {
  problems.push(`harness error: ${String(err?.message ?? err).split('\n')[0]}`);
} finally {
  if (server) { try { server.kill(); } catch { /* already gone */ } }
  await sleep(200);
  let removed = false;
  for (let i = 0; i < 6 && !removed; i += 1) {
    try { rmSync(work, { recursive: true, force: true }); removed = !existsSync(work); } catch { await sleep(150); }
  }
  if (!removed) console.error(`note: left the scratch playbook on disk: ${work}`);
}

console.log('Room write primitives — steer-the-goal and attach');
console.log('  pb cycle --edit : the OPEN brief is edited in the front matter AND question 4, journalled, no-op when unchanged');
console.log('  pb attach       : writes docs:, refuses absolute and missing paths, and the entry passes pb validate');
console.log('  the routes      : /api/steer applies the goal, /api/attach writes the card, refusals stay refusals');

if (problems.length) {
  console.error(`\nROOM WRITE PRIMITIVES FAILED (${problems.length} problem(s)):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('\nBoth primitives exist, the room uses them, and the refusals are the engine\'s own.');
