// scripts/lib-room-browser.mjs — the shared harness for the Flow room's browser gates.
// ----------------------------------------------------------------------------
// Serves the BUILT room (apps/flow-room/dist) through its real server against a playbook
// root, launches headless Chrome/Edge, and talks to the page over the DevTools Protocol.
// Zero dependencies (Node 22+ has a global WebSocket). Not a gate itself — imported by
// check-room-browser.mjs; check-app-render.mjs keeps its own copy of the same steps.
// ----------------------------------------------------------------------------
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DIST = join(ROOT, 'apps', 'flow-room', 'dist');
const SERVER = join(ROOT, 'apps', 'flow-room', 'server.mjs');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((p) => existsSync(p));

async function startServer(playbookRoot) {
  if (!existsSync(join(DIST, 'index.html'))) throw new Error(`no build at ${DIST} — run: npm --prefix apps/flow-room run build`);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const port = 9800 + Math.floor(Math.random() * 300);
    const child = spawn(process.execPath, [SERVER, '--root', playbookRoot, '--port', String(port), '--no-open'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (d) => { stderr += String(d); });
    child.stdout?.on('data', () => {});
    for (let i = 0; i < 60; i += 1) {
      if (child.exitCode !== null) break;
      try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); if (r.ok) return { child, port }; } catch { /* not up */ }
      await sleep(250);
    }
    child.kill();
    if (attempt === 2) throw new Error(`the room server never answered.\n${stderr.trim()}`);
  }
  throw new Error('unreachable');
}

async function openSocket(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('CDP socket failed')), { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  const errors = [];
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') errors.push(msg.params.args.map((a) => a.value ?? a.description ?? '?').join(' '));
  });
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++nextId;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { send, errors, close: () => ws.close() };
}

/**
 * Open the room. Returns { cdp, evaluate, close }. `url` skips the server (an already
 * running room); otherwise the built room is served against `playbookRoot`.
 */
export async function openRoom({ url = null, playbookRoot = ROOT, width = 1600, height = 1000 } = {}) {
  if (!CHROME) throw new Error('no Chrome/Edge found — cannot render');
  let server = null;
  let target = url;
  if (!target) {
    server = await startServer(playbookRoot);
    target = `http://127.0.0.1:${server.port}/`;
  }
  const debugPort = 9500 + Math.floor(Math.random() * 400);
  const profile = mkdtempSync(join(tmpdir(), 'flow-room-browser-'));
  const browser = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--disable-extensions', '--hide-scrollbars',
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, `--window-size=${width},${height}`, 'about:blank',
  ], { stdio: 'ignore' });
  const close = async () => {
    try { browser.kill(); } catch { /* gone */ }
    await sleep(600);
    if (server) server.child.kill();
    for (let a = 0; a < 5; a += 1) {
      try { rmSync(profile, { recursive: true, force: true }); if (!existsSync(profile)) break; } catch { await sleep(400); }
    }
    if (existsSync(profile)) console.error(`note: left the browser profile on disk (still held): ${profile}`);
  };
  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i += 1) {
      try { up = (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).ok; } catch { /* not up */ }
      if (!up) await sleep(250);
    }
    if (!up) throw new Error('Chrome never exposed a DevTools endpoint');
    await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' });
    let page = null;
    for (let i = 0; i < 40 && !page; i += 1) {
      const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
      page = list.find((t) => t.type === 'page');
      if (!page) await sleep(250);
    }
    if (!page) throw new Error('no page target appeared');
    const cdp = await openSocket(page.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    const evaluate = async (expression) => {
      const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result?.value;
    };
    const navigate = async () => {
      await cdp.send('Page.navigate', { url: target });
      for (let i = 0; i < 80; i += 1) {
        const n = await evaluate('document.querySelectorAll(".react-flow__node").length').catch(() => 0);
        const seam = await evaluate('!!window.__flowRoom').catch(() => false);
        if (n > 0 && seam) return n;
        await sleep(250);
      }
      throw new Error('the room never mounted any node (or the test seam window.__flowRoom is missing)');
    };
    return { cdp, evaluate, navigate, close, url: target };
  } catch (err) {
    await close();
    throw err;
  }
}
