#!/usr/bin/env node
// ============================================================================
//  check-app-write-wiring.mjs — the room's Comment/Steer actually REACH the engine.
// ----------------------------------------------------------------------------
//  The defect this pins (found by the human, using the room): the live adapter only
//  overrode `load`, so `applySteering` was still the fixture stub — Comment and Steer
//  updated local React state and wrote nothing, while the toast's headline asserted a
//  write. Two halves are asserted here:
//
//    STATIC  · the live adapter overrides applySteering
//            · BOTH FlowRoom submit paths await it (an un-awaited promise would restore
//              the old lie: the toast would read before the write resolved)
//            · the toast copy branches on `persisted`
//
//    DYNAMIC · the real thing, in a browser: serve a SCRATCH playbook, click a card,
//              click its Comment action, and assert that scratch playbook's journal
//              gained exactly one `action: comment` row — and that the toast says
//              "Steering applied" only because it did persist.
//
//  The scratch playbook never touches this repo (project rule 26).
// ============================================================================

import { createServer } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP = join(ROOT, 'apps', 'flow-room');
const ROOM = join(APP, 'src', 'room');
const SERVER = join(APP, 'server.mjs');
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p));

const problems = [];
const check = (condition, message) => { if (!condition) problems.push(message); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── STATIC: the wiring exists in the source that ships ─────────────────────────
const apiSrc = readFileSync(join(APP, 'src', 'flow-api.ts'), 'utf8');
const roomSrc = readFileSync(join(ROOM, 'components', 'stage', 'FlowRoom.tsx'), 'utf8');
const dockSrc = readFileSync(join(ROOM, 'components', 'stage', 'FlowSteeringDock.tsx'), 'utf8');

const liveAdapterBlock = /export async function liveAdapter[\s\S]*?\n}\n/.exec(apiSrc)?.[0] ?? '';
check(/applySteering\s*:/.test(liveAdapterBlock),
  'the live adapter does not override applySteering — Comment and Steer would be UI-only again');
