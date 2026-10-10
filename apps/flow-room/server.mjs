#!/usr/bin/env node
// ============================================================================
//  server.mjs — the Flow room's local server. Zero dependencies, on purpose.
// ----------------------------------------------------------------------------
//  What it is: node:http serving the built app from dist/ plus a thin /api/* that
//  SHELLS OUT to the playbook's own `scripts/pb.mjs`. It never imports the engine.
//  That is not laziness — every engine command reports refusal with process.exit(),
//  so an in-process call would kill this server instead of returning an error. As a
//  subprocess the exit code stays the contract, which is the whole project thesis.
//
//  The trust boundary, as invariants the code below holds:
//    1. bind 127.0.0.1 only — never 0.0.0.0
//    2. every POST needs the per-run session cookie AND a custom header. The header
//       is what stops a random local page (a different localhost port is same-site,
//       so SameSite alone would NOT): a cross-origin request carrying a custom
//       header must preflight, and we never answer a preflight with permission.
//    3. Origin, when present, must be our own
//    4. NOTHING is written on startup — no journal touch, no auto-comment. (This is
//       why the session secret lives in memory and a cookie rather than in a token
//       file: a token file would be a write, and a file a local process could read.)
//    5. the app never edits memory/backlog.yaml or the journal — every write is a
//       `pb` invocation, so the engine's lock, seq and refusal rules still own it
//    6. no playbook found → the app still serves, but /api refuses with a message
//       that names the missing thing
//
//  Usage: node server.mjs [--port N] [--root DIR] [--api-only] [--no-open]
// ============================================================================

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, 'dist');
const SESSION_COOKIE = 'pb_ui_session';
const CSRF_HEADER = 'x-pb-ui';

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

function printHelp() {
  console.log(`Flow room server (zero dependencies)

  node server.mjs [--port N] [--root DIR] [--api-only] [--no-open]

  --port N     listen port (default 4317)
  --root DIR   the playbook to read (default: nearest playbook.yaml above cwd)
  --api-only   serve /api/* only — for vite in dev, which proxies /api here
  --no-open    do not print the URL banner
`);
}

function parseArgs(argv) {
  const out = { port: 4317, root: null, apiOnly: false, banner: true };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--root') out.root = argv[++i];
    else if (a === '--api-only') out.apiOnly = true;
    else if (a === '--no-open') out.banner = false;
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else {
      // An unknown flag must never be silently ignored: this project filed exactly
      // that defect against `pb scaffold --goal`, which accepted and dropped a flag
      // and still printed success.
      console.error(`unknown argument: ${a}\n`);
      printHelp();
      process.exit(2);
    }
  }
  if (!Number.isInteger(out.port) || out.port <= 0 || out.port > 65535) {
    console.error(`bad --port: ${out.port}`);
    process.exit(2);
  }
  return out;
}

