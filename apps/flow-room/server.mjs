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
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPrompt, detectHarnesses, sendToHarness } from './harness.mjs';

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
// The identity a harness stamps on an AGENT shell. A person's decision made through the
// room must not inherit it: a server started from an agent's terminal would otherwise have
// every `pb decide` refused as an agent shell (checker note on plan-20261010-015).
const AGENT_SHELL_VARS = ['PB_RUNTIME', 'PB_SESSION_ID', 'PB_AGENT_CHAIN', 'PB_PARENT_AGENT_ID', 'PB_CLAIM_TOKEN', 'PB_AGENT_ID'];
function personEnv() {
  const env = { ...process.env };
  for (const k of AGENT_SHELL_VARS) delete env[k];
  return env;
}

function runPb(root, args, { timeoutMs = 60000, env } = {}) {
  return new Promise((res) => {
    execFile(
      process.execPath,
      [join(root, 'scripts', 'pb.mjs'), ...args],
      { cwd: root, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, ...(env ? { env } : {}) },
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

// the journal file's identity at the last /api/state answer: unchanged → 304 without pb
let stateCache = null;
function journalStat() {
  try { const st = statSync(join(ROOT, 'memory', 'journal.ndjson')); return { size: st.size, mtimeMs: st.mtimeMs }; } catch { return null; }
}

let askSlots = 0;
const MAX_ASKS = 2;

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
      routes: ['/api/graph', '/api/task/<id>', '/api/comment', '/api/steer', '/api/attach', '/api/fork', '/api/worker', '/api/decide', '/api/harness', '/api/ask', '/api/state', '/api/history', '/api/graph?version='],
    });
  }

  // ── D25: state, versions and history (all reads; refresh adds no write path — S3) ──
  if (path === '/api/state' && req.method === 'GET') {
    // S4: the room sends the journal seq it last saw. If the journal file has not changed
    // since the seq we last computed for it, answer 304 without running pb at all.
    const since = url.searchParams.get('since');
    const stat = journalStat();
    if (since !== null && stat && stateCache && stateCache.size === stat.size && stateCache.mtimeMs === stat.mtimeMs
      && stateCache.token === since) {
      res.writeHead(304, { 'cache-control': 'no-store', 'x-pb-change-token': stateCache.token });
      return res.end();
    }
    const r = await runPb(ROOT, ['state', '--json']);
    if (r.code !== 0) return json(res, 502, { error: 'pb state failed', detail: r.stderr.trim() });
    let body;
    try { body = JSON.parse(r.stdout); } catch { return json(res, 502, { error: 'pb state did not return JSON' }); }
    if (stat) stateCache = { size: stat.size, mtimeMs: stat.mtimeMs, token: body.change_token };
    if (since !== null && body.change_token === since) {
      res.writeHead(304, { 'cache-control': 'no-store', 'x-pb-change-token': body.change_token });
      return res.end();
    }
    return json(res, 200, body);
  }
  if (path === '/api/history' && req.method === 'GET') {
    const r = await runPb(ROOT, ['version', 'list', '--json']);
    if (r.code !== 0) return json(res, 502, { error: 'pb version list failed', detail: r.stderr.trim() });
    try { return json(res, 200, JSON.parse(r.stdout)); } catch { return json(res, 502, { error: 'pb version list did not return JSON' }); }
  }

  if (path === '/api/graph' && req.method === 'GET') {
    const version = url.searchParams.get('version');
    if (version !== null && !/^[\w.\-· ]+$/.test(version)) return json(res, 400, { error: 'version must be a version name or loop id' });
    const r = await runPb(ROOT, version ? ['graph', '--json', '--version', version] : ['graph', '--json']);
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
  if (path === '/api/decide' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body || typeof body.task !== 'string' || !/^[\w][\w.-]*$/.test(body.task) ||
        typeof body.option !== 'string' || !/^[\w][\w.-]*$/.test(body.option) ||
        typeof body.reason !== 'string' || !body.reason.trim() || body.reason.trim().startsWith('-')) {
      return json(res, 400, { error: 'expected { task: id, option: id, reason: non-empty text not starting with "-" }' });
    }
    const r = await runPb(ROOT, ['decide', '--task', body.task, '--option', body.option, '--reason', body.reason.trim(), '--agent', 'human'], { env: personEnv() });
    if (r.code !== 0) return json(res, 422, { error: 'pb decide refused', detail: r.stderr.trim() || r.stdout.trim() });
    const seq = /\(seq (\d+)/.exec(r.stdout)?.[1];
    const shown = await runPb(ROOT, ['runcard', 'show', body.task, '--json']);
    let row = null;
    try { row = JSON.parse(shown.stdout)?.journal?.find(row => row.seq === Number(seq)) ?? null; } catch { /* reported below */ }
    if (!row) return json(res, 502, { error: 'decision was recorded, but its row could not be read', detail: r.stdout.trim() });
    return json(res, 200, { ok: true, row, output: r.stdout.trim() });
  }
  if (path === '/api/comment' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body || typeof body.task !== 'string' || typeof body.text !== 'string' || !body.text.trim()) {
      return json(res, 400, { error: 'expected { task: string, text: non-empty string }' });
    }
    // M3: a person's message says why it was written; the engine stamps the intent
    const intent = body.intent === undefined ? 'comment' : String(body.intent);
    if (!['comment', 'steer', 'question'].includes(intent)) {
      return json(res, 400, { error: 'intent must be comment, steer or question' });
    }
    const r = await runPb(ROOT, ['comment', '--task', body.task, '--text', body.text, '--intent', intent]);
    if (r.code !== 0) {
      return json(res, 422, { error: 'pb comment refused', task: body.task, detail: r.stderr.trim() || r.stdout.trim() });
    }
    const seq = /\(seq (\d+)/.exec(r.stdout);
    return json(res, 200, { ok: true, task: body.task, intent, seq: seq ? Number(seq[1]) : null, wrote: `journal row (action: comment, intent: ${intent})` });
  }

  if (path === '/api/steer' && req.method === 'POST') {
    const body = await readBody(req);
    const tasks = Array.isArray(body?.tasks) ? body.tasks : [];
    if (!tasks.length || typeof body?.text !== 'string' || !body.text.trim()) {
      return json(res, 400, { error: 'expected { tasks: [ids], text: non-empty string, goal?: {stop} }' });
    }
    // Input LENGTH is not an input value. On Windows an over-long argv makes execFile throw
    // synchronously, the handler's catch turns it into a 500 ("spawn ENAMETOOLONG"), and the
    // contract said 400/422/200 — so the limit is stated here instead.
    const MAX_FIELD = 8000;
    for (const [field, value] of [['text', body.text], ['goal', body?.goal]]) {
      if (value !== undefined && value !== null && String(value).length > MAX_FIELD) {
        return json(res, 400, { error: `${field} is longer than ${MAX_FIELD} characters` });
      }
    }
    const rows = [];
    for (const task of tasks) {
      const r = await runPb(ROOT, ['comment', '--task', String(task), '--text', body.text, '--intent', 'steer']);
      rows.push({ task, ok: r.code === 0, detail: r.code === 0 ? undefined : r.stderr.trim() });
    }
    // The goal half of a steer edits the OPEN cycle brief's stop condition. `pb cycle --edit` is
    // that primitive; a refusal from it is reported verbatim rather than as a silent no-op.
    // `goal_requested` is reported explicitly, because a whitespace goal is NOT a request: without
    // this the room turned "nothing was asked" into "the engine refused the edit".
    const goalText = body?.goal === undefined || body?.goal === null ? '' : String(body.goal).trim();
    const goalRequested = goalText.length > 0;
    let goalApplied = false;
    let goalNote;
    let goalDiff;
    if (goalRequested) {
      if (goalText.startsWith('-')) return json(res, 400, { error: 'a goal may not start with "-"' });
      const g = await runPb(ROOT, ['cycle', '--edit', '--stop', goalText, '--json']);
      goalApplied = g.code === 0;
      if (goalApplied) {
        try {
          const parsed = JSON.parse(g.stdout);
          const beforeStop = String(parsed?.cycle_edit?.before?.stop ?? '');
          goalDiff = { from: beforeStop, to: String(parsed?.cycle_edit?.after?.stop ?? goalText) };
        } catch { goalDiff = { from: '', to: goalText }; }
      } else {
        goalNote = g.stderr.trim() || g.stdout.trim();
      }
    }
    return json(res, 200, {
      ok: rows.every((r) => r.ok) && (!goalRequested || goalApplied),
      rows,
      goal_requested: goalRequested,
      goal_applied: goalApplied,
      goal_note: goalApplied ? undefined : goalNote,
      goal: goalDiff,
    });
  }

  if (path === '/api/fork' && req.method === 'POST') {
    const body = await readBody(req);
    if (typeof body?.goal !== 'string' || !body.goal.trim()) {
      return json(res, 400, { error: 'expected { goal: non-empty string, from?: task id, check?: command }' });
    }
    // every value becomes an argument to pb: nothing may start with "-" (it would be read
    // as a flag), and ids and layers must look like ids
    const ID = /^[\w][\w.-]*$/;
    if (body.goal.trim().startsWith('-')) return json(res, 400, { error: 'a goal may not start with "-"' });
    for (const k of ['from', 'layer']) {
      if (body[k] !== undefined && body[k] !== null && body[k] !== '' && !ID.test(String(body[k]))) {
        return json(res, 400, { error: `${k} must be an id (letters, digits, . _ -), got ${JSON.stringify(body[k])}` });
      }
    }
    if (body.check && String(body.check).trim().startsWith('-')) return json(res, 400, { error: 'a check may not start with "-"' });
    const argv = ['plan', '--goal', body.goal.trim()];
    if (body.from) argv.push('--dep', String(body.from));
    if (body.check) argv.push('--check', String(body.check));
    if (body.layer) argv.push('--layer', String(body.layer));
    const r = await runPb(ROOT, argv);
    if (r.code !== 0) {
      return json(res, 422, { error: 'pb plan refused', detail: r.stderr.trim() || r.stdout.trim() });
    }
    const id = /Planned \[([^\]]+)\]/.exec(r.stdout);
    return json(res, 200, { ok: true, task: id ? id[1] : null, output: r.stdout.trim() });
  }

  // v2 fork (D22): a worker slot for a card, through the engine's own command. The room
  // never creates a worktree itself; pb worker create is atomic and refuses a taken slot.
  if (path === '/api/worker' && req.method === 'POST') {
    const body = await readBody(req);
    if (typeof body?.task !== 'string' || !/^[\w.-]+$/.test(body.task)) {
      return json(res, 400, { error: 'expected { task: task id }' });
    }
    // a fork is work in parallel on an OPEN card: a done card has nothing left to fork
    const shown = await runPb(ROOT, ['task', 'show', body.task, '--json']);
    if (shown.code !== 0) return json(res, 422, { error: 'pb task show refused', detail: shown.stderr.trim() || shown.stdout.trim() });
    let status = null;
    try { status = JSON.parse(shown.stdout)?.task?.status ?? null; } catch { /* not json */ }
    if (status === 'done') return json(res, 409, { error: 'the card is done', detail: `[${body.task}] is done — there is nothing left to fork. Draft a follow-up instead.` });
    const r = await runPb(ROOT, ['worker', 'create', body.task, '--agent', 'room', '--execute']);
    if (r.code !== 0) {
      return json(res, 422, { error: 'pb worker create refused', detail: r.stderr.trim() || r.stdout.trim() });
    }
    return json(res, 200, { ok: true, task: body.task, output: r.stdout.trim() });
  }

  // ── P4b: chat with a harness, if one is on this machine (plan-20261010-015) ──
  if (path === '/api/harness' && req.method === 'GET') {
    const available = detectHarnesses();
    return json(res, 200, {
      available,
      note: available.length ? undefined : 'no harness CLI found on PATH (claude, codex, opencode) — questions are recorded in the journal, not dispatched',
    });
  }
  if (path === '/api/ask' && req.method === 'POST') {
    // at most two harness runs at once: each is a model session, not a cheap request
    if (askSlots >= MAX_ASKS) return json(res, 429, { error: `already answering ${askSlots} question(s); try again when one finishes` });
    // reserve the slot NOW, before any await (simultaneous asks once all slipped past the
    // check), and give it back when this response closes — whichever way it ends
    askSlots += 1;
    res.on('close', () => { askSlots -= 1; });
    const body = await readBody(req);
    if (!body || typeof body.task !== 'string' || !/^[\w.-]+$/.test(body.task) || typeof body.text !== 'string' || !body.text.trim()) {
      return json(res, 400, { error: 'expected { task: task id, text: non-empty string, harness?: id }' });
    }
    // 1. ALWAYS record first: the question is a journal row whether or not anything answers
    const recorded = await runPb(ROOT, ['comment', '--task', body.task, '--text', body.text, '--intent', 'question']);
    if (recorded.code !== 0) {
      return json(res, 422, { error: 'pb comment refused', detail: recorded.stderr.trim() || recorded.stdout.trim() });
    }
    const seq = /\(seq (\d+)/.exec(recorded.stdout);
    const harness = typeof body.harness === 'string' ? detectHarnesses().find((h) => h.id === body.harness) : null;
    if (!harness) {
      return json(res, 200, {
        ok: true, recorded: true, seq: seq ? Number(seq[1]) : null, dispatched: false,
        note: body.harness ? `question recorded · not dispatched — no ${body.harness} harness on this machine` : 'question recorded · not dispatched — no harness chosen',
      });
    }
    // 2. dispatch, streamed as server-sent events
    const shown = await runPb(ROOT, ['task', 'show', body.task, '--json']);
    let title = body.task;
    try { title = JSON.parse(shown.stdout)?.task?.title ?? title; } catch { /* keep the id */ }
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const emit = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
    emit({ type: 'recorded', seq: seq ? Number(seq[1]) : null, harness: harness.id });
    const stop = sendToHarness(harness.id, buildPrompt({ task: body.task, title, text: body.text, root: ROOT }), {
      cwd: ROOT,
      onEvent: (ev) => { emit(ev); if (ev.type === 'done' || ev.type === 'error') res.end(); },
    });
    // the RESPONSE closing is the browser going away (the request body was read long ago,
    // so req's own close has already fired): stop the harness, don't let it run to its cap
    res.on('close', () => stop());
    return undefined;
  }

  if (path === '/api/attach' && req.method === 'POST') {
    // This used to answer 501, deliberately: attaching a document means writing a task's `docs:`
    // field, no pb command wrote it, and the room must not edit memory/backlog.yaml itself
    // (invariant 5). The primitive now exists — `pb attach` — so the route calls it and the room
    // stops being unable to do something the engine can.
    const body = await readBody(req);
    if (typeof body?.task !== 'string' || typeof body?.path !== 'string' || !body.path.trim()) {
      return json(res, 400, { error: 'expected { task: string, path: string (playbook-root-relative), label?: string }' });
    }
    const attachPath = body.path.trim();
    if (attachPath.startsWith('-')) return json(res, 400, { error: 'a path may not start with "-"' });
    if (attachPath.length > 400) return json(res, 400, { error: 'path is longer than 400 characters' });
    const argv = ['attach', '--task', body.task, '--path', attachPath];
    const label = body.label === undefined || body.label === null ? '' : String(body.label).trim();
    if (label) {
      if (label.startsWith('-')) return json(res, 400, { error: 'a label may not start with "-"' });
      argv.push('--label', label);
    }
    const r = await runPb(ROOT, argv);
    if (r.code !== 0) {
      // The engine's refusal, verbatim: a path that is absolute or missing is refused there, and
      // this route must not soften it into a success.
      return json(res, 422, { error: 'pb attach refused', task: body.task, detail: (r.stderr.trim() || r.stdout.trim()) });
    }
    const line = r.stdout.trim().split('\n')[0];
    const docs = /documents \((\d+)\)/.exec(r.stdout);
    return json(res, 200, { ok: true, task: body.task, path: attachPath, count: docs ? Number(docs[1]) : null, wrote: line });
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
