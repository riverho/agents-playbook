#!/usr/bin/env node
// ============================================================================
//  check-app-render.mjs — the Flow room actually RENDERS, and renders the graph.
// ----------------------------------------------------------------------------
//  Why a browser and not `vite build`: a build proves the modules resolve. It
//  cannot see a missing stylesheet, a token that never arrived, or a projection
//  that yields zero nodes. This app has all three failure modes available (the
//  React Flow base stylesheet reaches Wenmei's bundle from outside the room, and
//  the room's palette was subset out of another repo's theme), so the gate is a
//  real render: serve dist, drive Chrome over the DevTools Protocol, and assert
//  what is in the DOM.
//
//  Zero dependencies on purpose — Node 22+ ships a global WebSocket, and the
//  static server is node:http. Nothing here needs Playwright or the network.
//
//  Usage: node scripts/check-app-render.mjs [--keep] [--url <url>] [--shot <path>]
//    default: serves apps/flow-room/dist on an ephemeral port, launches Chrome,
//             asserts, writes artifacts/app-deploy/frames/flow-room-render.png
// ============================================================================

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'apps', 'flow-room', 'dist');
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};
const SHOT = flag('--shot', join(ROOT, 'artifacts', 'app-deploy', 'frames', 'flow-room-render.png'));
const EXPLICIT_URL = flag('--url', null);
const KEEP = argv.includes('--keep');

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

const problems = [];
const log = (msg) => console.log(msg);

// ── 1. serve the app AND the engine API ─────────────────────────────────────
// Not a static directory any more. The app asks /api/health whether an engine is behind
// the page and shows an explicit "no engine" state when none answers — so a static
// file server would now exercise the wrong branch. This runs the REAL server against
// this playbook: read-only traffic (GET /api/health, GET /api/graph), and the server
// writes nothing on startup, which scripts/test-app-live-api.mjs proves.
const SERVER = join(ROOT, 'apps', 'flow-room', 'server.mjs');