function findPlaybookRoot(start) {
  let dir = resolve(start);
  for (let i = 0; i < 50; i += 1) {
    if (existsSync(join(dir, 'playbook.yaml')) || existsSync(join(dir, 'playbook.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Run a pb command IN the playbook root. Resolves with the exit code; never throws. */
function runPb(root, args, { timeoutMs = 60000 } = {}) {
  return new Promise((res) => {
    execFile(
      process.execPath,
      [join(root, 'scripts', 'pb.mjs'), ...args],
      { cwd: root, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        res({
          code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
        });
      }
    );
  });
}

const args = parseArgs(process.argv.slice(2));
const ROOT = args.root ? findPlaybookRoot(args.root) : findPlaybookRoot(process.cwd());
const SESSION = randomUUID(); // per-run, in memory only — see invariant 4

function json(res, status, body) {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(text);
}

function readBody(req) {
  return new Promise((res) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1024 * 1024) req.destroy();
    });
    req.on('end', () => {
      if (!data) return res({});
      try { res(JSON.parse(data)); } catch { res(null); }
    });
  });
}

function cookiesOf(req) {
  const raw = req.headers.cookie ?? '';
  return new Map(
    raw.split(';').map((p) => {
      const i = p.indexOf('=');
      return i === -1 ? [p.trim(), ''] : [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    })
  );
}

/** Invariants 2 and 3, in one place. Returns an error string, or null when allowed. */
function refusalFor(req) {
  const origin = req.headers.origin;
  if (origin) {
    let host;
    try { host = new URL(origin).host; } catch { return 'bad Origin'; }
    if (host !== req.headers.host) return `cross-origin write refused (Origin ${origin})`;
  }
  if (req.headers[CSRF_HEADER] === undefined) return `missing ${CSRF_HEADER} header`;
  if (cookiesOf(req).get(SESSION_COOKIE) !== SESSION) return 'missing or stale session cookie';
  return null;
}

async function serveApi(req, res, url) {
  const path = url.pathname;

  // Mints the session cookie. Safe as a GET: the cookie alone never authorises a write
  // — every POST additionally needs the `x-pb-ui` header, which a cross-origin caller
  // cannot send without a preflight we refuse. Handing the cookie out here also means
  // /api is usable before `dist/` has been built.
  if (path === '/api/session' && req.method === 'GET') {
    res.writeHead(200, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'set-cookie': `${SESSION_COOKIE}=${SESSION}; HttpOnly; SameSite=Strict; Path=/`,
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (!ROOT) {
    return json(res, 503, {
      error: 'no playbook found',
      detail:
        'No playbook.yaml was found above this server or in --root, so there is no engine to read.',
      hint: 'Run with --root <playbook dir>, or start the server from inside a playbook.',
    });
  }

  const write = req.method === 'POST';
  if (write) {
    const refusal = refusalFor(req);
    if (refusal) return json(res, 403, { error: 'refused', detail: refusal });
  }
  if (req.method !== 'GET' && req.method !== 'POST') {
    return json(res, 405, { error: `method ${req.method} not allowed` });
  }

  if (path === '/api/health' && req.method === 'GET') {
    const version = await runPb(ROOT, ['help']);
    const v = /agents-playbook v([\d.]+)/.exec(version.stdout);
    return json(res, 200, {
      ok: true,
      root: ROOT,
      engine: v ? v[1] : null,
      routes: ['/api/graph', '/api/task/<id>', '/api/comment', '/api/steer', '/api/fork'],
    });
  }

  if (path === '/api/graph' && req.method === 'GET') {
    const r = await runPb(ROOT, ['graph', '--json']);
    if (r.code !== 0) return json(res, 502, { error: 'pb graph failed', code: r.code, detail: r.stderr.trim() });
    try {
      return json(res, 200, JSON.parse(r.stdout));
    } catch {
      return json(res, 502, { error: 'pb graph did not return JSON', detail: r.stdout.slice(0, 400) });
    }
  }

  const taskMatch = /^\/api\/task\/(.+)$/.exec(path);
  if (taskMatch && req.method === 'GET') {
    const id = decodeURIComponent(taskMatch[1]);
    const r = await runPb(ROOT, ['runcard', 'show', id, '--json']);
    if (r.code !== 0) {
      return json(res, 404, { error: 'no such task', task: id, detail: r.stderr.trim() || r.stdout.trim() });
    }
    try {
      return json(res, 200, JSON.parse(r.stdout));
    } catch {
      return json(res, 502, { error: 'runcard show did not return JSON' });
    }
  }

  // ── writes: each one is a pb invocation, never a direct file edit ──────────
  if (path === '/api/comment' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body || typeof body.task !== 'string' || typeof body.text !== 'string' || !body.text.trim()) {
      return json(res, 400, { error: 'expected { task: string, text: non-empty string }' });
    }
    const r = await runPb(ROOT, ['comment', '--task', body.task, '--text', body.text]);
    if (r.code !== 0) {
      return json(res, 422, { error: 'pb comment refused', task: body.task, detail: r.stderr.trim() || r.stdout.trim() });
    }
    return json(res, 200, { ok: true, task: body.task, wrote: 'journal row (action: comment)' });
  }

  if (path === '/api/steer' && req.method === 'POST') {
    const body = await readBody(req);
    const tasks = Array.isArray(body?.tasks) ? body.tasks : [];
    if (!tasks.length || typeof body?.text !== 'string' || !body.text.trim()) {
      return json(res, 400, { error: 'expected { tasks: [ids], text: non-empty string, goal?: {stop} }' });
    }
    const rows = [];
    for (const task of tasks) {
      const r = await runPb(ROOT, ['comment', '--task', String(task), '--text', body.text]);
      rows.push({ task, ok: r.code === 0, detail: r.code === 0 ? undefined : r.stderr.trim() });
    }
    // HONEST GAP: editing an OPEN cycle brief is not a pb primitive today
    // (`pb cycle --new` opens a new phase; nothing edits the current one's stop).
    // Rather than write memory/cycle.md from here — which invariant 5 forbids — the
    // goal half of a steer is reported as not applied.
    const goalApplied = false;
    return json(res, 200, {
      ok: rows.every((r) => r.ok),
      rows,
      goal_applied: goalApplied,
      goal_note: body?.goal
        ? 'not applied: the engine has no primitive to edit an open cycle brief (pb cycle --new opens a new phase)'
        : undefined,
    });
  }

  if (path === '/api/fork' && req.method === 'POST') {
    const body = await readBody(req);
    if (typeof body?.goal !== 'string' || !body.goal.trim()) {
      return json(res, 400, { error: 'expected { goal: non-empty string, from?: task id, check?: command }' });
    }
    const argv = ['plan', '--goal', body.goal];
    if (body.from) argv.push('--dep', String(body.from));
    if (body.check) argv.push('--check', String(body.check));
    const r = await runPb(ROOT, argv);
    if (r.code !== 0) {
      return json(res, 422, { error: 'pb plan refused', detail: r.stderr.trim() || r.stdout.trim() });
    }
    const id = /Planned \[([^\]]+)\]/.exec(r.stdout);
    return json(res, 200, { ok: true, task: id ? id[1] : null, output: r.stdout.trim() });
  }

  if (path === '/api/attach' && req.method === 'POST') {
    // Deliberately not implemented rather than half-implemented: attaching a document
    // means writing the task's `docs:` field, and no pb command does that yet. Writing
    // memory/backlog.yaml from here would break invariant 5.
    return json(res, 501, {
      error: 'not implemented',
      detail:
        'attaching a document means setting a task\'s `docs:` field, and no `pb` command writes it yet. ' +
        'The room will not edit memory/backlog.yaml directly (the engine owns state and its lock).',
    });
  }

  return json(res, 404, { error: `no route ${path}` });
}

function serveStatic(req, res, url) {
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
  let file = resolve(DIST, rel);
  if (!file.startsWith(resolve(DIST))) {
    res.writeHead(403).end();
    return;
  }
  if (!existsSync(file)) file = join(DIST, 'index.html');
  if (!existsSync(file)) {
    res.writeHead(503, { 'content-type': 'text/plain' });
    res.end(`no build at ${DIST}\n\n  npm run build\n`);
    return;
  }
  const body = readFileSync(file);
  const headers = { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' };
  if (file.endsWith('index.html')) {
    // invariant 2's first half: the session cookie is handed out here, and only here
    headers['set-cookie'] = `${SESSION_COOKIE}=${SESSION}; HttpOnly; SameSite=Strict; Path=/`;
    headers['cache-control'] = 'no-store';
  }
  res.writeHead(200, headers);
  res.end(body);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? '127.0.0.1'}`);
  try {
    if (url.pathname.startsWith('/api/')) return await serveApi(req, res, url);
    if (req.method === 'OPTIONS') {
      // We never grant a preflight: a cross-origin writer gets no permission.
      res.writeHead(405).end();
      return;
    }
    if (args.apiOnly) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('api-only\n');
      return;
    }
    return serveStatic(req, res, url);
  } catch (err) {
    json(res, 500, { error: 'server error', detail: String(err?.message ?? err) });
  }
});

server.listen(args.port, '127.0.0.1', () => {
  if (!args.banner) return;
  console.log(`Flow room  →  http://127.0.0.1:${args.port}/`);
  console.log(`  playbook : ${ROOT ?? '(none found — /api will refuse until one is reachable)'}`);
  console.log(`  mode     : ${args.apiOnly ? 'api-only (vite serves the app in dev)' : 'app + api'}`);
});