check(/await\s+active\.applySteering\(/.test(roomSrc),
  'no submit path awaits applySteering — the toast would report before the write resolved');
const awaits = roomSrc.match(/await\s+active\.applySteering\(/g)?.length ?? 0;
check(awaits >= 2, `only ${awaits} of the two submit paths await applySteering`);
check(/const\s+done\s*=\s*toast\.persisted/.test(dockSrc),
  'the toast copy does not branch on persisted — it could claim a write that did not happen');
check(/nothing written/i.test(dockSrc),
  'the toast has no honest headline for the not-persisted case');

// ── DYNAMIC: click it for real ────────────────────────────────────────────────
const work = mkdtempSync(join(tmpdir(), 'pb-write-wiring-'));
const repo = join(work, 'repo');
const pbRoot = join(repo, '.agents-playbook');
const TASK_GOAL = 'gate task: one comment must land as one journal row';
let server = null;
let browser = null;
let profile = null;

function pb(cwd, args) {
  try {
    return { code: 0, stdout: execFileSync(process.execPath, [join(cwd, 'scripts', 'pb.mjs'), ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), stderr: '' };
  } catch (err) {
    return { code: err.status ?? 1, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') };
  }
}

function killTree(pid) {
  try { execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' }); } catch { /* gone */ }
}

async function portFor(start, attempt = 0) {
  const server1 = createServer();
  await new Promise((res) => server1.listen(0, '127.0.0.1', res));
  const port = server1.address().port;
  await new Promise((res) => server1.close(res));
  return port + attempt;
}

try {
  // build the app if stale (the browser loads dist/)
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-app.mjs')], { stdio: 'ignore' });
  if (!existsSync(join(APP, 'dist', 'index.html'))) throw new Error('no app build at apps/flow-room/dist');

  // a scratch playbook with ONE task whose title is the comment text we expect
  mkdirSync(repo, { recursive: true });
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'pb.mjs'), 'scaffold', '--target', pbRoot], { cwd: repo, stdio: 'ignore' });
  mkdirSync(join(pbRoot, 'node_modules'), { recursive: true });
  for (const dep of ['js-yaml', 'argparse']) {
    cpSync(join(ROOT, 'node_modules', dep), join(pbRoot, 'node_modules', dep), { recursive: true });
  }
  pb(pbRoot, ['loop', 'new']);
  pb(pbRoot, ['cycle', '--new', '--goal', 'write wiring', '--stop', 'a comment lands']);
  const cycleFile = join(pbRoot, 'memory', 'cycle.md');
  writeFileSync(cycleFile, readFileSync(cycleFile, 'utf8').replace(/\(Your host memory is the PAST[\s\S]*?memory\.\)/, 'None.'), 'utf8');
  const planned = pb(pbRoot, ['plan', '--goal', TASK_GOAL, '--check', 'node -v']);
  const taskId = /Planned \[([^\]]+)\]/.exec(planned.stdout)?.[1] ?? null;
  check(Boolean(taskId), 'scratch setup: no task was planned');

  // the engine server for that scratch playbook
  const port = await portFor(9400);
  server = spawn(process.execPath, [SERVER, '--root', pbRoot, '--port', String(port), '--no-open'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let health = null;
  for (let i = 0; i < 60 && !health; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) health = await r.json();
    } catch { /* not up */ }
    if (!health) await sleep(250);
  }
  check(Boolean(health), `the engine server never answered on ${port}`);

  if (health && CHROME && taskId) {
    const debugPort = 9200 + Math.floor(Math.random() * 200);
    profile = mkdtempSync(join(tmpdir(), 'pb-write-wiring-chrome-'));
    browser = spawn(CHROME, [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--disable-extensions', '--hide-scrollbars',
      `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, '--window-size=1500,950', 'about:blank',
    ], { stdio: 'ignore' });

    let version = null;
    for (let i = 0; i < 60 && !version; i += 1) {
      try {
        const r = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
        if (r.ok) version = await r.json();
      } catch { /* not up */ }
      if (!version) await sleep(250);
    }
    check(Boolean(version), 'Chrome never exposed a DevTools endpoint');

    if (version) {
      await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(`http://127.0.0.1:${port}/`)}`, { method: 'PUT' });
      let page = null;
      for (let i = 0; i < 40 && !page; i += 1) {
        const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
        page = list.find((t) => t.type === 'page' && t.url.startsWith('http'));
        if (!page) await sleep(250);
      }
      check(Boolean(page), 'no page target appeared');

      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => {
          ws.addEventListener('open', res, { once: true });
          ws.addEventListener('error', () => rej(new Error('CDP socket failed')), { once: true });
        });
        let id = 0;
        const pending = new Map();
        const consoleErrors = [];
        ws.addEventListener('message', (ev) => {
          const msg = JSON.parse(ev.data);
          if (msg.id && pending.has(msg.id)) {
            const { res, rej } = pending.get(msg.id);
            pending.delete(msg.id);
            msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
            return;
          }
          if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
            consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? '?').join(' '));
          }
          if (msg.method === 'Runtime.exceptionThrown') {
            consoleErrors.push(msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text ?? 'exception');
          }
        });
        const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
        const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.value;

        await send('Runtime.enable');
        await send('Page.enable');
        await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });

        let cards = 0;
        for (let i = 0; i < 80 && !cards; i += 1) {
          cards = (await evaluate('document.querySelectorAll(".react-flow__node").length')) ?? 0;
          if (!cards) await sleep(250);
        }
        check(cards > 0, 'the room rendered no cards, so nothing could be clicked');

        if (cards > 0) {
          const outcome = await evaluate(`(async () => {
            const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
            // Click the TASK's own card. The first .react-flow__node is the start bookend,
            // and commenting on "start" is correctly REFUSED by the engine ("Task not found
            // in backlog: start") — a real refusal, but not the write this gate asserts.
            const node = document.querySelector('.react-flow__node[data-id="${taskId}"]');
            if (!node) return { step: 'no-task-node', ids: [...document.querySelectorAll('.react-flow__node')].map((n) => n.getAttribute('data-id')) };
            // React Flow listens for pointer events; dispatch the pair a real click makes.
            for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
              node.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
            }
            await sleep(500);
            const inspector = document.querySelector('.flow-inspector');
            if (!inspector) return { step: 'no-inspector' };
            const button = [...inspector.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'Comment');
            if (!button) return { step: 'no-comment-button', buttons: [...inspector.querySelectorAll('button')].map((b) => (b.textContent || '').trim()) };
            // The Comment button is INERT without a draft ("if (!draft.trim()) return"), which
            // is honest UI — don't offer to comment nothing. So fill the composer the way a
            // person would, through React's own value setter, before clicking.
            const input = inspector.querySelector('.flow-input');
            if (!input) return { step: 'no-composer' };
            const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            setValue.call(input, 'gate: the write must reach the engine');
            input.dispatchEvent(new Event('input', { bubbles: true }));
            await sleep(250);
            button.click();
            await sleep(500);
            const early = document.querySelector('.flow-toast');
            await sleep(1300);
            const late = document.querySelector('.flow-toast');
            const seen = early ?? late;
            return {
              step: 'clicked',
              toast: seen ? seen.textContent.replace(/\\s+/g, ' ').trim() : null,
              toastAt500: early ? early.textContent.replace(/\\s+/g, ' ').trim() : null,
              toastAt1800: late ? late.textContent.replace(/\\s+/g, ' ').trim() : null,
              commentDisabled: button.disabled === true,
              inspectorButtons: [...inspector.querySelectorAll('button')].map((b) => (b.textContent || '').trim()),
            };
          })()`);

          if (outcome) console.log(`  click-through: ${JSON.stringify(outcome).slice(0, 400)}`);
          if (consoleErrors.length) console.log(`  console: ${consoleErrors.slice(0, 3).join(' | ').slice(0, 300)}`);

          check(outcome?.step === 'clicked',
            `the click-through did not reach the Comment action (${JSON.stringify(outcome)?.slice(0, 200)})`);

          // the assertion that matters: the ENGINE got the row
          const journalFile = join(pbRoot, 'memory', 'journal.ndjson');
          const rows = readFileSync(journalFile, 'utf8').split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
          const comments = rows.filter((r) => r.action === 'comment');
          check(comments.length === 1,
            `the scratch journal holds ${comments.length} comment row(s), expected exactly 1 — the UI click did not reach the engine`);
          check(comments[0]?.task === taskId, `the comment landed on ${comments[0]?.task}, expected ${taskId}`);
          check(String(comments[0]?.notes ?? '').includes('gate task'),
            `the comment text is ${JSON.stringify(comments[0]?.notes)}, expected the card title`);

          const shown = String(outcome?.toast ?? '');
          check(/Steering applied/i.test(shown),
            `the toast did not report the write: ${shown.slice(0, 160)}`);
          check(!/nothing written/i.test(shown),
            `the toast still claims nothing was written even though the engine recorded a row: ${shown.slice(0, 160)}`);
        }
        ws.close();
      }
    }
  } else if (!CHROME) {
    problems.push('no Chrome/Edge found — the click-through could not run');
  }
} catch (err) {
  problems.push(`harness error: ${String(err?.message ?? err).split('\n')[0]}`);
} finally {
  if (browser && browser.exitCode === null) killTree(browser.pid);
  if (server && server.exitCode === null) killTree(server.pid);
  if (profile) { try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ } }
  rmSync(work, { recursive: true, force: true });
}

console.log('Room write path — Comment/Steer → pb comment → journal');
console.log('  static  : live adapter overrides applySteering; both submit paths await it; toast branches on persisted');
console.log('  dynamic : a real click on a real card writes exactly one journal row in a scratch playbook');

if (problems.length) {
  console.error(`\nWRITE WIRING FAILED (${problems.length} problem(s)):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('\nClicking Comment in the room writes a journal row the engine can show.');