async function startEngineServer() {
  if (!existsSync(join(DIST, 'index.html'))) {
    throw new Error(`no build at ${DIST} — run: npm --prefix apps/flow-room run build`);
  }
  const port = 9800 + Math.floor(Math.random() * 300);
  const child = spawn(process.execPath, [SERVER, '--root', ROOT, '--port', String(port), '--no-open'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Keep the server's own output: a gate whose server dies silently can only say
  // "never answered", which is exactly the useless failure mode this project refuses.
  let stderr = '';
  child.stderr?.on('data', (d) => { stderr += String(d); });
  child.stdout?.on('data', () => {});
  for (let i = 0; i < 60; i += 1) {
    if (child.exitCode !== null) {
      throw new Error(`the engine server exited ${child.exitCode} before answering.\n${stderr.trim()}`);
    }
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) return { child, port, health: await r.json() };
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  child.kill();
  throw new Error(`the engine server never answered on http://127.0.0.1:${port}.\n${stderr.trim()}`);
}

// ── 2. a minimal CDP client (WebSocket is global in Node 22+) ───────────────
async function openPage(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('CDP socket failed')), { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  const consoleErrors = [];
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(`${msg.error.message}`)) : res(msg.result);
      return;
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? '?').join(' '));
    }
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      consoleErrors.push(msg.params.entry.text);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      consoleErrors.push(d.exception?.description ?? d.text);
    }
  });
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = ++nextId;
      pending.set(id, { res, rej });
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { send, consoleErrors, close: () => ws.close() };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 3. run ──────────────────────────────────────────────────────────────────
let server;
let browser;
let profile;
let port;
try {
  let engineHealth = null;
  if (EXPLICIT_URL) {
    port = null;
  } else {
    // A random port can collide; retry rather than become a flaky gate (this project's
    // rule: a flaky gate is worse than a weaker deterministic one).
    let started = null;
    let lastErr = null;
    for (let attempt = 0; attempt < 3 && !started; attempt += 1) {
      try {
        started = await startEngineServer();
      } catch (err) {
        lastErr = err;
      }
    }
    if (!started) throw lastErr;
    server = started.child;
    port = started.port;
    engineHealth = started.health;
  }
  const url = EXPLICIT_URL ?? `http://127.0.0.1:${port}/`;

  if (!CHROME) {
    console.error('no Chrome/Edge found — cannot render');
    process.exit(1);
  }

  const debugPort = 9500 + Math.floor(Math.random() * 400);
  profile = mkdtempSync(join(tmpdir(), 'flow-room-render-'));
  browser = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-first-run',
      '--disable-extensions',
      '--hide-scrollbars',
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profile}`,
      '--window-size=1600,1000',
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

  // wait for the DevTools endpoint
  let version = null;
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
      if (r.ok) {
        version = await r.json();
        break;
      }
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  if (!version) throw new Error('Chrome never exposed a DevTools endpoint');
  log(`browser: ${version.Browser}`);

  // open the page as a tab and attach to it
  await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  let page = null;
  for (let i = 0; i < 40 && !page; i += 1) {
    const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    page = list.find((t) => t.type === 'page' && t.url.startsWith('http'));
    if (!page) await sleep(250);
  }
  if (!page) throw new Error('no page target appeared');
  log(`page: ${page.url}`);

  const cdp = await openPage(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url });

  // poll until React Flow has mounted nodes (or give up honestly)
  const evaluate = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return r.result?.value;
  };
  let nodes = 0;
  for (let i = 0; i < 80; i += 1) {
    nodes = (await evaluate('document.querySelectorAll(".react-flow__node").length')) ?? 0;
    if (nodes > 0) break;
    await sleep(250);
  }

  const facts = await evaluate(`(() => {
    const q = (s) => document.querySelectorAll(s).length;
    const chipbar = document.querySelector('.flow-chipbar');
    return {
      nodes: q('.react-flow__node'),
      cards: q('.flow-card'),
      edges: q('.react-flow__edge'),
      controls: q('.react-flow__controls'),
      minimap: q('.react-flow__minimap'),
      handles: q('.react-flow__handle'),
      chipbar: chipbar ? chipbar.textContent.trim().slice(0, 160) : null,
      legend: q('.flow-legend'),
      bodyBg: getComputedStyle(document.body).backgroundColor,
      roomBg: (() => { const r = document.querySelector('.flow-room'); return r ? getComputedStyle(r).backgroundColor : null; })(),
      footer: (() => { const d = [...document.querySelectorAll('div')].find((el) => el.textContent?.trim().startsWith('live ·')); return d ? d.textContent.trim().slice(0, 160) : null; })(),
      noEngine: document.body.innerText.includes('No local engine'),
      // Tailwind utilities must be IN EFFECT, not merely present in the class list. The
      // first extracted stylesheet dropped its @tailwind directives, so every utility
      // class in the room's JSX was inert — .inline-flex and .tabular-nums appeared in no
      // rule at all. This asserts the computed style, which is what a reader sees.
      utilProbe: (() => {
        const tn = document.querySelector('.tabular-nums');
        const ws = document.querySelector('.whitespace-nowrap');
        const fl = document.querySelector('.inline-flex');
        return {
          tabular: tn ? getComputedStyle(tn).fontVariantNumeric : null,
          whiteSpace: ws ? getComputedStyle(ws).whiteSpace : null,
          // informational only: a room rule may legitimately win over this utility, so it
          // is NOT asserted — which is why inline-flex computes to flex here.
          inlineFlex: fl ? getComputedStyle(fl).display : null,
        };
      })(),
    };
  })()`);

  log(`\nrendered: ${facts.nodes} node(s), ${facts.cards} card(s), ${facts.edges} edge(s), ` +
      `${facts.handles} handle(s), controls ${facts.controls}, minimap ${facts.minimap}, legend ${facts.legend}`);
  log(`chipbar: ${facts.chipbar ?? '(none)'}`);
  log(`room background: ${facts.roomBg}`);

  // the LIVE path must be the branch that rendered — a static fixture render would
  // have passed every check below while the app was actually showing "no engine"
  if (engineHealth) {
    if (engineHealth.root !== ROOT) {
      problems.push(`the engine answered for ${engineHealth.root}, expected ${ROOT}`);
    }
    if (facts.noEngine) {
      problems.push('the app rendered its no-engine state even though the engine answered /api/health');
    }
    if (!facts.footer) {
      problems.push('the app reported no live footer — it is not rendering the live graph');
    }
  }
  if (facts.footer) log(`footer: ${facts.footer}`);
  log(`utilities: tabular-nums → ${facts.utilProbe?.tabular ?? '(absent)'} · whitespace-nowrap → ${facts.utilProbe?.whiteSpace ?? '(absent)'} · inline-flex (unasserted) → ${facts.utilProbe?.inlineFlex ?? '(absent)'}`);
  if (!facts.utilProbe?.tabular) {
    problems.push('no .tabular-nums element exists — this assertion stopped watching anything');
  } else if (!/tabular-nums/.test(facts.utilProbe.tabular)) {
    problems.push(`.tabular-nums computed to "${facts.utilProbe.tabular}" — the Tailwind utilities are not in effect (missing @tailwind directives)`);
  }
  if (!facts.utilProbe?.whiteSpace) {
    problems.push('no .whitespace-nowrap element exists — this assertion stopped watching anything');
  } else if (facts.utilProbe.whiteSpace !== 'nowrap') {
    problems.push(`.whitespace-nowrap computed to "${facts.utilProbe.whiteSpace}" — the Tailwind utilities are not in effect`);
  }

  // the assertions
  if (!facts.nodes) problems.push('no React Flow nodes in the DOM — the graph never mounted');
  if (facts.cards < 15) problems.push(`only ${facts.cards} card(s) rendered (expected >= 15)`);
  if (!facts.controls) problems.push('the zoom controls did not render');
  if (!facts.legend) problems.push('the legend did not render');
  if (!facts.chipbar || !/graph|sample|layer/i.test(facts.chipbar)) {
    problems.push(`the status chipbar is missing or unexpected: ${facts.chipbar}`);
  }
  // React Flow's own stylesheet must be in effect, or handles/edges are invisible
  if (!facts.handles) problems.push('no .react-flow__handle — the React Flow base stylesheet is not applied');
  if (facts.roomBg === 'rgba(0, 0, 0, 0)') {
    problems.push('the room has a transparent background — the token layer did not arrive');
  }
  if (cdp.consoleErrors.length) {
    for (const e of cdp.consoleErrors.slice(0, 8)) problems.push(`console error: ${e.split('\n')[0]}`);
  }

  // the picture, for a human
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
  const size = readFileSync(SHOT).length;
  log(`screenshot: ${SHOT} (${Math.round(size / 1024)} KB)`);
  if (size < 20000) problems.push(`the screenshot is suspiciously small (${size} bytes) — likely a blank page`);

  cdp.close();
} catch (err) {
  problems.push(`render harness failed: ${err.message}`);
} finally {
  if (browser && !KEEP) {
    browser.kill();
    // A Chrome profile still held by the OS makes rmSync throw. Silently swallowing that is
    // how %TEMP% reached 185 stale fixture directories (plan-20261010-008) — so: give the
    // handle a moment, retry, and if it still will not go, say so out loud.
    await sleep(600);
  }
  if (server) server.kill();
  if (profile && !KEEP) {
    let removed = false;
    for (let attempt = 0; attempt < 5 && !removed; attempt += 1) {
      try {
        rmSync(profile, { recursive: true, force: true });
        removed = !existsSync(profile);
      } catch {
        await sleep(400);
      }
    }
    if (!removed) console.error(`note: left the browser profile on disk (still held): ${profile}`);
  }
}

if (problems.length) {
  console.error(`\nRENDER FAILED (${problems.length} problem(s)):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('\nRender holds: the room mounts, lays out the graph, and is styled.');
