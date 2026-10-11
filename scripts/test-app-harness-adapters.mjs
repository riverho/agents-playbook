#!/usr/bin/env node
// scripts/test-app-harness-adapters.mjs — plan-20261010-015 (deployment plan P4b)
// ----------------------------------------------------------------------------
// The standalone room can hand a person's question to a harness CLI, and is honest when
// there is none. Hermetic: no network, no real model — PATH is controlled, and the only
// harness that runs is the stub.
//   1. detect() reports exactly the CLIs present on PATH (fake claude/codex/opencode
//      shims in a temp dir → all three; an empty PATH → none). It never runs them.
//   2. With ZERO harnesses, /api/ask still appends the question to the journal
//      (intent: question) and says "recorded · not dispatched" — degradation, not a crash.
//   3. The stub end to end: /api/ask records first, then streams the stub's answer as
//      server-sent events (recorded → text… → done), and the stub received the prompt
//      on stdin (its reply quotes the question).
//   4. The adapters never pass the question as an argument (stdin only), and a request
//      for a harness that is not on the machine is recorded, not dispatched.
// ----------------------------------------------------------------------------
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeFixture, makeSuite, readJournal } from './test-fixture-playbook.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(ROOT, 'apps', 'flow-room', 'server.mjs');
const { ADAPTERS, detectHarnesses } = await import(new URL('../apps/flow-room/harness.mjs', import.meta.url));
const CSRF = { 'x-pb-ui': '1', 'content-type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t = makeSuite('test-app-harness-adapters');
const { ok } = t;

// ── 1. detection ───────────────────────────────────────────────────────────
const bin = mkdtempSync(join(tmpdir(), 'pb-harness-bin-'));
for (const name of ['claude', 'codex', 'opencode']) {
  writeFileSync(join(bin, process.platform === 'win32' ? `${name}.cmd` : name), '@echo off\r\nexit 0\r\n', { mode: 0o755 });
}
const empty = mkdtempSync(join(tmpdir(), 'pb-harness-empty-'));
{
  const three = detectHarnesses({ PATH: bin, PATHEXT: '.COM;.EXE;.BAT;.CMD' }).map((h) => h.id);
  ok('detect() reports exactly the three CLIs on PATH', three.join() === 'claude,codex,opencode', three.join());
  ok('detect() reports none on an empty PATH', detectHarnesses({ PATH: empty, PATHEXT: '.CMD' }).length === 0);
  ok('the stub is offered only when asked for', detectHarnesses({ PATH: empty, PB_UI_HARNESS_STUB: '1' }).map((h) => h.id).join() === 'stub');
  ok('no adapter passes user text as an argument (prompt goes on stdin)', ADAPTERS.every((a) => a.argv.every((x) => /^[-\w]+$/.test(x))), JSON.stringify(ADAPTERS));
}

// ── a server over a fixture playbook ───────────────────────────────────────
const root = t.track(makeFixture({ prefix: 'pbharness-', tasks: [{ id: 'asks', title: 'What does the launcher cost per check?' }] }));
async function startServer(env) {
  const port = 9300 + Math.floor(Math.random() * 400);
  const child = spawn(process.execPath, [SERVER, '--root', root, '--port', String(port), '--no-open'], { stdio: 'ignore', env: { ...process.env, ...env } });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i += 1) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* not up */ }
    await sleep(200);
  }
  const cookie = ((await fetch(`${base}/api/session`)).headers.getSetCookie?.() ?? [])[0]?.split(';')[0] ?? '';
  return { child, base, cookie };
}
const ask = (s, body) => fetch(`${s.base}/api/ask`, { method: 'POST', headers: { ...CSRF, cookie: s.cookie }, body: JSON.stringify(body) });

// ── 2. zero harnesses: recorded, not dispatched ────────────────────────────
{
  const s = await startServer({ PATH: empty, Path: empty, PB_UI_HARNESS_STUB: '' });
  try {
    const listed = await (await fetch(`${s.base}/api/harness`)).json();
    ok('/api/harness lists none and says what that means', listed.available.length === 0 && /not dispatched/.test(listed.note ?? ''), JSON.stringify(listed));
    const before = readJournal(root).length;
    const r = await ask(s, { task: 'asks', text: 'is it under 0.1 s?', harness: 'claude' });
    const body = await r.json();
    const rows = readJournal(root);
    ok('with no harness the question is still recorded', r.status === 200 && body.recorded === true && body.dispatched === false && rows.length === before + 1, JSON.stringify(body));
    ok('…as a question row in the journal', rows[rows.length - 1].intent === 'question' && rows[rows.length - 1].notes === 'is it under 0.1 s?');
    ok('…and the room is told plainly', /recorded · not dispatched — no claude harness/.test(body.note ?? ''), body.note);
  } finally { s.child.kill(); }
}

// ── 3. the stub, end to end ────────────────────────────────────────────────
{
  const s = await startServer({ PATH: empty, Path: empty, PB_UI_HARNESS_STUB: '1' });
  try {
    const listed = await (await fetch(`${s.base}/api/harness`)).json();
    ok('/api/harness lists the stub when it is enabled', listed.available.map((h) => h.id).join() === 'stub', JSON.stringify(listed));
    const before = readJournal(root).length;
    const r = await ask(s, { task: 'asks', text: 'what does the launcher cost?', harness: 'stub' });
    ok('a dispatched question streams as server-sent events', /text\/event-stream/.test(r.headers.get('content-type') ?? ''), r.headers.get('content-type'));
    const raw = await r.text();
    const events = raw.split('\n\n').map((b) => b.replace(/^data: /, '').trim()).filter(Boolean).map((j) => JSON.parse(j));
    const types = events.map((e) => e.type);
    ok('the stream is recorded → text … → done', types[0] === 'recorded' && types.includes('text') && types[types.length - 1] === 'done', types.join(','));
    const answer = events.filter((e) => e.type === 'text').map((e) => e.text).join('');
    ok('the stub got the question on stdin', answer.includes('stub heard: The person asks: what does the launcher cost?'), answer);
    ok('the question was recorded BEFORE dispatch, exactly once', readJournal(root).length === before + 1 && readJournal(root).pop().intent === 'question');
  } finally { s.child.kill(); }
}

try { rmSync(bin, { recursive: true, force: true }); rmSync(empty, { recursive: true, force: true }); } catch { /* temp */ }
t.finish();
