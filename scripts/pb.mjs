#!/usr/bin/env node
// ============================================================================
//  pb — the Agent-Playbook loop CLI
// ----------------------------------------------------------------------------
//  One command per loop step, so agents move without friction:
//    status | next | record | report | validate | anchor | checkpoint |
//    loop | learn | run | ps | stop | list | scaffold | init | bootstrap | help
//
//  The honest core: a task is "done" when its acceptance_checks — executable
//  shell commands on the task itself — pass. `pb record --status done` runs
//  them and refuses to record on failure. Process documents don't keep the
//  loop honest; exit codes do.
//
//  Master-driven: every path comes from the master (playbook.yaml or
//  playbook.json) under `index` / `paths`, with sensible fallbacks. Drop this
//  file onto an existing project (even one using .json indexes) and it works —
//  the master tells it where everything lives.
//
//  Format-tolerant: index/config files may be .yaml or .json (js-yaml parses
//  both). Everything resolves relative to the master's folder, so the whole
//  playbook is carry-on.
//
//  Only dependency: js-yaml.
// ============================================================================

import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync, copyFileSync, cpSync, openSync, closeSync, statSync, lstatSync, unlinkSync, rmdirSync, readlinkSync, rmSync, readdirSync, mkdtempSync, renameSync } from 'node:fs';
import { execSync, execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve, dirname, join, isAbsolute, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import yaml from 'js-yaml';

// --- root + base helpers ---------------------------------------------------
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, '..');           // playbook root = parent of scripts/
const p = (...parts) => resolve(ROOT, ...parts);
const exists = (rel) => existsSync(p(rel));

function readText(rel) {
  return rel && existsSync(p(rel)) ? readFileSync(p(rel), 'utf8') : '';
}
function readData(rel) {
  // js-yaml.load parses both YAML and JSON content.
  const text = readText(rel);
  return text ? yaml.load(text) : null;
}
function firstExisting(cands, fallback) {
  for (const c of cands) if (existsSync(p(c))) return c;
  return fallback;
}
const nowISO = () => new Date().toISOString();
const today = () => nowISO().slice(0, 10);

// --- resolve the master, then derive every path from it --------------------
const MASTER = firstExisting(['playbook.yaml', 'playbook.json'], 'playbook.yaml');
// Guard the parse: a malformed master must never crash the CLI — anchor/checkpoint
// run inside runtime hooks on every turn, and a crash there would break the session.
let master = {};
let MASTER_ERR = null;
try { master = readData(MASTER) || {}; }
catch (e) { MASTER_ERR = e.message; }
const mIndex = master.index || {};
const mMem = mIndex.memory || {};
const mPaths = master.paths || {};

const PROCESS_INDEX = mIndex.processes_index || firstExisting(['processes/index.yaml', 'processes/index.json'], 'processes/index.yaml');
const SKILL_INDEX = mIndex.skills_index || firstExisting(['skills/index.yaml', 'skills/index.json'], 'skills/index.yaml');
const BACKLOG = mMem.backlog || 'memory/backlog.yaml';
const JOURNAL = mMem.journal || 'memory/journal.ndjson';
const PROJECT_MEMORY = mMem.project_memory || 'memory/project-memory.md';
const REPORTS_DIR = mPaths.reports || (mIndex.artifacts && mIndex.artifacts.reports) || 'artifacts/reports';
const MEMORY_DIR = dirname(BACKLOG) || 'memory';
const ENTRY = master.entry || 'SKILL.md';
const ALLOWED_STATUSES = (master.guardrails && master.guardrails.allowed_statuses) || ['todo', 'in_progress', 'blocked', 'done'];
const NORTH_STAR = (typeof master.north_star === 'string' && master.north_star.trim()) ? master.north_star.trim().replace(/\s+/g, ' ') : null;
// modes — persona packs mounted on the floor. DEFAULT_MODE is the fallback in the
// resolution chain (task.mode ?? loop.mode ?? default_mode). MODES is the id->file registry.
const DEFAULT_MODE = (typeof master.default_mode === 'string' && master.default_mode.trim()) ? master.default_mode.trim() : null;
const MODES = (master.modes && typeof master.modes === 'object' && !Array.isArray(master.modes)) ? master.modes : {};
const CYCLE = mMem.cycle || 'memory/cycle.md';
const LOOPS = mMem.loops || 'memory/loops.yaml';
const LESSONS = mMem.lessons || 'memory/lessons.ndjson';
const PROCESSES = mMem.processes || 'memory/processes.ndjson';
const ARTIFACTS_DIR = mPaths.artifacts || 'artifacts';
const LOOP_ARTIFACTS_DIR = join(ARTIFACTS_DIR, 'loops');

// --- safe execution helpers ------------------------------------------------
function resolveExecutable(file) {
  if (!file) return file;
  if (existsSync(file) || isAbsolute(file)) return file;
  const pathSep = process.platform === 'win32' ? ';' : ':';
  const pathExt = process.env.PATHEXT || (process.platform === 'win32' ? '.EXE;.CMD;.BAT;.COM' : '');
  const exts = pathExt.split(';').map((e) => e.toLowerCase()).filter(Boolean);
  for (const dir of (process.env.PATH || '').split(pathSep)) {
    for (const ext of exts) {
      const candidate = join(dir, file + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return file;
}

// On Windows, execFileSync/spawn with shell:false cannot launch .cmd/.bat shims
// (EINVAL — Node refuses to exec .bat/.cmd directly). The fix is to dispatch via
// `cmd.exe /d /c` so cmd.exe does PATHEXT lookup and runs npm.cmd / pnpm.cmd /
// yarn.cmd. Node's default Windows auto-quoting (when windowsVerbatimArguments
// is NOT set) joins argv elements with quoting for paths-with-spaces. Caveats:
// argv that contains cmd.exe-special chars (( ) < > & |) is passed verbatim —
// cmd.exe will interpret them. For those, callers should pre-shell-escape.
// Do NOT pass /s — /s + a quoted file path strips both quotes and breaks paths.
function runCommandSync(file, argv, opts = {}) {
  if (process.platform === 'win32') {
    return execFileSync('cmd.exe', ['/d', '/c', file, ...argv], opts);
  }
  return execFileSync(resolveExecutable(file), argv, opts);
}
function spawnCommand(file, argv, opts = {}) {
  if (process.platform === 'win32') {
    return spawn('cmd.exe', ['/d', '/c', file, ...argv], { ...opts, windowsHide: true });
  }
  return spawn(resolveExecutable(file), argv, { ...opts, windowsHide: true });
}

// Path helper for the tracked-state guard: a repo-relative POSIX path, or null when
// `child` is not inside `parent`. Both sides are normalised because git reports the
// toplevel with forward slashes while node's `resolve` uses backslashes on Windows —
// comparing them raw silently concludes "outside the repo" and disables the guard.
function relPosix(child, parent) {
  const norm = (s) => resolve(s).replace(/\\/g, '/').replace(/\/+$/, '');
  const c = norm(child);
  const p = norm(parent);
  if (c === p) return null;
  if (!c.startsWith(`${p}/`)) return null;
  return c.slice(p.length + 1);
}

function shellSplit(cmd) {  const out = [];
  let cur = '';
  let quote = null;
  // POSIX-ish quoting, with the rule that matters: a quote character is SYNTAX only
  // where a word begins. Treating it as syntax anywhere DELETED quotes that were
  // meant literally, so the ordinary command
  //     node -e "process.exit(require('fs').existsSync('x')?0:1)"
  // reached node as require(fs) and died with `The "id" argument must be of type
  // string` — a check that could never go green, whatever the work did. A quote
  // inside a word is now text, so the quoted argument survives intact.
  //
  // `started` exists for the empty quoted argument: `cmd ""` is a real argument that
  // must not vanish, and `cur.length` alone cannot tell `""` from no word at all.
  let started = false;
  const begin = () => { started = true; };
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      if (ch === '\\' && quote === '"') {
        const nxt = cmd[i + 1];
        if (nxt === '"' || nxt === '\\' || nxt === '$' || nxt === '`') { cur += nxt; i++; }
        else { cur += ch; }
      } else if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }
    } else {
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
        if (started) { out.push(cur); cur = ''; started = false; }
      } else if (ch === '"' || ch === "'") {
        if (!started) { quote = ch; begin(); }
        else cur += ch;
      } else if (ch === '\\') {
        const nxt = cmd[i + 1];
        if (nxt === '"' || nxt === "'") { cur += nxt; i++; begin(); }
        else { cur += ch; begin(); }
      } else {
        cur += ch; begin();
      }
    }
  }
  if (started) out.push(cur);
  return out;
}

function loopArtifactsRel(loopId, ...parts) {
  // Store relative artifact paths with forward slashes so the playbook stays
  // carry-on portable across Windows and POSIX.
  return join(LOOP_ARTIFACTS_DIR, loopId, ...parts).replace(/\\/g, '/');
}

// --- structured helpers ----------------------------------------------------
function readJournal() {
  return readText(JOURNAL)
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .map((l, i) => {
      try { return JSON.parse(l); }
      catch { return { __malformed: true, __line: i + 1, raw: l }; }
    });
}
// --- journal ordering + attribution (multi-agent) ----------------------------
// The journal is append-only, so file order IS write order — but ISO timestamps
// collide at millisecond resolution under concurrency and cannot answer "who
// wrote first". Every row therefore carries a monotonic `seq`, allocated from the
// same serialized transaction as the state touch, plus the writer's identity.
// This makes "who wrote what, in what order, and on whose behalf" a recorded
// fact rather than an inference from clocks.
function stampOrigin(entry, agent) {
  const origin = { origin_agent: agent };
  if (process.env.PB_AGENT_ID) origin.origin_agent_id = process.env.PB_AGENT_ID;
  if (process.env.PB_SESSION_ID) origin.origin_session_id = process.env.PB_SESSION_ID;
  if (process.env.PB_PARENT_AGENT_ID) origin.origin_parent_agent_id = process.env.PB_PARENT_AGENT_ID;
  if (process.env.PB_RUNTIME) origin.origin_runtime = process.env.PB_RUNTIME;
  return { ...entry, ...origin };
}
function journalSeq() {
  const who = resolveAgentId({});
  try {
    return withStateTxn((draft, ctx) => {
      const n = (typeof draft.__journal_seq === 'number' ? draft.__journal_seq : 0) + 1;
      draft.__journal_seq = n;
      draft.__seq = ctx.seq;
      draft.__written_at = nowISO();
      draft.__written_by = who;
      return n;
    }, { agent: who });
  } catch (e) {
    if (!(e instanceof StateTxnBusy)) throw e;
    console.error('WARNING: could not acquire the state lock to number a journal row — writing it unnumbered.');
    return undefined;
  }
}
function appendJournal(entry) {
  ensureDir(MEMORY_DIR);
  const agent = entry.agent || resolveAgentId({});
  const stamped = stampOrigin(entry, agent);
  if (typeof stamped.seq === 'number') {
    appendFileSync(p(JOURNAL), JSON.stringify(stamped) + '\n', 'utf8');
    return stamped;
  }
  const seq = journalSeq();
  appendFileSync(p(JOURNAL), JSON.stringify({ ...stamped, seq }) + '\n', 'utf8');
  return { ...stamped, seq };
}
// The ONE place that writes a task entry: merge the mutator's patch over the
// existing entry and stamp the ordering + attribution every write must carry.
// Every write path goes through here so no path can produce an unstamped entry —
// an unstamped entry is exactly what makes "who wrote last" unanswerable.
//
// Clearing a field needs explicit intent: `undefined` values are FILTERED OUT of a
// patch (so an absent key never erases data by accident), which silently made
// `pb release` leave `claimed_by`/`claim_token` behind — a leaked lease. A patch
// therefore clears fields by naming them in `__unset: [...]`.
function applyTaskMutation(taskId, mutator, ctx, agent) {
  const existing = (ctx.draft && ctx.draft[taskId]) || {};
  const patch = (typeof mutator === 'function' ? mutator({ ...existing }, ctx) : mutator) || {};
  const { __unset, ...rest } = patch;
  const clean = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
  const next = { ...existing, ...clean, seq: ctx.seq, updated_by: agent };
  for (const key of Array.isArray(__unset) ? __unset : []) delete next[key];
  ctx.draft[taskId] = next;
  return next;
}

// Commit a journal row AND the task-state touch inside ONE transaction, so append
// order and state-update order are the same order. Splitting them into two
// transactions is a protocol hole: two agents recording the same task can
// interleave as A-journal, B-journal, B-state, A-state, after which the journal
// credits B as last writer while the state credits A — the two records the user
// reads then disagree about who wrote last (observed as a flaky drift assertion
// before this existed).
//   journalEntry: row WITHOUT `seq` (the transaction allocates it)
//   mutator: (existing, ctx) => patch   — must NOT call appendJournal (same lock)
function commitIteration(taskId, journalEntry, mutator, { agent = 'agent', timeoutMs = 30000 } = {}) {
  ensureDir(MEMORY_DIR);
  try {
    return withStateTxn((draft, ctx) => {
      ctx.draft = draft;
      appendJournal({ ...journalEntry, seq: ctx.seq });
      return applyTaskMutation(taskId, mutator, ctx, agent);
    }, { agent, timeoutMs });
  } catch (e) {
    if (!(e instanceof StateTxnBusy)) throw e;
    console.error('ERROR: could not acquire the state lock (another agent is writing). Nothing was recorded — re-run.');
    return null;
  }
}
// The autonomous driver writes through the same multi-agent contract as any other
// writer: it presents the claim token it minted when it took the task. Without that,
// its rows would be stamped `ownership: unproven` — indistinguishable from an
// unentitled write, which is exactly what the ownership flag exists to spot. A caller
// with no token gets a recorded, WARNED unproven row rather than a silent one.
// --- tracked-state trap guard ------------------------------------------------
// The pb runtime state (memory/, artifacts/) is local truth and must NOT be committed
// to git: a tracked journal gets reverted by merges (checkout/stash), silently
// destroying records. This guard detects the trap.
//
// Ported from the upstream guard (commit 87153a1) with two fixes, because as written it
// could never fire on Windows — which is where it was needed:
//   1. the upstream used `execSync('git rev-parse --show-toplevel 2>/dev/null')`. That
//      redirect is POSIX shell syntax; under cmd.exe it fails, the try/catch swallows it,
//      and the function returns early EVERY time. Use execFileSync with stdio options —
//      no shell, no redirect, portable.
//   2. the upstream used `require('child_process')` inside this ESM module, where
//      `require` is undefined. Even past (1) it would have thrown a ReferenceError from
//      inside `pb validate`. The import already exists at the top of this file.
// The two are independent: (1) made it dead code, (2) made it a landmine if reached.
function trackedStateWarnings() {
  const warnings = [];
  const top = gitIn(ROOT, ['rev-parse', '--show-toplevel']);
  if (!top) return warnings; // not a git checkout — nothing to protect against
  const rel = relPosix(p(JOURNAL), top);
  if (!rel) return warnings; // journal lives outside this repo
  // `--error-unmatch` exits non-zero when the path is NOT tracked, which is the
  // healthy case; a missing file exits non-zero too and is equally fine.
  const tracked = gitIn(ROOT, ['ls-files', '--error-unmatch', rel]);
  if (!tracked) return warnings;

  warnings.push(`TRACKED-STATE TRAP: ${rel} is committed to git. Merges (checkout/stash) can revert it and silently erase records. Run \`git rm -r --cached ${rel.split('/')[0]}\` (or the whole playbook memory dir) to make pb state local.`);
  // A journal with records newer than its last commit is at immediate risk.
  const lastCommit = Number(gitIn(ROOT, ['log', '-1', '--format=%ct', '--', rel]) || 0);
  try {
    const rows = readJournal().filter((r) => r && !r.__malformed && r.ts);
    const newest = rows.reduce((m, r) => Math.max(m, new Date(r.ts).getTime() / 1000), 0);
    if (newest > lastCommit) {
      warnings.push(`  → ${rows.length} journal row(s) are NEWER than the journal's last commit (${lastCommit ? new Date(lastCommit * 1000).toISOString().slice(0, 19) : 'never committed'}): a merge can discard them.`);
    }
  } catch { /* journal may not exist yet */ }
  return warnings;
}
function recordAuto(loop, task, status, checksOutcome, notes, { agent = 'auto', claimToken = null } = {}) {
  const ownership = verifyTaskClaim(task.id, { agent, token: claimToken });
  const entry = {
    ts: nowISO(),
    loop_id: loop.id,
    task: task.id,
    agent,
    agent_id: agent,
    claimed_by: ownership.holder || agent,
    ownership: ownership.status,
    action: 'auto-execute',
    status,
    checks: checksOutcome,
    result: null,
    files: [],
    notes,
  };
  if (!ownership.ok) {
    entry.ownership_violation = true;
    console.error(`WARNING: [${task.id}] is held by "${ownership.holder}" but the auto runner (agent ${agent}) cannot prove ownership — recording anyway, flagged ownership=unproven.`);
  }
  commitIteration(task.id, entry, () => ({ status, updated_at: entry.ts }), { agent });
  console.log(`Recorded [${task.id}] auto-execute → ${status}${checksOutcome !== 'none' ? ` (checks: ${checksOutcome})` : ''} (ownership: ${entry.ownership})`);
}

const BACKLOG_STATE = join(dirname(BACKLOG), 'backlog-state.json');

// --- shared-state transaction (multi-agent safety) ---------------------------
// Every mutation of the shared state file goes through withStateTxn. The naive
// version of this code read the WHOLE state object, patched one task, and wrote
// the whole object back — so two agents whose read-modify-write windows overlapped
// silently discarded each other's work (lost update), and a crash mid-write could
// leave truncated JSON. Three guarantees instead:
//   1. SERIALIZED — a transaction holds an O_EXCL lock, so the read and the write
//      are one critical section. Reads stay lock-free (a rename is atomic).
//   2. ATOMIC — the new bytes land in a sibling temp file and are renamed over the
//      target, so a reader never sees a half-written object and a crash leaves the
//      previous revision intact.
//   3. ORDERED + ATTRIBUTED — each state change is stamped with a monotonic touch
//      sequence and the agent that made it, so "who wrote first / who wrote last"
//      is answerable from the records.
// Carry-on, like the claim lock: a lockfile and a rename, no daemon and no DB.
const STATE_LOCK = `${BACKLOG_STATE}.lock`;
// Test levers, not product surface:
//   PB_TXN_TEST_DELAY_MS      hold a writer INSIDE its critical section (serialized)
//   PB_TXN_TEST_PRELOCK_MS    hold a writer BEFORE it contends for the lock, so N
//                             processes arrive together instead of staggered by
//                             process start-up. Together these make the race
//                             adversarial: all writers pile up on the lock at once.
const TXN_TEST_DELAY_MS = Math.max(0, Number(process.env.PB_TXN_TEST_DELAY_MS) || 0);
const TXN_TEST_PRELOCK_MS = Math.max(0, Number(process.env.PB_TXN_TEST_PRELOCK_MS) || 0);
function txnTestDelay() {
  if (TXN_TEST_DELAY_MS > 0) busySleepMs(TXN_TEST_DELAY_MS);
}

// Atomic replace with a small retry: on Windows a rename over a file another
// process (or an indexer/AV scanner) holds open can fail transiently with
// EPERM/EBUSY/EACCES. Retry briefly, then fall back to a direct write so a
// mutation is never lost to a transient sharing violation.
function atomicReplace(absPath, text) {
  const tmp = `${absPath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, text, 'utf8');
  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      renameSync(tmp, absPath);
      return;
    } catch (e) {
      lastErr = e;
      if (!['EPERM', 'EBUSY', 'EACCES', 'EEXIST', 'ENOTEMPTY'].includes(e.code)) break;
      busySleepMs(20 * (attempt + 1));
    }
  }
  try { unlinkSync(tmp); } catch { /* best effort */ }
  if (process.env.PB_DEBUG) console.error(`[pb] atomicReplace retried past ${lastErr?.code}; writing in place`);
  writeFileSync(absPath, text, 'utf8');
}

function readBacklogState() {
  try {
    const text = readText(BACKLOG_STATE);
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

function writeBacklogState(state) {
  ensureDir(dirname(BACKLOG_STATE));
  atomicReplace(p(BACKLOG_STATE), JSON.stringify(state, null, 2) + '\n');
}

// Monotonic touch sequence stored INSIDE the object so the counter is versioned
// with the data it orders and needs no separate bookkeeping file. One increment
// per transaction: read the current value, hand it to the mutator, write it back.
function touchSeqOf(state) {
  return typeof state.__seq === 'number' ? state.__seq : 0;
}
function stateMeta(state) {
  return { seq: touchSeqOf(state), written_at: state.__written_at, written_by: state.__written_by };
}

// Serialized read-modify-write of the whole state object. `mutator(draft, ctx)`
// receives a fresh draft read INSIDE the lock and mutates it in place; it may
// return a value, which is passed back to the caller. Throws PB_TXN_BUSY if the
// lock cannot be taken (the caller decides whether that is fatal).
class StateTxnBusy extends Error {}
// Wait for the lock rather than failing fast: N agents sharing one backlog queue
// behind each other, and a transaction can legitimately run long (a `record
// --status done` runs acceptance_checks inside it). Giving up early would turn
// ordinary contention into a lost record. A genuinely stuck holder is handled by
// the age-based stale break in acquireLock, not by a short timeout.
function withStateTxn(mutator, { agent = 'agent', timeoutMs = 5 * 60_000 } = {}) {
  ensureDir(dirname(BACKLOG_STATE));
  if (TXN_TEST_PRELOCK_MS > 0) busySleepMs(TXN_TEST_PRELOCK_MS);
  if (acquireLock(STATE_LOCK, { timeoutMs, staleMs: LOCK_STALE_MS })) {
    try {
      // Delay AFTER the lock is held: concurrent writers must queue here, which is
      // exactly the property the stress test asserts.
      txnTestDelay();
      const draft = readBacklogState();
      // The per-task seq is the dispatch order that crossed the commit point, so a
      // writer queued behind a slow transaction can never claim an earlier position.
      const seq = touchSeqOf(draft) + 1;
      const result = mutator(draft, { seq, agent });
      draft.__seq = seq;
      draft.__written_at = nowISO();
      draft.__written_by = agent;
      writeBacklogState(draft);
      return result;
    } finally {
      releaseLock(STATE_LOCK);
    }
  }
  throw new StateTxnBusy('state lock');
}

// Convenience wrapper: patch ONE task entry transactionally. The per-task `seq`
// is the dispatch order that crossed the commit point (so a queued-but-later
// writer can never claim an earlier position), and `updated_by` is the writer.
function updateBacklogState(taskId, mutator, { agent } = {}) {
  const who = agent || resolveAgentId({});
  try {
    return withStateTxn((draft, ctx) => {
      ctx.draft = draft;
      return applyTaskMutation(taskId, mutator, ctx, who);
    }, { agent: who });
  } catch (e) {
    if (!(e instanceof StateTxnBusy)) throw e;
    // The touch was dropped. Journal attribution stays authoritative (the
    // recovery path rebuilds state from the append-only journal), so we warn
    // loudly rather than silently pretending the write happened.
    console.error(`WARNING: could not acquire the state lock for [${taskId}] — the state touch was not recorded. Re-run, or run \`pb repair-state\` to rebuild state from the journal.`);
    return null;
  }
}

// agent identity — `--agent <id>` wins, then PB_AGENT_ID env, then default "agent".
// This is the field that lets N agents share one backlog (track B).
function resolveAgentId(args = {}) {
  if (args && typeof args.agent === 'string' && args.agent.trim()) return args.agent.trim();
  const env = process.env.PB_AGENT_ID;
  if (typeof env === 'string' && env.trim()) return env.trim();
  return 'agent';
}

// --- claim tokens + delegation chain (multi-agent ordering) ------------------
// A claim is a lease: the holder gets a token, and a writer must be able to prove
// it is either the holder or acting on the holder's behalf. This is what lets a
// sub-agent write a result back WITHOUT the parent having to hand over its
// identity — the sub-agent declares its parent and the chain is checked.
//
// PB_AGENT_CHAIN is the delegation path from the root agent to this writer
// (comma-separated, root first). A writer may touch a task if ANY element of its
// chain holds the claim. Without a token, ownership is unproven: the write is
// still recorded (never silently dropped) but flagged, because silently refusing
// would lose real work.
function newClaimToken() {
  return randomBytes(12).toString('hex');
}
function resolveAgentChain(args = {}) {
  const raw = (args && typeof args.chain === 'string' && args.chain)
    || process.env.PB_AGENT_CHAIN
    || process.env.PB_PARENT_AGENT_ID
    || '';
  const chain = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  const self = resolveAgentId(args);
  if (!chain.includes(self)) chain.push(self);
  return chain;
}
function verifyTaskClaim(taskId, args = {}, state = null) {
  const entry = (state || readBacklogState())[taskId] || {};
  const holder = entry.claimed_by || entry.agent_id || null;
  if (!holder) return { ok: true, status: 'unclaimed', holder: null };
  const token = (args && args.token) || process.env.PB_CLAIM_TOKEN || null;
  if (token && entry.claim_token && token === entry.claim_token) {
    return { ok: true, status: 'token', holder, token };
  }
  const chain = resolveAgentChain(args);
  if (chain.includes(holder)) return { ok: true, status: 'chain', holder, chain };
  return { ok: false, status: 'unproven', holder, chain };
}
// Which agent holds a task. Unstamped (legacy) tasks attribute to the default
// agent "agent" — consistent with resolveAgentId's fallback — so single-agent
// "one at a time" is preserved while named agents are not blocked by orphans.
function taskHolder(t) {
  return (t && (t.claimed_by || t.agent_id)) || 'agent';
}

// --- claim lock (multi-agent) ----------------------------------------------
// Atomic claim primitive: an O_EXCL lockfile serializes the claim's
// read-verify-write so two agents can't grab the same task. Carry-on: just a
// file, no daemon/DB. `wx` = create-exclusive; EEXIST means another holder.
function busySleepMs(ms) {
  // synchronous sleep with no deps — block this thread briefly between retries.
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { /* SharedArrayBuffer unavailable: spin */ const end = Date.now() + ms; while (Date.now() < end) {} }
}
// A lockfile is a claim, not a guarantee. Getting this wrong is SILENT: two
// holders read the same state and both write, so one agent's work disappears with
// no error anywhere. Two rules make it safe:
//
//   1. BREAK ONLY ON AGE, NEVER ON LIVENESS. An earlier version probed the
//      holder's pid with `process.kill(pid, 0)` and broke the lock when the probe
//      said the holder was gone. On Windows that probe misreported LIVE holders as
//      dead (observed: `holderAlive=false` for a process that was mid-transaction),
//      so a waiter stole an active lock and both holders read the same state —
//      the exact corruption this layer exists to prevent. The asymmetry decides it:
//      a lock held too long costs latency; a lock broken too early costs data.
//      Age is the only signal that cannot be wrong about a live holder.
//   2. RELEASE ONLY WHAT YOU OWN. A blind unlink can delete ANOTHER holder's lock.
//      Each acquire writes a random token; release unlinks only if it still matches.
//
// The cost of rule 1: a holder killed mid-transaction leaves a lock that blocks
// others until it ages past staleMs. That is deliberate — it is recoverable by
// waiting or by deleting the file, whereas silent data loss is not.
const LOCK_STALE_MS = Math.max(5000, Number(process.env.PB_LOCK_STALE_MS) || 10 * 60_000);
// A SHORT-lived lock needs its own, much shorter stale window. The worker slot is
// taken only around a `git worktree add` and a state write, so a holder still in
// there a minute later is dead — while `withStateTxn` may legitimately hold its
// lock for minutes (recording `done` runs acceptance_checks inside the lock).
// Using one window for both means either a slow-but-alive record gets its lock
// broken, or a crashed worker create blocks the repo for ten minutes.
const WORKER_LOCK_STALE_MS = Math.max(5000, Number(process.env.PB_LOCK_STALE_MS) || 60_000);
// How long a waiter blocks before giving up on a lock. Distinct from the stale
// window, and deliberately generous: giving up early turns ordinary contention into
// a lost record. A holder stuck past the stale window is broken, not waited out.
const LOCK_WAIT_MS = Math.max(200, Number(process.env.PB_LOCK_WAIT_MS) || 5 * 60_000);
const lockTokens = new Map();
function acquireLock(lockPath, { timeoutMs = LOCK_WAIT_MS, staleMs = LOCK_STALE_MS } = {}) {
  const start = Date.now();
  const token = randomBytes(8).toString('hex');
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx');
      writeFileSync(fd, JSON.stringify({ pid: process.pid, token, ts: nowISO() }));
      closeSync(fd);
      lockTokens.set(lockPath, token);
      if (process.env.PB_TXN_TRACE) process.stderr.write(`[lock] ACQUIRE t=${Date.now()} ${basename(lockPath)} pid=${process.pid}\n`);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // Break ONLY a lock that has aged past its window. Age is the only signal that
      // cannot be wrong about a live holder; a liveness probe could (and did) misread
      // an active holder as dead and steal its lock.
      try {
        const st = statSync(lockPath);
        if (Date.now() - st.mtimeMs > staleMs) {
          if (process.env.PB_TXN_TRACE) process.stderr.write(`[lock] BREAK-STALE t=${Date.now()} ${basename(lockPath)} pid=${process.pid}\n`);
          try { unlinkSync(lockPath); continue; } catch { /* raced */ }
        }
      } catch { /* lock vanished — retry immediately */ }
      if (Date.now() - start > LOCK_WAIT_MS) return false;
      busySleepMs(20);
    }
  }
}
// Retry the unlink (a transient Windows sharing violation here would leave a lock
// that blocks every later acquire), and only remove a lock this process owns.
function releaseLock(lockPath) {
  const mine = lockTokens.get(lockPath);
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      if (mine) {
        let holder = null;
        try { holder = JSON.parse(readFileSync(lockPath, 'utf8'))?.token; } catch (err) {
          if (process.env.PB_TXN_TRACE) process.stderr.write(`[lock] RELEASE-UNREADABLE ${basename(lockPath)} err=${err.code}\n`);
          return;
        }
        if (holder !== mine) {
          if (process.env.PB_TXN_TRACE) process.stderr.write(`[lock] SKIP-RELEASE ${basename(lockPath)} pid=${process.pid} (not the owner) file=${holder} mine=${mine}\n`);
          lockTokens.delete(lockPath);
          return;
        }
      }
      unlinkSync(lockPath);
      lockTokens.delete(lockPath);
      if (process.env.PB_TXN_TRACE) process.stderr.write(`[lock] RELEASE t=${Date.now()} ${basename(lockPath)} pid=${process.pid}\n`);
      return;
    } catch (e) {
      if (e?.code === 'ENOENT') { lockTokens.delete(lockPath); return; } // already gone — the goal state
      if (attempt === 9 && process.env.PB_TXN_TRACE) process.stderr.write(`[lock] RELEASE-FAILED ${basename(lockPath)} err=${e.code}\n`);
      busySleepMs(20 * (attempt + 1));
    }
  }
}

function backlogTasks() {
  const bl = readData(BACKLOG);
  const tasks = Array.isArray(bl?.tasks) ? bl.tasks : [];
  const state = readBacklogState();
  return tasks.map((t) => {
    const s = state[t.id] || {};
    return {
      ...t,
      status: s.status ?? t.status,
      loop_id: s.loop_id ?? t.loop_id,
      claimed_at: s.claimed_at ?? t.claimed_at,
      claimed_by: s.claimed_by ?? t.claimed_by,
      agent_id: s.agent_id ?? t.agent_id,
      mode: s.mode ?? t.mode,
      updated_at: s.updated_at ?? t.updated_at,
    };
  });
}

/**
 * The backlog file's text — ONE header and ONE serializer, shared by writeBacklog and
 * by cmdScaffold. Scaffold used to copy the source playbook's backlog file verbatim,
 * which seeded every new workspace with another project's tasks (and with
 * acceptance_checks naming scripts scaffold does not copy). Seeding an EMPTY backlog
 * through this same function is what keeps a new workspace's state genuinely its own.
 */
function backlogText(obj) {
  return (
    `# ${BACKLOG} — the task queue the loop pulls from.\n` +
    '# Managed by `pb` (next --claim / record). Edit by hand to add tasks.\n' +
    `# status: ${ALLOWED_STATUSES.join(' | ')}   priority: 1 = highest\n` +
    '# acceptance_checks: shell commands that must exit 0 before `record --status done` succeeds.\n' +
    yaml.dump(obj, { lineWidth: 100 })
  );
}

function writeBacklog(obj) {
  if (BACKLOG.endsWith('.json')) {
    atomicReplace(p(BACKLOG), JSON.stringify(obj, null, 2) + '\n');
    return;
  }
  const text = backlogText(obj);
  // If the backlog file does not exist yet, seed it wholesale (bootstrap/init).
  if (!existsSync(p(BACKLOG))) {
    writeFileSync(p(BACKLOG), text, 'utf8');
    return;
  }
  // If the task list is being explicitly reset to empty (e.g. loop new --fresh),
  // rewrite the file and clear the machine-managed sidecar — transactionally, so a
  // concurrent reader never sees a half-cleared state object.
  const emptying = Array.isArray(obj.tasks) && obj.tasks.length === 0;
  if (emptying) {
    writeFileSync(p(BACKLOG), text, 'utf8');
    withStateTxn((draft) => { for (const k of Object.keys(draft)) delete draft[k]; }, { agent: resolveAgentId({}) });
    return;
  }
  // Normal status updates go to the sidecar so hand-edited formatting/comments in
  // backlog.yaml are preserved. One transaction covers every task in the batch, so
  // a multi-task write is all-or-nothing rather than N racing single writes.
  withStateTxn((draft, ctx) => {
    for (const t of obj.tasks || []) {
      draft[t.id] = {
        ...(draft[t.id] || {}),
        status: t.status,
        loop_id: t.loop_id || undefined,
        claimed_at: t.claimed_at || undefined,
        updated_at: t.updated_at || undefined,
        seq: ctx.seq,
        updated_by: resolveAgentId({}),
      };
    }
  }, { agent: resolveAgentId({}) });
}
function appendBacklogTask(task) {
  if (BACKLOG.endsWith('.json')) {
    const bl = readData(BACKLOG) || { tasks: [] };
    bl.tasks.push(task);
    writeFileSync(p(BACKLOG), JSON.stringify(bl, null, 2) + '\n', 'utf8');
    return;
  }
  let text = readText(BACKLOG);
  // `loop new --fresh` resets YAML backlogs to `tasks: []`. Appending an
  // indented list item after that scalar inline list creates invalid YAML:
  // `tasks: []\n  - id: ...`. Normalize that empty-list form to a block list
  // header before appending so the first planned task becomes valid YAML.
  text = text.replace(/(^|\n)(\s*tasks:)\s*\[\]\s*(?=\n|$)/, '$1$2');
  const taskYaml = yaml.dump(task, { lineWidth: 100 }).trimEnd();
  const indented = taskYaml.split('\n').map((line, i) => (i === 0 ? '  - ' + line : '    ' + line)).join('\n');
  const sep = text.endsWith('\n') ? '' : '\n';
  writeFileSync(p(BACKLOG), text + sep + indented + '\n', 'utf8');
}
function ensureDir(rel) {
  const dir = p(rel);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}
function writeIfMissing(rel, text, created) {
  ensureDir(dirname(rel));
  if (!existsSync(p(rel))) {
    writeFileSync(p(rel), text, 'utf8');
    created.push(rel);
  }
}
function readNdjson(rel) {
  return readText(rel)
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .map((l, i) => {
      try { return JSON.parse(l); }
      catch { return { __malformed: true, __line: i + 1, raw: l }; }
    });
}
function appendNdjson(rel, obj) {
  ensureDir(dirname(rel));
  appendFileSync(p(rel), JSON.stringify(obj) + '\n', 'utf8');
}
function journalLineCount() {
  return readText(JOURNAL).split(/\r?\n/).filter((l) => l.trim().length > 0).length;
}
function readLoops() {
  let data = null;
  try { data = readData(LOOPS); }
  catch { data = null; }
  return {
    active: typeof data?.active === 'string' ? data.active : null,
    loops: Array.isArray(data?.loops) ? data.loops : [],
  };
}
function writeLoops(state) {
  ensureDir(dirname(LOOPS));
  writeFileSync(p(LOOPS), yaml.dump({
    active: state.active || null,
    loops: Array.isArray(state.loops) ? state.loops : [],
  }, { lineWidth: 100 }), 'utf8');
}
function activeLoop() {
  const state = readLoops();
  const loop = state.active ? state.loops.find((l) => l.id === state.active) : null;
  return loop && loop.status === 'active' ? loop : null;
}
function latestLoop() {
  const loops = readLoops().loops;
  return loops.length ? loops[loops.length - 1] : null;
}
function loopById(id) {
  return readLoops().loops.find((l) => l.id === id) || null;
}
function nextLoopId(state = readLoops()) {
  const prefix = `loop-${today().replace(/-/g, '')}`;
  const n = state.loops.filter((l) => String(l.id || '').startsWith(prefix)).length + 1;
  return `${prefix}-${String(n).padStart(3, '0')}`;
}
function readLessons() {
  return readNdjson(LESSONS).filter((e) => !e.__malformed);
}
function openLessons() {
  return readLessons().filter((l) => l.status !== 'promoted' && l.status !== 'closed');
}
function lessonsForLoop(loopId) {
  return readLessons().filter((l) => l.loop_id === loopId);
}
function nextLessonId() {
  const prefix = `lesson-${today().replace(/-/g, '')}`;
  const n = readLessons().filter((l) => String(l.id || '').startsWith(prefix)).length + 1;
  return `${prefix}-${String(n).padStart(3, '0')}`;
}
function readProcessEvents() {
  return readNdjson(PROCESSES).filter((e) => !e.__malformed);
}
function latestProcessRecords(loopId = null) {
  const byPid = new Map();
  for (const e of readProcessEvents()) {
    if (loopId && e.loop_id !== loopId) continue;
    if (e.pid !== undefined) byPid.set(`${e.loop_id}:${e.pid}`, e);
  }
  return [...byPid.values()];
}
function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}
function stopPid(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0 || n >= 2 ** 31) return false;
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(n), '/T', '/F'], { stdio: 'pipe' });
    else process.kill(-n, 'SIGTERM');
    return true;
  } catch {
    try { process.kill(n, 'SIGTERM'); return true; }
    catch { return false; }
  }
}
function stopLoopProcesses(loopId) {
  const stopped = [];
  for (const proc of latestProcessRecords(loopId)) {
    const alive = proc.status !== 'stopped' && pidAlive(proc.pid);
    if (!alive) continue;
    const ok = stopPid(proc.pid);
    const event = { ...proc, ts: nowISO(), status: ok ? 'stopped' : 'stop_failed', stopped_at: nowISO() };
    appendNdjson(PROCESSES, event);
    stopped.push(event);
  }
  return stopped;
}

// minimal arg parser: positionals in `_`, --key value / --flag true / --key=value
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '--') {
      out['--'] = argv.slice(i + 1);
      break;
    }
    if (tok.startsWith('--')) {
      let key, value;
      const eq = tok.indexOf('=');
      if (eq > 2) {
        key = tok.slice(2, eq);
        value = tok.slice(eq + 1);
      } else {
        key = tok.slice(2);
        const nxt = argv[i + 1];
        if (nxt === undefined || nxt.startsWith('--')) value = true;
        else { value = nxt; i++; }
      }
      if (out[key] === undefined) out[key] = value;
      else if (Array.isArray(out[key])) out[key].push(value);
      else out[key] = [out[key], value];
    } else {
      out._.push(tok);
    }
  }
  return out;
}

const prio = (t) => (typeof t.priority === 'number' ? t.priority : 100);
// --- pack-composable index resolution (Stage 2) ----------------------------
// Skills/processes resolve from the ENGINE globals UNION the ACTIVE MODE's
// pack-local indices. Engine ids win on collision (packs are additive, never
// override). coding's pointers equal the global files, so its union == globals
// == no change. A pack that points its skills_index/processes_index at its own
// files (under modes/<id>/) contributes those entries only while it is active.
function modeIndexPath(doc, key) {
  return doc && typeof doc[key] === 'string' && doc[key].trim() ? doc[key].trim() : null;
}
function mergeIndexEntries(globalPath, modePath, listKey) {
  const entries = [];
  const seen = new Set();
  const push = (list) => {
    for (const e of list || []) {
      if (!e || !e.id || seen.has(e.id)) continue; // engine/first wins; additive for new ids
      seen.add(e.id);
      entries.push(e);
    }
  };
  push(readData(globalPath)?.[listKey]);                 // engine globals first
  if (modePath && modePath !== globalPath) push(readData(modePath)?.[listKey]); // then pack-local
  return entries;
}
// A specific mode's resolved menu (engine globals ∪ that mode's pack-local index).
// `pb mode show <id>` lists ANY mode's menu, not only the active one.
function modeSkillEntries(doc) {
  return mergeIndexEntries(SKILL_INDEX, modeIndexPath(doc, 'skills_index'), 'skills');
}
function modeProcessEntries(doc) {
  return mergeIndexEntries(PROCESS_INDEX, modeIndexPath(doc, 'processes_index'), 'processes');
}
function resolvedSkillEntries() {
  return modeSkillEntries(loadMode(resolveModeId()));
}
function resolvedProcessEntries() {
  return modeProcessEntries(loadMode(resolveModeId()));
}
function skillFor(skillId) {
  return resolvedSkillEntries().find((s) => s.id === skillId) || null;
}
function skillForMode(skillId, modeId) {
  const doc = loadMode(modeId || resolveModeId());
  return modeSkillEntries(doc).find((s) => s.id === skillId) || null;
}
function unmetDeps(task, tasks) {
  const deps = Array.isArray(task.dependencies) ? task.dependencies : [];
  return deps.filter((dep) => !tasks.some((t) => t.id === dep && t.status === 'done'));
}

// ============================================================================
//  layers — the planning view of the same graph `dependencies` already enforces.
//
//  A layer is a named stratum of a repo (substrate → data → domain → interface).
//  The point of layers is NOT a prettier task list: it is that a layer can carry a
//  GATE, so "we do not touch the domain layer while the data layer is red" becomes
//  an enforced fact instead of an intention. That is what makes this planning for
//  the maturity of a repo rather than planning for the next feature, and it is the
//  same property that makes a modular repo safe to grow in parallel.
//
//  Two rules keep layers from becoming a second, lying source of truth:
//    1. A layer is a PROJECTION of the dependency graph. Each task's depth is
//       derived (1 + the deepest dependency), never declared-and-trusted.
//    2. A declared `layer:` is a CONSTRAINT. A task may not sit in an EARLIER layer
//       than anything it depends on, so an edge that silently pushes work deeper
//       becomes a `pb validate` failure rather than a quiet contradiction.
//  The graph is about order; the layers are about altitude. Neither is decoration.
// ============================================================================
function readLayerDefs() {
  const raw = master.layers;
  if (raw === undefined || raw === null) return { declared: false, layers: [], errors: [] };
  if (!Array.isArray(raw)) return { declared: true, layers: [], errors: ['`layers` in the master must be a list of {id, name, gate} entries'] };
  const layers = [];
  const errors = [];
  const seen = new Set();
  raw.forEach((entry, i) => {
    if (!entry || typeof entry !== 'object') { errors.push(`layers[${i}] is not an object`); return; }
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    if (!id) { errors.push(`layers[${i}] is missing an id`); return; }
    if (seen.has(id)) { errors.push(`duplicate layer id: ${id}`); return; }
    seen.add(id);
    layers.push({
      id,
      name: typeof entry.name === 'string' ? entry.name.trim() : '',
      gate: typeof entry.gate === 'string' ? entry.gate.trim() : '',
      about: typeof entry.about === 'string' ? entry.about.trim() : '',
      // `human: true` declares that this gate fails until a PERSON acts — buy the domain,
      // provision the database, issue the credential. The engine cannot infer that; only
      // the plan author knows that no agent retry will ever turn this gate green. The
      // flag changes reporting and hand-off, never whether the gate gates.
      human: entry.human === true,
    });
  });
  return { declared: true, layers, errors };
}

// Read-only gate evaluation, memoized WITHIN one planning pass. `pb next --claim`
// and `pb loop run --auto` check gates as part of selection, so the same gate must
// not be re-run for every candidate, and a gate that cannot start (bad command) is a
// FAILED gate, never an excuse to proceed. The memo is cleared at the start of each
// top-level plan: keying it by the command alone made one playbook's gate result leak
// into the next (identical gate text, DIFFERENT working tree), which read as a gate
// that could never go green.
const layerGateCache = new Map();
function evalLayerGate(gate) {
  if (layerGateCache.has(gate)) return layerGateCache.get(gate);
  const parts = shellSplit(gate);
  let result = { ok: false, output: 'the gate is not a runnable command' };
  if (parts.length) {
    const [file, ...argv] = parts;
    try {
      runCommandSync(file, argv, { cwd: ROOT, stdio: 'pipe', timeout: 120000 });
      result = { ok: true, output: '' };
    } catch (e) {
      result = { ok: false, output: [e.stdout, e.stderr].filter(Boolean).map(String).join('\n').trim().split(/\r?\n/).slice(-8).join('\n') };
    }
  }
  layerGateCache.set(gate, result);
  return result;
}

// The derived plan: validate the layer declarations, compute each task's depth,
// and report readiness / group blockers. PURE with respect to playbook state —
// no journal row, no state touch. The only side effect is running a layer GATE
// command, and only when `checkGates` is set (the caller opts in, and only AFTER
// taking the confirmation snapshot it uses to prove the dry run stayed read-only).
function computeLayerPlan({ checkGates = false, allTasks = null } = {}) {
  const tasks = allTasks || backlogTasks();
  // A fresh plan re-evaluates gates: a memo from an earlier plan describes an earlier
  // tree, and a stale gate verdict is exactly the kind of confident-but-wrong answer
  // this command exists to prevent.
  layerGateCache.clear();
  const tasksById = new Map(tasks.map((t) => [t.id, t]));
  const defs = readLayerDefs();
  const orderIds = defs.layers.map((l) => l.id);
  const orderIndex = new Map(orderIds.map((id, i) => [id, i]));
  const declared = new Map();
  const edges = new Map();
  const issues = defs.errors.map((message) => ({ code: 'bad-layer-list', message }));
  const issueFor = (t, code, message) => issues.push({ code, task: t.id, message });

  // --- structural validation (the part a dry run must surface, never hide) ----
  for (const t of tasks) {
    const declaredLayer = t.layer === undefined || t.layer === null || String(t.layer).trim() === ''
      ? null
      : String(t.layer).trim();
    if (declaredLayer !== null) {
      if (!orderIndex.has(declaredLayer)) {
        issueFor(t, 'unknown-layer', `Task ${t.id} declares layer "${declaredLayer}", which the master's \`layers\` list does not define.`);
      } else {
        declared.set(t.id, declaredLayer);
      }
    }
    const deps = Array.isArray(t.dependencies) ? t.dependencies.filter((d) => typeof d === 'string' && d) : [];
    if (t.dependencies !== undefined && !Array.isArray(t.dependencies)) {
      issueFor(t, 'bad-dependencies', `Task ${t.id} \`dependencies\` must be a list of task ids.`);
    }
    if (deps.includes(t.id)) issueFor(t, 'self-dependency', `Task ${t.id} depends on itself — no order can satisfy that.`);
    edges.set(t.id, deps);
  }
  for (const t of tasks) {
    for (const dep of edges.get(t.id) || []) {
      if (dep !== t.id && !tasksById.has(dep)) {
        issueFor(t, 'unknown-dependency', `Task ${t.id} depends on "${dep}", which is not in the backlog.`);
      }
    }
  }
  // Cycle detection by peeling roots: whatever survives has no root, i.e. every
  // survivor is reachable from a cycle. The survivors NAME the cycle, which is what
  // makes the failure actionable instead of just "invalid graph".
  const indegree = new Map(tasks.map((t) => [t.id, (edges.get(t.id) || []).filter((d) => d !== t.id && tasksById.has(d)).length]));
  const dependents = new Map(tasks.map((t) => [t.id, []]));
  for (const t of tasks) for (const d of edges.get(t.id) || []) if (d !== t.id && tasksById.has(d)) dependents.get(d).push(t.id);
  const peelQueue = tasks.filter((t) => indegree.get(t.id) === 0).map((t) => t.id);
  const peeled = new Set();
  while (peelQueue.length) {
    const id = peelQueue.shift();
    if (peeled.has(id)) continue;
    peeled.add(id);
    for (const next of dependents.get(id) || []) {
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) peelQueue.push(next);
    }
  }
  const inCycle = tasks.filter((t) => !peeled.has(t.id)).map((t) => t.id);
  if (inCycle.length) {
    issues.push({
      code: 'cycle',
      message: `Dependency cycle — no order can satisfy it. Tasks with no root: ${inCycle.join(', ')}.`,
      cycle: inCycle,
    });
  }

  // --- derive each task's layer (1 + deepest dependency) ----------------------
  const depth = new Map();
  const depthOf = (id, stack = new Set()) => {
    if (depth.has(id)) return depth.get(id);
    if (stack.has(id)) return 0; // a cycle — already reported; do not recurse forever
    stack.add(id);
    let d = 0;
    for (const dep of edges.get(id) || []) {
      if (dep === id || !tasksById.has(dep)) continue;
      d = Math.max(d, depthOf(dep, stack) + 1);
    }
    stack.delete(id);
    depth.set(id, d);
    return d;
  };
  for (const t of tasks) depthOf(t.id);

  // --- declared layer vs. derived depth: a constraint, not a decoration ------
  for (const [id, layerId] of declared) {
    const t = tasksById.get(id);
    const layerPos = orderIndex.get(layerId);
    for (const dep of edges.get(id) || []) {
      if (dep === id || !tasksById.has(dep)) continue;
      const depLayer = declared.get(dep);
      if (depLayer && orderIndex.get(depLayer) >= layerPos) {
        issueFor(t, 'layer-order',
          `Task ${id} is declared layer "${layerId}" but depends on ${dep} in layer "${depLayer}" — a dependency may not come from the same or a later layer.`);
      }
    }
    if (orderIds.length && layerPos < depth.get(id)) {
      issueFor(t, 'layer-too-early',
        `Task ${id} declares layer "${layerId}" (position ${layerPos + 1}) but its dependencies put it at position ${depth.get(id) + 1} — move it deeper or drop a dependency.`);
    }
  }
  const unresolved = tasks.filter((t) => declared.has(t.id) && orderIndex.get(declared.get(t.id)) < depth.get(t.id)).length;

  // --- gates: which lower layers must be green before a layer may start -------
  const gateResults = {};
  if (checkGates) {
    for (const def of defs.layers) {
      if (!def.gate) continue;
      gateResults[def.id] = evalLayerGate(def.gate);
    }
  }
  // gateBlockersFor(task): the lower-layer gates that must pass before it is
  // claimable. Empty for an unlayered task or a layer-0 task.
  const gateBlockersFor = (t) => {
    const layerId = declared.get(t.id);
    if (!layerId) return [];
    const pos = orderIndex.get(layerId);
    const blockers = [];
    for (const def of defs.layers) {
      const p = orderIndex.get(def.id);
      if (p >= pos) continue;
      if (!def.gate) continue;
      if (!checkGates) {
        // Without --check-gates the gate is NOT evaluated; block the claim (opt-in
        // safety: an unevaluated gate is not a passed gate) and say so.
        blockers.push({ layer: def.id, gate: def.gate, human: def.human, ok: false, evaluated: false, output: '' });
        continue;
      }
      const res = gateResults[def.id] || { ok: false, output: '' };
      if (!res.ok) blockers.push({ layer: def.id, gate: def.gate, human: def.human, ok: false, evaluated: true, output: res.output });
    }
    return blockers;
  };
  // group blockers: open work in a strictly LOWER layer. This holds regardless of
  // the unlayeredTasksLoose setting — with that setting OFF the layer is a hard
  // partition, with it ON an unlayered task may interleave anywhere.
  const groupBlockersFor = (t) => {
    const layerId = declared.get(t.id);
    if (!layerId) return [];
    const pos = orderIndex.get(layerId);
    const blocking = [];
    for (const other of tasks) {
      const otherLayer = declared.get(other.id);
      if (!otherLayer) continue;
      if (orderIndex.get(otherLayer) >= pos) continue;
      if (other.status !== 'done') blocking.push(other.id);
    }
    return blocking;
  };

  const readyByLayer = new Map(orderIds.map((id) => [id, []]));
  const planned = tasks.map((t) => {
    const deps = edges.get(t.id) || [];
    const unmet = unmetDeps(t, tasks);
    const layerId = declared.get(t.id) || null;
    const unlayered = !layerId;
    const groupBlocked = groupBlockersFor(t);
    const gateBlocked = gateBlockersFor(t);
    const ready = t.status === 'todo' && !unmet.length && !groupBlocked.length && !gateBlocked.length;
    // A task whose declared layer is NOT in the `layers` list has no bucket to land
    // in — it is reported as a plan problem above, and it must not crash the planner
    // on the way to reporting it. Such a task is unlayered for gating purposes.
    if (ready && layerId && readyByLayer.has(layerId)) readyByLayer.get(layerId).push(t.id);
    return {
      id: t.id, title: t.title, status: t.status, priority: prio(t),
      layer: layerId, derived_layer: depth.get(t.id),
      dependencies: deps, unmet_deps: unmet, group_blocked_by: groupBlocked, gate_blocked_by: gateBlocked,
      manual: !!t.manual, gate_quality: gateQuality(t), ready, unlayered,
    };
  });
  const plannedById = new Map(planned.map((p) => [p.id, p]));

  // --- critical path: the longest chain of dependent work still open ---------
  const openMemo = new Map();
  const openChain = (id, stack = new Set()) => {
    if (openMemo.has(id)) return openMemo.get(id);
    if (stack.has(id)) return 0;
    stack.add(id);
    const p = plannedById.get(id);
    const openSelf = p && p.status !== 'done' ? 1 : 0;
    let deepest = 0;
    for (const dep of (p ? p.dependencies : []) || []) {
      if (dep === id || !plannedById.has(dep)) continue;
      deepest = Math.max(deepest, openChain(dep, stack));
    }
    stack.delete(id);
    const total = openSelf + deepest;
    openMemo.set(id, total);
    return total;
  };
  for (const t of tasks) openChain(t.id);
  const openCount = planned.filter((p) => p.status !== 'done').length;
  const pathHead = planned
    .filter((p) => p.status !== 'done')
    .sort((a, b) => openMemo.get(b.id) - openMemo.get(a.id) || a.priority - b.priority)[0] || null;

  const layers = defs.layers.map((def, i) => {
    const members = planned.filter((p) => p.layer === def.id);
    const counts = { todo: 0, in_progress: 0, blocked: 0, done: 0 };
    for (const m of members) if (counts[m.status] !== undefined) counts[m.status]++;
    return {
      id: def.id, name: def.name, about: def.about, position: i, gate: def.gate, human: def.human,
      gate_result: checkGates && def.gate ? (gateResults[def.id] || null) : null,
      counts, total: members.length,
      ready: readyByLayer.get(def.id) || [],
      tasks: members.map((m) => m.id),
    };
  });

  const ready = planned.filter((p) => p.ready).sort((a, b) => a.priority - b.priority || (a.derived_layer - b.derived_layer));
  // The WAITING-ON-HUMAN batch. Derived purely from the plan (nothing is cached into
  // state), and only for layers whose author declared `human: true` — an unmarked gate
  // keeps exactly today's semantics. The point: a red gate on a human layer is not a
  // failure to retry, it is a question to answer, and every such question can be
  // answered in ONE hand-off instead of stopping the run at the first one.
  const waitingOnHuman = [];
  const waitingOnAgent = [];
  if (checkGates) {
    for (const def of defs.layers) {
      if (!def.gate) continue;
      const res = gateResults[def.id];
      if (!res || res.ok) continue;
      const pos = orderIndex.get(def.id);
      const blockedTasks = planned.filter((p) => p.status !== 'done'
        && p.layer
        && orderIndex.get(p.layer) > pos);
      const entry = {
        layer: def.id,
        name: def.name,
        gate: def.gate,
        output: res.output || '',
        blocked_tasks: blockedTasks.map((p) => p.id),
        blocked_layers: defs.layers.filter((l) => orderIndex.get(l.id) > pos).map((l) => l.id),
      };
      (def.human ? waitingOnHuman : waitingOnAgent).push(entry);
    }
  }
  return {
    declared: defs.declared,
    ordered: defs.layers.length > 0,
    layers,
    layer_ids: orderIds,
    tasks: planned,
    edges: Object.fromEntries(edges),
    ready: ready.map((p) => p.id),
    ready_tasks: ready,
    critical_path: {
      open_tasks: openCount,
      length: pathHead ? openMemo.get(pathHead.id) : 0,
      head: pathHead ? pathHead.id : null,
    },
    gate_results: gateResults,
    gates_checked: checkGates,
    unlayered_tasks: planned.filter((p) => p.unlayered).map((p) => p.id),
    waiting_on_human: waitingOnHuman,
    waiting_on_agent: waitingOnAgent,
    problems: issues,
    structurally_valid: issues.length === 0,
    unresolved_layers: unresolved,
  };
}

// Claims are gated by layers only when the playbook declares them, so a repo that
// has not adopted layers behaves exactly as before. `plan` is passed in rather than
// recomputed so selection and reporting judge the SAME snapshot: two computations
// could otherwise disagree about a gate that runs a command as a side effect.
function gateBlockersFor(plan, task) {
  if (!plan || !plan.declared) return [];
  const entry = plan.tasks.find((p) => p.id === task.id);
  return entry ? entry.gate_blocked_by : [];
}
function unmetLayerGates(task, tasks) {
  const plan = computeLayerPlan({ checkGates: true, allTasks: tasks });
  return { plan, blockers: gateBlockersFor(plan, task) };
}

// ============================================================================
//  acceptance checks — the enforcement layer. Checks are shell commands on the
//  task; they run with cwd = playbook root. Exit 0 = pass. This is what makes
//  "done" mean something: `record --status done` refuses if any check fails.
// ============================================================================
function taskChecks(task) {
  return (Array.isArray(task?.acceptance_checks) ? task.acceptance_checks : [])
    .filter((c) => typeof c === 'string' && c.trim());
}
function taskCommands(task) {
  return (Array.isArray(task?.commands) ? task.commands : [])
    .filter((c) => typeof c === 'string' && c.trim());
}

function gateQuality(task) {
  const checks = taskChecks(task);
  if (!checks.length) return '·honor';
  const structuralOnly = (c) => /(^|\s)(node\s+scripts\/pb\.mjs|pb(\.mjs)?|npm\s+run)\s+validate\b/.test(c.trim()) && !/--task/.test(c);
  return checks.every(structuralOnly) ? '⚠hollow' : '✓verified';
}
function reportCheckMarker(entry, task) {
  if (entry.checks === 'skipped') return ' ⚠checks-skipped';
  if (entry.checks !== 'passed') return '';
  const quality = task ? gateQuality(task) : '✓verified';
  return quality === '⚠hollow' ? ' ⚠hollow-checks' : ' ✓verified';
}
// Checks run with cwd = playbook root, so a check that names the playbook
// folder itself (e.g. ".agents-playbook/artifacts/...") is almost certainly a
// workspace-relative path written by an operator who expected cwd = workspace
// root. The runner would look for ".agents-playbook/.agents-playbook/..." and
// fail on a file that exists. Surface that before the confusing failure.
const PLAYBOOK_DIR = ROOT.split(/[\\/]/).filter(Boolean).pop() || '';
function checkPathWarnings(checks) {
  if (!PLAYBOOK_DIR || !PLAYBOOK_DIR.startsWith('.')) return [];
  // Only warn for a dot-prefixed nested install (".agents-playbook"); a bare
  // top-level folder name like "scripts" would false-positive on real paths.
  const needle = new RegExp(`(^|[\\s'"\`(])${PLAYBOOK_DIR.replace(/[.]/g, '\\.')}[\\\\/]`);
  return checks.filter((c) => needle.test(c));
}
// `cwd` defaults to the playbook root — the contract checks were written against.
// Worker verification passes a worktree instead, so an isolated candidate is
// judged in ITS OWN tree rather than against the root checkout (which is the whole
// point of running the work in a worktree).
function runChecks(task, cwd = ROOT) {
  const checks = taskChecks(task);
  const results = [];
  for (const cmd of checks) {
    const parts = shellSplit(cmd);
    if (!parts.length) continue;
    const [file, ...argv] = parts;
    try {
      runCommandSync(file, argv, { cwd, stdio: 'pipe', timeout: 120000 });
      results.push({ cmd, ok: true });
    } catch (e) {
      const out = [e.stdout, e.stderr].filter(Boolean).map(String).join('\n').trim();
      results.push({ cmd, ok: false, output: out.split(/\r?\n/).slice(-8).join('\n') });
    }
  }
  return results;
}
function printCheckResults(results) {
  for (const r of results) {
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.cmd}`);
    if (!r.ok && r.output) console.log(r.output.split(/\r?\n/).map((l) => `        ${l}`).join('\n'));
  }
}
function runCommands(task, cwd = ROOT) {
  const cmds = taskCommands(task);
  const results = [];
  for (const cmd of cmds) {
    const parts = shellSplit(cmd);
    if (!parts.length) continue;
    const [file, ...argv] = parts;
    try {
      runCommandSync(file, argv, { cwd, stdio: 'pipe', timeout: 120000 });
      results.push({ cmd, ok: true });
    } catch (e) {
      const out = [e.stdout, e.stderr].filter(Boolean).map(String).join('\n').trim();
      results.push({ cmd, ok: false, output: out.split(/\r?\n/).slice(-8).join('\n') });
    }
  }
  return results;
}
function printCommandResults(results) {
  for (const r of results) {
    console.log(`  ${r.ok ? 'OK' : 'FAIL'}  ${r.cmd}`);
    if (!r.ok && r.output) console.log(r.output.split(/\r?\n/).map((l) => `        ${l}`).join('\n'));
  }
}

// --- mode principle checks -------------------------------------------------
// kind:check principles declare an executable `check:` command; kind:advice are
// anchor nudges only and NEVER run/gate. This is what keeps modes from going
// faith-based. Commands dispatch through the Windows-safe runner (runCommandSync)
// so `.cmd`/`.bat` shims like `npm` work (project-memory #7).
function modeCheckPrinciples(doc) {
  return (Array.isArray(doc?.principles) ? doc.principles : [])
    .filter((pr) => pr && pr.kind === 'check' && typeof pr.check === 'string' && pr.check.trim());
}
function runModeChecks(doc) {
  const results = [];
  for (const pr of modeCheckPrinciples(doc)) {
    const parts = shellSplit(pr.check);
    if (!parts.length) continue;
    const [file, ...argv] = parts;
    try {
      runCommandSync(file, argv, { cwd: ROOT, stdio: 'pipe', timeout: 120000 });
      results.push({ id: pr.id, cmd: pr.check, ok: true });
    } catch (e) {
      const out = [e.stdout, e.stderr].filter(Boolean).map(String).join('\n').trim();
      results.push({ id: pr.id, cmd: pr.check, ok: false, output: out.split(/\r?\n/).slice(-8).join('\n') });
    }
  }
  return results;
}
function printModeCheckResults(results) {
  for (const r of results) {
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  [${r.id}] ${r.cmd}`);
    if (!r.ok && r.output) console.log(r.output.split(/\r?\n/).map((l) => `        ${l}`).join('\n'));
  }
}

// ============================================================================
//  validate — guardrails. No args: structural (master, indices, files, backlog,
//  journal). --task <id>: run that task's executable acceptance_checks.
//  --mode: also run the active mode's kind:check principles.
//  Exit 1 on any failure.
// ============================================================================
function runValidate() {
  const failures = [];
  const ok = (cond, msg) => { if (!cond) failures.push(msg); };

  // 1. master
  if (MASTER_ERR) failures.push(`Master parse error in ${MASTER}: ${MASTER_ERR}`);
  ok(master && Object.keys(master).length, `Missing or unparseable master: ${MASTER}`);
  for (const key of ['name', 'version', 'entry', 'paths', 'index', 'loop', 'guardrails']) {
    ok(master[key] !== undefined, `${MASTER} is missing required key: ${key}`);
  }
  ok(exists(ENTRY), `entry file does not exist: ${ENTRY}`);

  // 2. processes index (global must parse) + each referenced process file in the
  //    resolved union (engine globals ∪ active-mode pack-local).
  const pidx = readData(PROCESS_INDEX);
  ok(pidx, `Missing or unparseable process index: ${PROCESS_INDEX}`);
  const processIds = new Set();
  for (const proc of resolvedProcessEntries()) {
    ok(proc.id, `A process entry in ${PROCESS_INDEX} is missing an id`);
    if (proc.id) processIds.add(proc.id);
    ok(proc.file && exists(proc.file), `Process file missing: ${proc.file} (id: ${proc.id})`);
  }

  // 3. skills index (global must parse) + each skill file + each process ref
  //    resolves (by id or path), over the resolved union.
  const sidx = readData(SKILL_INDEX);
  ok(sidx, `Missing or unparseable skill index: ${SKILL_INDEX}`);
  for (const sk of resolvedSkillEntries()) {
    ok(sk.id, `A skill entry in ${SKILL_INDEX} is missing an id`);
    ok(sk.file && exists(sk.file), `Skill file missing: ${sk.file} (id: ${sk.id})`);
    if (sk.process) {
      const resolves = processIds.has(sk.process) || exists(sk.process);
      ok(resolves, `Skill "${sk.id}" points to a process that does not resolve: ${sk.process}`);
    }
  }

  // 4. memory files
  ok(exists(PROJECT_MEMORY), `Missing project memory: ${PROJECT_MEMORY}`);
  ok(exists(BACKLOG), `Missing backlog: ${BACKLOG}`);
  ok(existsSync(p(JOURNAL)), `Missing journal: ${JOURNAL} (run \`pb init\` to create it)`);

  // 5. backlog well-formed (use merged tasks so sidecar state is validated too)
  let tasks = [];
  try {
    tasks = backlogTasks();
  } catch (e) {
    failures.push(`${BACKLOG} parse error: ${e.message}`);
  }
  const ids = new Set(tasks.map((t) => t.id).filter(Boolean));
  // Resolving a task's skill re-reads the mode YAML + global skill index; cache the
  // resolved skill-id Set per mode so a backlog of N tasks parses each catalog once,
  // not once per task. Keyed by the task's raw mode (undefined shares one key and
  // resolves against the active mode, exactly as skillForMode did per-call).
  const modeSkillIdCache = new Map();
  const skillIdsForMode = (modeId) => {
    const key = modeId || '';
    if (!modeSkillIdCache.has(key)) {
      const doc = loadMode(modeId || resolveModeId());
      modeSkillIdCache.set(key, new Set(modeSkillEntries(doc).map((s) => s.id)));
    }
    return modeSkillIdCache.get(key);
  };
  for (const t of tasks) {
    ok(t.id, 'A backlog task is missing an id');
    ok(ALLOWED_STATUSES.includes(t.status), `Task ${t.id} has invalid status: ${t.status}`);
    if (t.skill) ok(skillIdsForMode(t.mode).has(t.skill), `Task ${t.id} references unknown skill: ${t.skill}${t.mode ? ` (mode: ${t.mode})` : ''}`);
    for (const dep of t.dependencies || []) {
      ok(ids.has(dep), `Task ${t.id} references unknown dependency: ${dep}`);
    }
    if (t.acceptance_checks !== undefined) {
      ok(Array.isArray(t.acceptance_checks) && t.acceptance_checks.every((c) => typeof c === 'string'),
        `Task ${t.id} acceptance_checks must be a list of shell command strings`);
    }
    if (t.commands !== undefined) {
      ok(Array.isArray(t.commands) && t.commands.every((c) => typeof c === 'string'),
        `Task ${t.id} commands must be a list of shell command strings`);
    }
    if (t.manual !== undefined) {
      ok(typeof t.manual === 'boolean', `Task ${t.id} manual must be a boolean`);
    }
    // `docs:` is the card's document association (design D6): the paths a human needs
    // to read to judge this task. It earns its place because the CLI EXECUTES it here —
    // every entry must be a playbook-root-relative file that exists. A missing document
    // is a FAILURE, not a warning: a card pointing at a design no other agent can open
    // is a broken association, and a design that moves must break the build loudly.
    if (t.docs !== undefined) {
      const docs = Array.isArray(t.docs) ? t.docs : null;
      ok(docs && docs.every((d) => typeof d === 'string' && d.trim()),
        `Task ${t.id} docs must be a list of playbook-root-relative file paths`);
      for (const d of docs || []) {
        if (typeof d !== 'string' || !d.trim()) continue;
        const rel = d.trim();
        ok(!/^([a-zA-Z]:[\\/]|[\\/])/.test(rel),
          `Task ${t.id} docs path must be relative to the playbook root: ${rel}`);
        ok(exists(rel), `Task ${t.id} docs path does not exist: ${rel}`);
      }
    }
  }

  // 6. structural guardrails for the layer/dependency graph. `pb validate` is the
  // structural gate, so a cycle or a task declared in an earlier layer than its
  // dependencies must FAIL here — a plan that cannot be ordered is not a plan, and
  // finding that out at claim time (or mid-run) is far more expensive.
  {
    const plan = computeLayerPlan({ checkGates: false, allTasks: tasks });
    for (const issue of plan.problems) {
      const where = issue.task ? `[${issue.task}] ` : '';
      failures.push(`${where}${issue.message} (${issue.code})`);
    }
    if (!plan.ordered && tasks.some((t) => t.layer !== undefined && String(t.layer).trim() !== '')) {
      failures.push('Tasks declare a `layer` but the master declares no `layers` list, so the declaration cannot be resolved.');
    }
  }

  // 7. journal lines all valid JSON
  readJournal().forEach((e) => {
    if (e.__malformed) failures.push(`Malformed JSON in ${JOURNAL} line ${e.__line}`);
  });
  if (existsSync(p(LOOPS))) {
    try { yaml.load(readText(LOOPS)); }
    catch (e) { failures.push(`Malformed YAML in ${LOOPS}: ${e.message}`); }
    const loops = readLoops();
    ok(Array.isArray(loops.loops), `${LOOPS} must contain a "loops" list`);
    const ids = new Set();
    for (const l of loops.loops) {
      ok(l.id, `A loop entry in ${LOOPS} is missing an id`);
      if (l.id) ids.add(l.id);
      ok(['active', 'done', 'failed', 'quarantined', 'abandoned'].includes(l.status), `Loop ${l.id || '?'} has invalid status: ${l.status}`);
    }
    if (loops.active) ok(ids.has(loops.active), `${LOOPS} active loop does not exist: ${loops.active}`);
  }
  if (existsSync(p(LESSONS))) {
    readNdjson(LESSONS).forEach((e) => {
      if (e.__malformed) failures.push(`Malformed JSON in ${LESSONS} line ${e.__line}`);
    });
  }
  if (existsSync(p(PROCESSES))) {
    readNdjson(PROCESSES).forEach((e) => {
      if (e.__malformed) failures.push(`Malformed JSON in ${PROCESSES} line ${e.__line}`);
    });
  }

  // 7. declared paths targets exist
  for (const [k, v] of Object.entries(mPaths)) {
    ok(exists(v), `paths.${k} target does not exist: ${v}`);
  }

  // 8. mode catalog (modes/index.yaml) agrees with the master's `modes:` registry.
  //    The menu must never silently DISAGREE with the master — a lying menu is
  //    worse than no menu. Enforced only when the catalog exists (an absent menu
  //    is a different concern; minimal/bootstrap playbooks may carry no catalog).
  if (Object.keys(MODES).length && exists('modes/index.yaml')) {
    const CATALOG = 'modes/index.yaml';
    const cat = readData(CATALOG);
    ok(cat && Array.isArray(cat.modes), `Mode catalog ${CATALOG} must contain a "modes" list`);
    const catIds = new Set((cat?.modes || []).map((m) => m && m.id).filter(Boolean));
    for (const id of Object.keys(MODES)) ok(catIds.has(id), `Mode "${id}" is in playbook.yaml modes: but missing from ${CATALOG}`);
    for (const id of catIds) ok(MODES[id] !== undefined, `Mode "${id}" is in ${CATALOG} but not in playbook.yaml modes:`);
    for (const m of cat?.modes || []) {
      ok(m && m.id, `A mode entry in ${CATALOG} is missing an id`);
      ok(m && typeof m.abstract === 'string' && m.abstract.trim(), `Mode "${m?.id}" in ${CATALOG} needs a non-empty abstract`);
    }
  }

  return failures;
}

function cmdValidate(args) {
  if (typeof args.task === 'string') {
    // Per-task checks are not a substitute for structural guardrails.
    const failures = runValidate();
    if (failures.length) {
      console.error('Playbook validation FAILED:\n');
      for (const f of failures) console.error(`  - ${f}`);
      process.exit(1);
    }
    const task = backlogTasks().find((t) => t.id === args.task);
    if (!task) {
      console.error(`Task not found in ${BACKLOG}: ${args.task}`);
      process.exit(1);
    }
    const checks = taskChecks(task);
    if (!checks.length) {
      console.log(`[${task.id}] has no acceptance_checks — verification is manual. Add executable checks to make "done" enforceable.`);
      return;
    }
    const suspect = checkPathWarnings(checks);
    if (suspect.length) {
      console.log(`\n⚠ Path warning: checks run with cwd = playbook root (this folder, "${PLAYBOOK_DIR}/").`);
      console.log(`  These check(s) reference "${PLAYBOOK_DIR}/" — likely a workspace-relative path. Drop that prefix:`);
      for (const c of suspect) console.log(`    ⚠  ${c}`);
      console.log('');
    }
    console.log(`Running ${checks.length} acceptance check(s) for [${task.id}] (cwd: playbook root):`);
    const results = runChecks(task);
    printCheckResults(results);
    if (results.some((r) => !r.ok)) process.exit(1);
    console.log(`All checks passed for [${task.id}].`);
    return;
  }

  const failures = runValidate();
  if (failures.length) {
    console.error('Playbook validation FAILED:\n');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('Playbook validation passed.');

  // Hollow-check pass: warn (or fail with --strict) when actionable tasks rely only on
  // structural checks. The structural gate (pb validate) proves the playbook is well-formed,
  // not that the task's work was done — making "done" a false green.
  const allTasks = backlogTasks();
  const hollowActionable = allTasks.filter(
    (t) => ['todo', 'in_progress'].includes(t.status) && gateQuality(t) === '⚠hollow'
  );
  if (hollowActionable.length) {
    console.log(`\n⚠ Hollow gate warning: ${hollowActionable.length} actionable task(s) use only structural checks (pb validate):`);
    for (const t of hollowActionable) console.log(`  ⚠hollow  [${t.id}] ${t.title || ''}`);
    console.log('Add task-specific acceptance_checks that test the work itself. Run `node scripts/check-hollow.mjs .` for details.');
    if (args.strict) { console.error('\nFailing (--strict): hollow gates on actionable tasks.'); process.exit(1); }
  }

  // Tracked-state trap: runtime state committed to git gets reverted by merges,
  // silently destroying records. Warn loudly, and fail under --strict.
  const trap = trackedStateWarnings();
  if (trap.length) {
    console.log(`\n⚠ ${trap.join('\n  ')}`);
    if (args.strict) { console.error('\nFailing (--strict): pb runtime state is git-tracked.'); process.exit(1); }
  }

  // --mode: also run the active mode's kind:check principles. Opt-in so plain
  // `pb validate` stays structural-only (and non-recursive: a check principle may
  // itself invoke `pb validate`, but never `pb validate --mode`).
  if (args.mode) {
    const id = resolveModeId();
    const doc = loadMode(id);
    const checks = doc ? modeCheckPrinciples(doc) : [];
    if (checks.length) {
      console.log(`\nRunning ${checks.length} kind:check principle(s) for mode "${id}":`);
      const results = runModeChecks(doc);
      printModeCheckResults(results);
      if (results.some((r) => !r.ok)) { console.error(`\nMode "${id}" check FAILED.`); process.exit(1); }
    }
  }
}


function countsByStatus(tasks) {
  const counts = Object.fromEntries(ALLOWED_STATUSES.map((status) => [status, 0]));
  for (const t of tasks) if (counts[t.status] !== undefined) counts[t.status]++;
  return counts;
}
function statusPayload() {
  const tasks = backlogTasks();
  const journal = readJournal();
  const loop = activeLoop();
  const failures = runValidate();
  const next = tasks.filter((t) => t.status === 'todo').sort((a, b) => prio(a) - prio(b))[0] || null;
  return {
    schema: 'agent-playbook.status.v1',
    name: master?.name || 'playbook',
    version: master?.version || null,
    backlog: {
      counts: countsByStatus(tasks),
      total: tasks.length,
      next: next ? { id: next.id, title: next.title, skill: next.skill || null, priority: prio(next) } : null,
      in_progress: tasks.filter((t) => t.status === 'in_progress').map((t) => ({ id: t.id, title: t.title, claimed_by: taskHolder(t) })),
    },
    loop: loop ? { id: loop.id, status: loop.status, goal: loop.goal || null, mode: loop.mode || null } : null,
    guardrails: { status: failures.length ? 'fail' : 'green', failures },
    lessons: { high_open: openLessons().filter((l) => l.severity === 'high').length },
    recent_journal: journal.slice(-5),
  };
}
function printJson(obj) {
  console.log(JSON.stringify(obj, null, 2));
}
function taskPayload(id) {
  const task = backlogTasks().find((t) => t.id === id);
  if (!task) return null;
  return {
    schema: 'agent-playbook.task.v1',
    task,
    acceptance_checks: taskChecks(task),
    gate_quality: gateQuality(task),
    holder: taskHolder(task),
  };
}
function commandQuote(s) {
  return String(s).replace(/'/g, "'\\''");
}
function safeSlug(value) {
  return String(value || '').trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'worker';
}
function taskState(taskId) {
  return readBacklogState()[taskId] || {};
}
function runCardForTask(task) {
  const state = taskState(task.id);
  const journal = readJournal().filter((e) => !e.__malformed && e.task === task.id);
  return {
    schema: 'agent-playbook.runcard.v1',
    id: `run-${task.id}`,
    task_id: task.id,
    title: task.title || '',
    status: state.status ?? task.status,
    loop_id: state.loop_id ?? task.loop_id ?? null,
    agent: state.claimed_by || state.agent_id || null,
    mode: state.mode || task.mode || null,
    worker: state.worker || null,
    provider: state.provider || null,
    checker: state.checker || null,
    checks: taskChecks(task).map((command) => ({ command })),
    journal_range: journal.length ? { first_ts: journal[0].ts || null, last_ts: journal[journal.length - 1].ts || null, count: journal.length } : null,
    // The per-task journal read path (design gap #1). `journal_range` already filtered
    // the append-only file by task; the rows themselves were the only thing missing, so
    // the fix is the same read path, not a second store and not a new verb: every
    // consumer of a RunCard (including `pb graph`) gets the card's ordered, attributed
    // history for free. Rows are emitted verbatim — a projection that renamed `notes`
    // to something prettier would be inventing a field the journal does not have.
    journal,
    updated_at: state.updated_at || null,
  };
}
// The last `done` journal row for a task — the record that says whether
// acceptance_checks actually ran, or were skipped with --skip-checks. Deliberately
// not `blocked`: operational rows like provider_rate_limit are blocked-status notes,
// not completion records, and must not be read as the work under review.
function lastDoneEntry(taskId) {
  const rows = readJournal().filter((e) => !e.__malformed && e.task === taskId && e.status === 'done');
  return rows.length ? rows[rows.length - 1] : null;
}
// Merge gate. A checker verdict alone is a claim, not verification (lesson-20260705-001):
// the task must also have reached `done` through its executable acceptance_checks,
// and the review must be newer than the work it claims to have reviewed.
function mergeReadyPayload(task) {
  const state = taskState(task.id);
  const checker = state.checker || null;
  const done = lastDoneEntry(task.id);
  const checks = taskChecks(task);
  const reasons = [];
  const warnings = [];

  if (checker?.verdict !== 'pass') reasons.push(`checker verdict must be pass (got ${checker?.verdict || 'none recorded'})`);
  if (task.status !== 'done') reasons.push(`task status must be done (got ${task.status})`);
  if (done?.checks === 'skipped') reasons.push('acceptance checks were skipped on the done record — re-record without --skip-checks');
  if (checker && done?.ts && checker.recorded_at < done.ts) {
    reasons.push('checker verdict predates the latest done record — re-review the current work');
  }

  // Branch-level gate. The journal says the task was delivered; the BRANCH says
  // whether the reviewed work is actually there to merge. A verdict over a branch
  // that carries no commits (or a worktree that is gone) is a claim about nothing.
  const worker = state.worker || null;
  let branchState = null;
  if (worker && LIVE_WORKER_STATUSES.has(worker.status)) {
    // Only a LIVE slot is expected to still be on disk. A `removed`/`merged` record
    // is history: its worktree is gone BY DESIGN, and blocking the gate on that
    // would make teardown permanently poison the task (the work may already be
    // merged, and the verdict reviewed the branch, not the directory).
    branchState = worktreeState(worker);
    if (!branchState.present) {
      reasons.push(`worker worktree is missing on disk (${branchState.path}) — the reviewed work cannot be merged from it`);
    } else {
      if (branchState.clean === false) {
        reasons.push(`worker worktree has ${branchState.changed.length} uncommitted change(s) — commit them before merging`);
      }
      if (branchState.ahead === 0) {
        reasons.push('worker branch has no commits ahead of its base — there is no work to merge');
      }
      const verified = worker.last_verified_commit || null;
      if (!verified) {
        warnings.push('worker has never been verified in its own worktree (`pb worker verify`)');
      } else if (branchState.head && verified !== branchState.head) {
        warnings.push(`verification is stale: verified ${verified.slice(0, 8)} but the branch is at ${branchState.head.slice(0, 8)}`);
      } else if (worker.last_verified_passed === false) {
        reasons.push('the last in-worktree verification FAILED — re-run `pb worker verify`');
      }
    }
  } else if (worker) {
    branchState = worktreeState(worker);
    warnings.push(`worker slot was already torn down (status: ${worker.status}) — merge readiness was judged from the journal and branch record`);
  } else {
    warnings.push('no worker worktree recorded — merge readiness was judged from the journal alone');
  }

  if (!checks.length) warnings.push('task has no acceptance_checks — "done" rests on operator honor');
  else if (gateQuality(task) === '⚠hollow') warnings.push('acceptance_checks are structural only (validate) — they do not test the work itself');
  if (state.provider?.status === 'rate_limited') warnings.push(`provider ${state.provider.name} is rate_limited (retry_after=${state.provider.retry_after})`);

  return {
    schema: 'agent-playbook.merge-ready.v1',
    task_id: task.id,
    ready: reasons.length === 0,
    status: task.status,
    checker,
    checks_outcome: done?.checks ?? null,
    gate_quality: gateQuality(task),
    worker,
    branch: branchState,
    reasons,
    warnings,
  };
}
function cmdRunCard(args) {
  const sub = args._[0] || 'list';
  if (sub === 'list') {
    const runcards = backlogTasks().map(runCardForTask);
    if (args.json) return printJson({ schema: 'agent-playbook.runcards.v1', runcards });
    for (const card of runcards) console.log(`[${card.task_id}] ${card.status} ${card.title}`);
    return;
  }
  if (sub === 'show') {
    const id = args._[1];
    const task = backlogTasks().find((t) => t.id === id);
    if (!task) { console.error(`Task not found: ${id}`); process.exit(1); }
    const card = runCardForTask(task);
    if (args.json) return printJson(card);
    console.log(`[${card.task_id}] ${card.status} ${card.title}`);
    if (card.worker) console.log(`worker: ${card.worker.agent || ''} ${card.worker.branch || ''} ${card.worker.worktree_path || ''}`);
    if (card.checker) console.log(`checker: ${card.checker.verdict || 'pending'}`);
    return;
  }
  console.error('Usage: pb runcard list|show <task-id> [--json]');
  process.exit(1);
}
function cmdTask(args) {
  const sub = args._[0];
  if (sub !== 'show' || !args._[1]) {
    console.error('Usage: pb task show <task-id> [--json]');
    process.exit(1);
  }
  const payload = taskPayload(args._[1]);
  if (!payload) { console.error(`Task not found: ${args._[1]}`); process.exit(1); }
  if (args.json) return printJson(payload);
  console.log(`[${payload.task.id}] ${payload.task.title}`);
  console.log(`status: ${payload.task.status}`);
}

// ============================================================================
//  graph — one read-only projection for a graph UI (schema below).
// ----------------------------------------------------------------------------
// The room in artifacts/graph-flow-ui/DESIGN.md §4.1 is a picture OF a projection,
// never a second orchestration brain. So every node is composed from readers the CLI
// already exposes (runcard ∪ `task show` ∪ the state overlay), every edge names the
// record that proves it, and NOTHING here writes state or executes a gate command.
// The rule that decides the shape: a node's status comes from the state projection
// (memory/backlog-state.json), NEVER from `status:` in backlog.yaml — on disk every
// task says `todo`, so a UI reading the YAML would paint an entirely-todo graph.
// ============================================================================
const GRAPH_SCHEMA = 'agent-playbook.graph.v1';
// The loop steps are the master's own declaration, not a constant: a playbook that
// renames its steps gets its own rail. The fallback only covers a master with none.
const GRAPH_STEP_FALLBACK = ['orient', 'select', 'act', 'verify', 'record', 'report'];
function graphStepIds() {
  const ids = (Array.isArray(master?.loop?.steps) ? master.loop.steps : [])
    .map((s) => (s && s.id ? String(s.id) : null)).filter(Boolean);
  return ids.length ? ids : GRAPH_STEP_FALLBACK;
}
// Journal action → the loop step it belongs to. This is a table, not a guess: deriving
// it from the verb would file a `comment` under act and a `provider_rate_limit` under
// nothing. An action the table does not know is work that happened — `act`.
const GRAPH_STEP_ACTION = {
  claim: 'select', release: 'select',
  verify: 'verify', checker: 'verify',
  record: 'record', comment: 'record', correct: 'record', provider_rate_limit: 'record',
  reflect: 'report', report: 'report',
};
function graphStepForAction(action) {
  return GRAPH_STEP_ACTION[action] || 'act';
}
// The card's cycle rail: which loop steps this task's journal rows show it passed
// through, and the step of its most recent row. A step, never a percentage — the
// engine has no completion fraction and must not grow one (rule 25).
function cycleForJournal(journal) {
  const steps = graphStepIds();
  const filled = [];
  for (const row of journal) {
    const step = graphStepForAction(row.action);
    if (!filled.includes(step)) filled.push(step);
  }
  const last = journal.length ? graphStepForAction(journal[journal.length - 1].action) : null;
  const index = last ? steps.indexOf(last) : -1;
  return { step: index >= 0 ? last : null, index: index >= 0 ? index : null, steps, filled };
}
function docsOfTask(task) {
  return (Array.isArray(task.docs) ? task.docs : [])
    .filter((d) => typeof d === 'string' && d.trim()).map((d) => d.trim());
}
function graphNodeFor(task, planned) {
  const card = runCardForTask(task);
  const state = taskState(task.id);
  const gate = mergeReadyPayload(task);
  const declared = planned?.layer || null;
  const derived = planned && typeof planned.derived_layer === 'number' ? planned.derived_layer : null;
  return {
    id: task.id,
    title: card.title,
    status: card.status,                       // the state overlay — never backlog.yaml's `status:`
    layer: declared || (derived === null ? null : `L${derived + 1}`),
    declared_layer: declared,
    derived_layer: derived,
    priority: planned?.priority ?? prio(task),
    skill: task.skill || null,
    mode: card.mode,
    checks: card.checks.length,
    acceptance_checks: card.checks.map((c) => c.command),
    gate_quality: planned?.gate_quality || gateQuality(task),
    manual: !!task.manual,
    claim: { by: card.agent, seq: typeof state.seq === 'number' ? state.seq : null, loop_id: card.loop_id },
    checker: card.checker,
    worker: card.worker ? {
      branch: card.worker.branch || null,
      status: card.worker.status || null,
      worktree_path: card.worker.worktree_path || null,
      merged_at: card.worker.merged_at || null,
      merge_commit: card.worker.merge_commit || null,
      merge_ready: gate.ready,
    } : null,
    // Fork/merge-back are WORKER facts, not task→task relations: PB models a branch as
    // an attribute of the task that owns it (state.worker), so the honest place for them
    // is here. A UI that needs them as edges has no endpoint the engine can name.
    merge_ready: gate.ready,
    merge_reasons: gate.reasons,
    merge_warnings: gate.warnings,
    cycle: cycleForJournal(card.journal),
    docs: docsOfTask(task),
    journal: card.journal,
    updated_at: card.updated_at,
  };
}
// Every edge is a relation a record proves, and `proven` says whether the engine can
// show it as a FACT (true) or only as a CLAIM (false — the design draws those dashed,
// and never solid). Endpoints are node ids plus the two bookends and the human batch:
//   dep    a dependency, INVERTED from `plan --layers` (which maps task → prerequisites)
//   spawn  origin → task: the orchestrator started it. The origin is the spawn row's
//          `origin_task` — the task that was in flight when `pb plan` created this one —
//          falling back to `parent` (the alias DESIGN.md named) and then to `start` when
//          the row names no task this backlog carries. A journal `action: spawn` row is
//          a FACT (proven:true, evidence:'spawn'); a plain claim row is a claim
//          (proven:false, evidence:'claim') — the two are never the same ink.
//   hil    task → `human`, only for a declared `manual: true` that is not done.
function graphEdges(nodes, plan) {
  const nodeIds = new Set(nodes.map((n) => n.id));
  const edges = [];
  for (const [taskId, deps] of Object.entries(plan.edges || {})) {
    if (!nodeIds.has(taskId)) continue;
    for (const dep of Array.isArray(deps) ? deps : []) {
      if (!nodeIds.has(dep)) continue;
      // `exited_zero` is the design's "done-through" treatment: the prerequisite only
      // counts as passed when its last done record actually RAN its checks.
      edges.push({ from: dep, to: taskId, kind: 'dep', proven: true, exited_zero: lastDoneEntry(dep)?.checks === 'passed' });
    }
  }
  for (const node of nodes) {
    const spawnRow = node.journal.find((r) => r.action === 'spawn') || null;
    const claimRow = node.journal.find((r) => r.action === 'claim') || null;
    const evidence = spawnRow || claimRow;
    if (!evidence) continue;
    const origin = spawnRow
      ? (typeof spawnRow.origin_task === 'string' && spawnRow.origin_task
        ? spawnRow.origin_task
        : (typeof spawnRow.parent === 'string' ? spawnRow.parent : null))
      : null;
    const parent = origin && nodeIds.has(origin) ? origin : null;
    edges.push({
      from: parent || 'start',
      to: node.id,
      kind: 'spawn',
      proven: !!(spawnRow || parent),
      by: evidence.agent || evidence.claimed_by || null,
      seq: typeof evidence.seq === 'number' ? evidence.seq : null,
      loop: evidence.loop_id || null,
      origin_runtime: evidence.origin_runtime || null,
      evidence: spawnRow ? 'spawn' : 'claim',
    });
  }
  for (const node of nodes) {
    if (node.manual && node.status !== 'done') {
      edges.push({ from: node.id, to: 'human', kind: 'hil', proven: true, reason: 'the task declares manual: true — only a person can close it' });
    }
  }
  return edges;
}
// The human batch. Two kinds of "a person is needed" exist, and they do NOT have the
// same evidential standing, so they are not in the same array:
//   batch              — proven without side effects: `manual: true` and not done.
//                        `loop run --auto` already defers exactly these, so this is a
//                        projection of behaviour, not a new flag.
//   unevaluated_gates  — a declared `human: true` layer gate. Gates are SHELL COMMANDS,
//                        and a read-only projection must not run them. Rendering an
//                        unevaluated gate inside `batch` would be the engine being
//                        confidently wrong about needing a human; labelling it here is
//                        the honest default the design's gap #5 asked for.
function graphHumanBatch(nodes, plan) {
  const batch = [];
  for (const node of nodes) {
    if (!node.manual || node.status === 'done') continue;
    batch.push({
      kind: 'manual',
      gate: null,
      command: node.acceptance_checks[0] || null,
      commands: node.acceptance_checks,
      tasks: [node.id],
      task: node.id,
      title: node.title,
      status: node.status,
      reason: 'the task declares manual: true — `pb loop run --auto` defers it, so this is a question for a person, not a retry',
    });
  }
  const unevaluated = [];
  const defs = readLayerDefs();
  if (defs.declared && defs.layers.length) {
    const order = defs.layers.map((l) => l.id);
    for (const def of defs.layers) {
      if (!def.human || !def.gate) continue;
      const pos = order.indexOf(def.id);
      const blocked = plan.tasks
        .filter((t) => t.status !== 'done' && t.layer && order.indexOf(t.layer) > pos)
        .map((t) => t.id);
      if (!blocked.length) continue;
      unevaluated.push({
        kind: 'gate', layer: def.id, name: def.name || null, gate: def.gate, command: def.gate,
        tasks: blocked, evaluated: false,
        reason: 'layer gate was NOT executed — `pb graph` never runs gate commands; run `pb plan --layers --check-gates` to evaluate it',
      });
    }
  }
  return { batch, unevaluated };
}
// The two bookends. They are NOT task rows and must never become any: the start is the
// loop epoch + cycle brief, the goal is the cycle's prose stop condition. Both already
// belong to PB, so the graph composes them instead of inventing non-executable tasks.
function graphStart(loop) {
  const cyc = readCycle();
  return {
    id: 'start',
    loop: loop?.id || null,
    loop_status: loop?.status || null,
    started_at: loop?.started_at || null,
    phase: cyc.exists && cyc.phase !== undefined ? cyc.phase : null,
    goal: (cyc.exists && cyc.goal) || loop?.goal || null,
    stop: (cyc.exists && cyc.stop) || loop?.stop || null,
    mode: loop?.mode || master?.default_mode || null,
  };
}
function graphGoal(start) {
  const stop = start.stop || null;
  // The stop condition is prose and NOTHING exits 0 on it. The clauses are exposed so
  // the end-goal card can render a checklist, but `met` stays null (unevaluated) for
  // every one: the engine will not paint a goal as reached. A `met: true` here would be
  // the exact "declares victory unchecked" failure the North Star forbids.
  const conditions = stop
    ? String(stop).split(/[;\n]+/).map((s) => s.trim()).filter(Boolean).map((text) => ({ text, met: null }))
    : [];
  return { id: 'goal', stop, north_star: master?.north_star || null, conditions, conditions_evaluated: false };
}
function graphPayload() {
  const tasks = backlogTasks();
  const plan = computeLayerPlan({ checkGates: false, allTasks: tasks });
  const plannedById = new Map(plan.tasks.map((t) => [t.id, t]));
  const nodes = tasks.map((t) => graphNodeFor(t, plannedById.get(t.id)));
  const human = graphHumanBatch(nodes, plan);
  const start = graphStart(activeLoop());
  return {
    schema: GRAPH_SCHEMA,
    start,
    goal: graphGoal(start),
    nodes,
    edges: graphEdges(nodes, plan),
    human: {
      id: 'human',
      batch: human.batch,
      unevaluated_gates: human.unevaluated,
      gates_checked: false,
      note: 'gate commands are never executed by `pb graph`; `unevaluated_gates` holds the declared human gates whose state is unknown',
    },
  };
}
function cmdGraph(args) {
  const payload = graphPayload();
  if (args.json) return printJson(payload);
  const byStatus = {};
  for (const n of payload.nodes) byStatus[n.status] = (byStatus[n.status] || 0) + 1;
  const kinds = {};
  for (const e of payload.edges) kinds[e.kind] = (kinds[e.kind] || 0) + 1;
  console.log(`${GRAPH_SCHEMA} — ${payload.nodes.length} node(s), ${payload.edges.length} edge(s)`);
  console.log(`loop ${payload.start.loop || '(none)'} · phase ${payload.start.phase ?? '(none)'}`);
  console.log(`status: ${Object.entries(byStatus).map(([k, v]) => `${k}=${v}`).join(' ') || '(none)'}`);
  console.log(`edges: ${Object.entries(kinds).map(([k, v]) => `${k}=${v}`).join(' ') || '(none)'}`);
  if (payload.human.batch.length) {
    console.log(`waiting on a human (${payload.human.batch.length}):`);
    for (const b of payload.human.batch) console.log(`  ${b.kind} [${b.tasks.join(', ')}] ${b.command || ''}`.trimEnd());
  } else {
    console.log('waiting on a human: none provable without running a gate');
  }
  for (const g of payload.human.unevaluated_gates) console.log(`  unevaluated human gate [${g.layer}] ${g.gate} (not run)`);
}
function gitToplevel() {
  try {
    return execSync('git rev-parse --show-toplevel', { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    console.error('Not inside a git repository — `pb worker` needs git worktrees. Run `git init` first.');
    process.exit(1);
  }
}
// Worker git calls send their chatter to stderr, never stdout: `--json` consumers
// parse stdout, and "Preparing worktree..." in the middle of a payload is a parse error.
function runGit(argv) {
  // stderr inherits (git's own progress goes straight to the terminal); stdout is
  // captured and re-emitted on stderr so our stdout stays machine-parseable.
  try {
    const out = execFileSync('git', argv, { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] });
    if (out?.length) process.stderr.write(out.toString());
  } catch (err) {
    if (err?.stdout?.length) process.stderr.write(err.stdout.toString());
    throw err;
  }
}
// Same contract, but for calls whose stdout is a MACHINE-READ payload rather than
// chatter (rev-parse, rev-list, status --porcelain). Returning the trim'd value
// keeps callers from re-parsing, and a failure returns null instead of throwing so
// "the worktree is gone" is a reportable state rather than a crash.
function runGitCapture(argv, cwd = ROOT) {
  try {
    return execFileSync('git', argv, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}
// A live worker record is one that still owns a slot. `removed`/`merged` are
// historical, not live: teardown makes the slot reusable rather than poisoning it.
const LIVE_WORKER_STATUSES = new Set(['created', 'active', 'verified']);
function liveWorkerFor(taskId, state = readBacklogState()) {
  const rec = state[taskId]?.worker;
  if (!rec || !LIVE_WORKER_STATUSES.has(rec.status)) return null;
  return rec;
}
function liveWorkerAt(worktreePath) {
  const state = readBacklogState();
  for (const [taskId, entry] of Object.entries(state)) {
    if (taskId.startsWith('__')) continue;
    const rec = entry?.worker;
    if (!rec || !LIVE_WORKER_STATUSES.has(rec.status)) continue;
    if (rec.worktree_path && resolve(rec.worktree_path) === resolve(worktreePath)) return { taskId, rec };
  }
  return null;
}
function gitBranchExists(branch) {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: ROOT, stdio: 'ignore' });
    return true;
  } catch { return false; }
}
function workerNames(taskId, agent, { worktreeOverride, base } = {}) {
  const top = gitToplevel();
  return {
    branch: `agent/${safeSlug(taskId)}-${safeSlug(agent)}`,
    worktree: worktreeOverride
      ? resolve(process.cwd(), worktreeOverride)
      : resolve(dirname(top), `${basename(top)}-worker-${safeSlug(taskId)}-${safeSlug(agent)}`),
    base: base || 'HEAD',
  };
}
// Read-only git query inside a worktree. Returns null instead of throwing, so a
// missing/removed worktree is a reported state, not a crash.
function gitIn(cwd, argv) {
  try {
    return execFileSync('git', argv, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}
function worktreeState(worker) {
  const path = worker?.worktree_path || null;
  const branch = worker?.branch || null;
  const base = worker?.base_commit || worker?.base_branch || 'HEAD';
  const present = !!path && existsSync(path);
  if (!present) {
    return { present: false, path, branch, clean: null, ahead: null, behind: null, head: null, changed: [], error: 'worktree is not on disk' };
  }
  const head = gitIn(path, ['rev-parse', 'HEAD']);
  const porcelain = gitIn(path, ['status', '--porcelain']) ?? '';
  const changed = porcelain ? porcelain.split(/\r?\n/).filter(Boolean) : [];
  // `git status --porcelain` is empty for a clean tree, but an EMPTY STRING is also
  // what we get when the command failed — so distinguish "git said nothing" from
  // "git could not run" using the separately captured head.
  const usable = head !== null;
  const ahead = usable && base ? Number(gitIn(path, ['rev-list', '--count', `${base}..HEAD`]) ?? 0) : null;
  const behind = usable && base ? Number(gitIn(path, ['rev-list', '--count', `HEAD..${base}`]) ?? 0) : null;
  return {
    present: true,
    path,
    branch,
    base,
    clean: usable ? changed.length === 0 : null,
    ahead: Number.isNaN(ahead) ? null : ahead,
    behind: Number.isNaN(behind) ? null : behind,
    head,
    changed: changed.slice(0, 50),
    error: usable ? null : 'git could not read this worktree',
  };
}
function workerStatusPayload(taskId, worker) {
  const derived = worker ? null : workerNames(taskId, resolveAgentId({}));
  const rec = worker || { agent: resolveAgentId({}), branch: derived.branch, worktree_path: derived.worktree, status: 'absent' };
  const st = worktreeState(rec);
  return {
    schema: 'agent-playbook.worker-status.v1',
    task_id: taskId,
    agent: rec.agent || null,
    worker_status: rec.status || null,
    branch: st.branch,
    worktree: st.path,
    present: st.present,
    clean: st.clean,
    ahead: st.ahead,
    behind: st.behind,
    head: st.head,
    base: st.base || null,
    changed: st.changed,
    last_verified_commit: rec.last_verified_commit || null,
    verification_stale: !!(rec.last_verified_commit && st.head && rec.last_verified_commit !== st.head),
    error: st.error || null,
  };
}
// The worker slot is a per-task, per-agent resource. Serialize acquisition on its
// own lock so two agents cannot both observe a free slot and both run
// `git worktree add` (which used to leave an orphan worktree and a stray branch
// behind, with only the last writer visible in the state).
const WORKER_LOCK = `${BACKLOG_STATE}.worker.lock`;
function workerCreatePayload(taskId, agent, execute, opts = {}) {
  const { branch, worktree, base } = workerNames(taskId, agent, opts);
  const command = `git worktree add -b '${commandQuote(branch)}' '${commandQuote(worktree)}' ${base}`;
  return { schema: 'agent-playbook.worker.v1', action: 'create', task_id: taskId, agent, branch, worktree, worktree_path: worktree, base, command, execute: !!execute };
}
// --- link-safe teardown (data-loss guard) -----------------------------------
// A recursive delete FOLLOWS a Windows junction. That is not a theory: a worker
// worktree whose `node_modules` was a junction to the root checkout was torn down with
// `git worktree remove`, git walked THROUGH the link, and the root's node_modules was
// emptied to zero entries (js-yaml among them). Measured on this platform: Node's own
// `rmSync(recursive)` does not follow a junction, but git's delete does — so the engine
// must not depend on which implementation it happens to be calling.
//
// Every tree we are about to destroy is therefore walked with `lstat` (NEVER `stat`,
// which resolves the link) and each link is removed AS A LINK:
//   rmdir   a junction / directory symlink — on Windows this deletes the reparse point
//           and leaves the target completely untouched (measured);
//   unlink  a file symlink.
// If a link cannot be removed we REFUSE and name it: a worktree that survives is
// recoverable, a destroyed shared dependency tree is not.
//
// Detection is two-sided on purpose: `lstat().isSymbolicLink()` catches junctions and
// symlinks, and `readlink()` is the cross-check — it succeeds only for a reparse point
// and throws EINVAL for a real directory, so a normal directory can never be misread as
// a link and rmdir'd.
function isLinkLike(full, st) {
  if (st.isSymbolicLink()) return true;
  if (!st.isDirectory()) return false;                 // a regular file is never a link
  try { readlinkSync(full); return true; } catch { return false; }
}
// Every link under `dir`, WITHOUT ever descending through one — including when `dir`
// itself is a link, in which case its target is none of our business.
function treeLinks(dir) {
  let rootStat;
  try { rootStat = lstatSync(dir); } catch { return []; }
  if (isLinkLike(dir, rootStat)) return [dir];
  const links = [];
  const walk = (d) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const full = join(d, ent.name);
      let st;
      try { st = lstatSync(full); } catch { continue; }  // vanished under us: nothing to unlink
      if (isLinkLike(full, st)) { links.push(full); continue; }
      if (st.isDirectory()) walk(full);
    }
  };
  walk(dir);
  return links;
}
// Remove links without following them. Returns what was removed and what could not be.
function unlinkTreeLinks(dir) {
  const removed = [];
  const failed = [];
  for (const link of treeLinks(dir)) {
    let how = null;
    try { rmdirSync(link); how = 'rmdir'; }
    catch {
      try { unlinkSync(link); how = 'unlink'; } catch (e) { failed.push({ path: link, error: e.code || e.message }); }
    }
    if (how) removed.push({ path: link, how });
  }
  return { removed, failed };
}
function workerRemovePayload(taskId, agent, worker, { execute, force, deleteBranch }) {
  // Prefer the recorded worktree — the operator may have created it under a
  // different agent id or before a rename. Fall back to the derived names.
  const derived = workerNames(taskId, agent);
  const branch = worker?.branch || derived.branch;
  const worktree = worker?.worktree_path || derived.worktree;
  const steps = [`git worktree remove${force ? ' --force' : ''} '${commandQuote(worktree)}'`];
  if (deleteBranch) steps.push(`git branch -D '${commandQuote(branch)}'`);
  // A dry run should disclose the hazard, not hide it: these are the links the
  // teardown will unlink before git ever sees the tree (see unlinkTreeLinks).
  let links = [];
  try { if (existsSync(worktree)) links = treeLinks(worktree); } catch { links = []; }
  return {
    schema: 'agent-playbook.worker.v1', action: 'remove', task_id: taskId, agent,
    branch, worktree, delete_branch: !!deleteBranch, command: steps.join(' && '), execute: !!execute,
    links,
  };
}
function cmdWorker(args) {
  const sub = args._[0];
  if (sub === 'create') {
    const taskId = args._[1];
    if (!taskId) { console.error('Usage: pb worker create <task-id> --agent <agent> [--base <ref>] [--worktree <path>] [--execute] [--json]'); process.exit(1); }
    const task = backlogTasks().find((t) => t.id === taskId);
    if (!task) { console.error(`Task not found: ${taskId}`); process.exit(1); }
    const agent = args.agent || resolveAgentId(args);
    const opts = { base: typeof args.base === 'string' ? args.base : undefined, worktreeOverride: typeof args.worktree === 'string' ? args.worktree : undefined };
    const payload = workerCreatePayload(taskId, agent, !!args.execute, opts);
    if (!args.execute) {
      if (args.json) return printJson(payload);
      console.log(`[dry-run] ${payload.command}`);
      return;
    }
    // Slot acquisition is serialized on its own lock: check-then-act outside a lock
    // let two agents both see a free slot and both run `git worktree add`, leaving
    // an orphan worktree and branch that no worker record pointed at. This lock is
    // short-lived, so it gets a short stale window.
    if (!acquireLock(WORKER_LOCK, { staleMs: WORKER_LOCK_STALE_MS })) {
      console.error(`Could not acquire the worker slot for [${taskId}] (another agent is opening a worker). Re-run.`);
      console.error('If no worker create is actually running, clear the leaked lock with: pb unlock');
      process.exit(1);
    }
    try {
      // Refuse before mutating: a half-made worktree is worse than a clean error.
      if (gitBranchExists(payload.branch)) {
        console.error(`Branch already exists: ${payload.branch}`);
        console.error(`A worker for [${taskId}] is already open. Reuse it, or clean up with:\n  pb worker remove ${taskId} --agent ${agent} --delete-branch --execute`);
        process.exit(1);
      }
      if (existsSync(payload.worktree)) {
        console.error(`Worktree path already exists: ${payload.worktree}`);
        console.error('Remove or rename it, then retry.');
        process.exit(1);
      }
      const baseCommit = gitIn(ROOT, ['rev-parse', args.base && typeof args.base === 'string' ? args.base : 'HEAD']);
      if (!baseCommit) {
        console.error(`Could not resolve base ref "${payload.base}" — the worker would fork from nothing.`);
        process.exit(1);
      }
      // ONE live worker per task. The branch name embeds the agent, so two agents
      // racing for the same task would otherwise both pass the branch/path checks
      // and both open a slot — the "winner" being merely whoever wrote state last.
      // Slot identity is the TASK, not the task+agent pair.
      if (!args.force) {
        const live = liveWorkerFor(taskId);
        if (live) {
          console.error(`[${taskId}] already has a live worker slot held by "${live.agent}" (${live.status}, since ${live.created_at || 'unknown'}).`);
          console.error(`  Reuse it, tear it down with \`pb worker remove ${taskId} --agent ${live.agent} --execute\`,`);
          console.error('  or pass --force to open a second slot (two workers editing one task will collide).');
          process.exit(1);
        }
        const clash = liveWorkerAt(payload.worktree);
        if (clash) {
          console.error(`Worktree path is already held by [${clash.taskId}] (agent ${clash.rec.agent}): ${payload.worktree}`);
          console.error(`Pick another path with --worktree, or tear that slot down first.`);
          process.exit(1);
        }
      }
      try {
        // --quiet: `git worktree add` writes "Preparing worktree…" and "HEAD is now
        // at…" to STDOUT, which corrupted `--json` payloads (the consumer's parse
        // error, not git's, is what surfaced).
        runGit(['worktree', 'add', '--quiet', '-b', payload.branch, payload.worktree, payload.base]);
      } catch {
        console.error(`\nFailed to create the worker worktree for [${taskId}] (see git output above). No state was recorded.`);
        process.exit(1);
      }
      const branchHead = gitIn(payload.worktree, ['rev-parse', 'HEAD']);
      updateBacklogState(taskId, () => ({
        worker: {
          agent,
          branch: payload.branch,
          worktree_path: payload.worktree,
          base_branch: payload.base,
          base_commit: baseCommit,
          head_commit: branchHead || baseCommit,
          status: 'created',
          created_at: nowISO(),
        },
        updated_at: nowISO(),
      }), { agent });
    } finally {
      releaseLock(WORKER_LOCK);
    }
    if (args.json) return printJson(payload);
    console.log(`[exec] ${payload.command}`);
    console.log(`Worker slot open: ${payload.worktree} (branch ${payload.branch}, from ${payload.base})`);
    if (args.json === undefined) console.log(`Run the work there, then: pb worker verify ${taskId} --agent ${agent}`);
    return;
  }
  if (sub === 'status') {
    const taskId = args._[1];
    if (!taskId) { console.error('Usage: pb worker status <task-id> [--json]'); process.exit(1); }
    const task = backlogTasks().find((t) => t.id === taskId);
    if (!task) { console.error(`Task not found: ${taskId}`); process.exit(1); }
    const worker = taskState(taskId).worker || null;
    const payload = workerStatusPayload(taskId, worker);
    if (args.json) return printJson(payload);
    if (!worker) { console.log(`[${taskId}] has no worker — no worktree to report.`); return; }
    console.log(`[${taskId}] worker ${payload.agent} · ${payload.worker_status}`);
    console.log(`  branch:  ${payload.branch}`);
    console.log(`  tree:    ${payload.worktree}${payload.present ? '' : '  (MISSING on disk)'}`);
    console.log(`  base:    ${payload.base}`);
    console.log(`  head:    ${payload.head || '(unreadable)'}`);
    console.log(`  changes: ${payload.clean === null ? 'unknown' : payload.clean ? 'clean' : `${payload.changed.length} uncommitted`}`);
    console.log(`  ahead:   ${payload.ahead === null ? '?' : payload.ahead}  behind: ${payload.behind === null ? '?' : payload.behind}`);
    if (payload.verification_stale) console.log('  ⚠ verification is stale — the branch moved since the last verify');
    return;
  }
  if (sub === 'exec') {
    const taskId = args._[1];
    const argv = Array.isArray(args['--']) ? args['--'] : [];
    if (!taskId || !argv.length) { console.error('Usage: pb worker exec <task-id> -- <command> [args...]'); process.exit(1); }
    const worker = taskState(taskId).worker || null;
    if (!worker?.worktree_path) { console.error(`[${taskId}] has no worker worktree — run \`pb worker create ${taskId} --execute\` first.`); process.exit(1); }
    if (!existsSync(worker.worktree_path)) { console.error(`The worker worktree is missing on disk: ${worker.worktree_path}`); process.exit(1); }
    const [file, ...rest] = argv;
    // Commands run with cwd = the WORKER's tree, so "the work" is exercised in the
    // isolated checkout that will actually be merged.
    try {
      const out = runCommandSync(file, rest, { cwd: worker.worktree_path, stdio: ['ignore', 'pipe', 'inherit'] });
      if (out?.length) process.stderr.write(out.toString());
      return;
    } catch (err) {
      if (err?.stdout?.length) process.stderr.write(err.stdout.toString());
      console.error(`\nworker exec failed for [${taskId}] (exit ${err?.status ?? 'unknown'}).`);
      process.exit(err?.status || 1);
    }
  }
  if (sub === 'verify') {
    const taskId = args._[1];
    if (!taskId) { console.error('Usage: pb worker verify <task-id> [--json]'); process.exit(1); }
    const task = backlogTasks().find((t) => t.id === taskId);
    if (!task) { console.error(`Task not found: ${taskId}`); process.exit(1); }
    const worker = taskState(taskId).worker || null;
    if (!worker?.worktree_path) { console.error(`[${taskId}] has no worker worktree — run \`pb worker create ${taskId} --execute\` first.`); process.exit(1); }
    if (!existsSync(worker.worktree_path)) { console.error(`The worker worktree is missing on disk: ${worker.worktree_path}`); process.exit(1); }
    const checks = taskChecks(task);
    const commands = taskCommands(task);
    const checkResults = checks.length ? runChecks(task, worker.worktree_path) : [];
    const commandResults = commands.length ? runCommands(task, worker.worktree_path) : [];
    const passed = [...checkResults, ...commandResults].every((r) => r.ok);
    const head = gitIn(worker.worktree_path, ['rev-parse', 'HEAD']);
    const agent = args.agent || worker.agent || resolveAgentId(args);
    updateBacklogState(taskId, () => ({
      worker: {
        ...worker,
        head_commit: head || worker.head_commit,
        last_verified_at: nowISO(),
        last_verified_commit: head || null,
        last_verified_passed: passed,
      },
      updated_at: nowISO(),
    }), { agent });
    const payload = {
      schema: 'agent-playbook.worker-verify.v1',
      task_id: taskId,
      agent,
      worktree: worker.worktree_path,
      commit: head,
      passed,
      checks: checkResults,
      commands: commandResults,
      honor_only: checks.length === 0,
    };
    if (args.json) return printJson(payload);
    if (checks.length || commands.length) printCheckResults([...commandResults, ...checkResults]);
    if (!checks.length && !commands.length) console.log(`[${taskId}] has no acceptance_checks — verification is honor-only.`);
    console.log(passed ? `[${taskId}] worker verify PASSED at ${head || '(unknown commit)'}` : `[${taskId}] worker verify FAILED at ${head || '(unknown commit)'}`);
    if (!passed) process.exit(1);
    return;
  }
  if (sub === 'remove') {
    const taskId = args._[1];
    if (!taskId) { console.error('Usage: pb worker remove <task-id> [--agent <agent>] [--delete-branch] [--force] [--execute] [--json]'); process.exit(1); }
    if (!backlogTasks().some((t) => t.id === taskId)) { console.error(`Task not found: ${taskId}`); process.exit(1); }
    const worker = taskState(taskId).worker || null;
    const agent = args.agent || worker?.agent || resolveAgentId(args);
    const payload = workerRemovePayload(taskId, agent, worker, {
      execute: !!args.execute, force: !!args.force, deleteBranch: !!args['delete-branch'],
    });
    if (args.execute) {
      // Unlink first, delete second. git's own recursive delete follows a junction
      // (measured), so the tree must contain no link by the time it runs. A refusal
      // here leaves the worktree intact on purpose: that is recoverable.
      if (existsSync(payload.worktree)) {
        let rootStat = null;
        try { rootStat = lstatSync(payload.worktree); } catch { rootStat = null; }
        if (rootStat && isLinkLike(payload.worktree, rootStat)) {
          console.error(`\nRefusing to remove the worker worktree for [${taskId}]: the worktree path ITSELF is a link.`);
          console.error(`  ! ${payload.worktree}`);
          console.error('    Deleting it would either destroy its target or leave git\'s worktree bookkeeping inconsistent.');
          console.error('    Unlink it by hand (Windows: `cmd /c rmdir "<path>"`), then re-run.');
          process.exit(1);
        }
        const { removed, failed } = unlinkTreeLinks(payload.worktree);
        if (failed.length) {
          console.error(`\nRefusing to remove the worker worktree for [${taskId}]: ${failed.length} link(s) inside it could not be unlinked.`);
          for (const f of failed) console.error(`  ! ${f.path} (${f.error}) — a recursive delete would follow it into its target.`);
          console.error('Nothing was deleted. Remove those links by hand (Windows: `cmd /c rmdir "<path>"`), then re-run.');
          process.exit(1);
        }
        if (removed.length) {
          console.log(`Unlinked ${removed.length} link(s) without following them: ${removed.map((r) => r.path).join(', ')}`);
        }
      }
      try {
        runGit(['worktree', 'remove', ...(args.force ? ['--force'] : []), payload.worktree]);
        if (args['delete-branch']) runGit(['branch', '-D', payload.branch]);
      } catch {
        console.error(`\nFailed to remove the worker worktree for [${taskId}] (see git output above).`);
        console.error('Uncommitted work in the worktree? Re-run with --force to discard it.');
        process.exit(1);
      }
      updateBacklogState(taskId, () => ({
        worker: { ...(worker || {}), agent, branch: payload.branch, worktree_path: payload.worktree, status: 'removed', removed_at: nowISO() },
        updated_at: nowISO(),
      }), { agent });
    }
    if (args.json) return printJson(payload);
    console.log(payload.execute ? `[exec] ${payload.command}` : `[dry-run] ${payload.command}`);
    return;
  }
  if (sub === 'checker') {
    const taskId = args._[1];
    const verdict = args.verdict;
    if (!taskId || !['pass', 'risk', 'block'].includes(verdict)) {
      console.error('Usage: pb worker checker <task-id> --verdict pass|risk|block [--notes "..."]');
      process.exit(1);
    }
    if (!backlogTasks().some((t) => t.id === taskId)) { console.error(`Task not found: ${taskId}`); process.exit(1); }
    const checker = { verdict, notes: args.notes || null, recorded_at: nowISO(), agent: resolveAgentId(args) };
    const checkerCommit = commitIteration(
      taskId,
      { ts: checker.recorded_at, loop_id: activeLoop()?.id || 'legacy', task: taskId, agent: checker.agent, agent_id: checker.agent, action: 'checker', status: verdict, checks: 'none', result: verdict, files: [], notes: checker.notes },
      () => ({ checker, updated_at: checker.recorded_at }),
      { agent: checker.agent },
    );
    if (!checkerCommit) process.exit(1);
    console.log(`Checker [${taskId}] → ${verdict} (seq ${checkerCommit.seq})`);
    return;
  }
  if (sub === 'merge') {
    const taskId = args._[1];
    if (!taskId) { console.error('Usage: pb worker merge <task-id> [--agent <agent>] [--execute] [--json]'); process.exit(1); }
    const task = backlogTasks().find((t) => t.id === taskId);
    if (!task) { console.error(`Task not found: ${taskId}`); process.exit(1); }
    const worker = taskState(taskId).worker || null;
    const agent = args.agent || worker?.agent || resolveAgentId(args);
    const derived = workerNames(taskId, agent);
    const branch = worker?.branch || derived.branch;
    const payload = {
      schema: 'agent-playbook.worker.v1',
      action: 'merge',
      task_id: taskId,
      agent,
      branch,
      command: `git merge --no-ff '${commandQuote(branch)}'`,
      execute: !!args.execute,
    };
    // The merge is gated, never free: an ungated merge is how unfinished work
    // reaches the trunk. Dry-run reports readiness; --execute refuses outright.
    const gate = mergeReadyPayload(task);
    payload.merge_ready = gate.ready;
    payload.reasons = gate.reasons;
    payload.warnings = gate.warnings;
    if (!gate.ready) {
      if (args.json) printJson(payload);
      else {
        console.error(`[${taskId}] NOT merge-ready — refusing to merge "${branch}":`);
        for (const r of gate.reasons) console.error(`  ! ${r}`);
        for (const w of gate.warnings) console.error(`  ⚠ ${w}`);
      }
      process.exit(1);
    }
    if (!args.execute) {
      if (args.json) printJson(payload);
      else console.log(`[dry-run] ${payload.command}`);
      return;
    }
    try {
      // --quiet for the same reason as `worktree add`: git writes its merge summary
      // to STDOUT, which lands in the middle of a `--json` payload.
      runGit(['merge', '--quiet', '--no-ff', '-m', `merge ${branch} (pb worker merge ${taskId})`, branch]);
    } catch {
      console.error(`\nMerge of "${branch}" failed (see git output above). The checkout may be mid-conflict.`);
      console.error('Resolve it, or abort with: git merge --abort');
      process.exit(1);
    }
    const head = gitIn(ROOT, ['rev-parse', 'HEAD']);
    const mergedAt = nowISO();
    const workerRecord = { ...(worker || {}), agent, branch, merged_at: mergedAt, merged_by: agent, merge_commit: head, status: 'merged' };
    // The merge now commits through commitIteration — the same one-transaction path
    // `worker checker` and `record` use — instead of patching the projection alone.
    // Before this, merge-back was the ONE fact the append-only journal did not carry,
    // so `repair-state --strict` (which rebuilds from the journal) silently dropped it:
    // an unproven merge. The row carries the worker record it committed, and the replay
    // below models that record, so the merge survives a strict rebuild.
    // `status: 'merged'` is deliberately not a task status: a merge is an event, and a
    // row whose status were `done` would be picked up by `lastDoneEntry` as the latest
    // completion record, poisoning the very merge gate that allowed it.
    const claimState = taskState(taskId);
    const mergeOwnership = verifyTaskClaim(taskId, args);
    const mergeCommit = commitIteration(taskId, {
      ts: mergedAt,
      loop_id: activeLoop()?.id || 'legacy',
      task: taskId,
      agent,
      agent_id: agent,
      claimed_by: claimState.claimed_by || agent,
      mode: claimState.mode || resolveModeId() || undefined,
      ownership: mergeOwnership.status,
      agent_chain: mergeOwnership.chain || undefined,
      action: 'merge',
      status: 'merged',
      checks: 'none',
      result: head,
      files: [],
      notes: `merged ${branch} into the root checkout at ${head}`,
      worker: workerRecord,
    }, () => ({ worker: workerRecord, updated_at: mergedAt }), { agent });
    if (!mergeCommit) process.exit(1);
    if (args.json) {
      printJson({ ...payload, merge_commit: head, journal_seq: mergeCommit.seq });
      return;
    }
    console.log(`Merged "${branch}" into the root checkout at ${head}.`);
    console.log(`Tear the slot down with: pb worker remove ${taskId} --agent ${agent} --delete-branch --execute`);
    return;
  }
  if (sub === 'merge-ready') {
    const taskId = args._[1];
    const task = backlogTasks().find((t) => t.id === taskId);
    if (!task) { console.error(`Task not found: ${taskId}`); process.exit(1); }
    const payload = mergeReadyPayload(task);
    if (args.json) {
      printJson(payload);
    } else {
      console.log(payload.ready ? `[${taskId}] merge-ready` : `[${taskId}] not merge-ready: ${payload.reasons.join('; ')}`);
      for (const w of payload.warnings) console.log(`  ⚠ ${w}`);
    }
    // Exit code is the gate: `pb worker merge-ready <id> && git merge ...`
    if (!payload.ready) process.exit(1);
    return;
  }
  if (sub === 'provider-rate-limit') {
    const taskId = args._[1];
    if (!taskId || !args.provider) { console.error('Usage: pb worker provider-rate-limit <task-id> --provider <name> [--retry-after 5h]'); process.exit(1); }
    if (!backlogTasks().some((t) => t.id === taskId)) { console.error(`Task not found: ${taskId}`); process.exit(1); }
    const provider = { name: args.provider, status: 'rate_limited', retry_after: args['retry-after'] || '5h', recorded_at: nowISO() };
    const providerAgent = resolveAgentId(args);
    const providerCommit = commitIteration(
      taskId,
      { ts: provider.recorded_at, loop_id: activeLoop()?.id || 'legacy', task: taskId, agent: providerAgent, agent_id: providerAgent, action: 'provider_rate_limit', status: 'blocked', checks: 'none', result: 'rate_limited', files: [], notes: `${provider.name} retry_after=${provider.retry_after}` },
      () => ({ provider, updated_at: provider.recorded_at }),
      { agent: providerAgent },
    );
    if (!providerCommit) process.exit(1);
    console.log(`Provider ${provider.name} for [${taskId}] rate_limited; retry_after=${provider.retry_after}`);
    return;
  }
  console.error('Usage: pb worker create|status|exec|verify|remove|checker|merge-ready|merge|provider-rate-limit ...');
  process.exit(1);
}

// ============================================================================
//  status — the "where am I" orient snapshot
// ============================================================================
function cmdStatus(args = {}) {
  if (args.json) return printJson(statusPayload());
  const tasks = backlogTasks();
  const journal = readJournal();

  console.log(`\n  ${master?.name || 'playbook'} v${master?.version || '?'} — ${(master?.description || '').trim().split('\n')[0]}`);
  console.log('  ' + '-'.repeat(68));

  const counts = Object.fromEntries(ALLOWED_STATUSES.map((s) => [s, 0]));
  for (const t of tasks) if (counts[t.status] !== undefined) counts[t.status]++;
  console.log('  Backlog: ' + ALLOWED_STATUSES.map((s) => `${counts[s]} ${s}`).join('  •  '));
  const loop = activeLoop();
  const highLessons = openLessons().filter((l) => l.severity === 'high').length;
  console.log(`  Loop:    ${loop ? `${loop.id} active` : '(none active)'}  •  ${highLessons} high-severity lesson(s) open`);

  const next = tasks.filter((t) => t.status === 'todo').sort((a, b) => prio(a) - prio(b))[0];
  if (next) console.log(`  Next up: [${next.id}] ${next.title}  → skill: ${next.skill || '(none)'}`);
  const wip = tasks.filter((t) => t.status === 'in_progress');
  if (wip.length) console.log(`  In progress: ${wip.map((t) => `[${t.id}] ${t.title}`).join('; ')}`);

  const tail = journal.slice(-5);
  console.log('  ' + '-'.repeat(68));
  if (tail.length) {
    console.log('  Recent journal:');
    for (const e of tail) {
      console.log(`    ${e.ts?.slice(0, 19) || '?'}  [${e.task || '-'}] ${e.action || '?'} → ${e.status || '?'}`);
    }
  } else {
    console.log('  Journal is empty — nothing recorded yet.');
  }

  const failures = runValidate();
  console.log('  ' + '-'.repeat(68));
  console.log(failures.length ? `  Guardrails: FAIL (${failures.length}) — run \`pb validate\`` : '  Guardrails: green');
  console.log('');
}

// ============================================================================
//  next — select the next task (and optionally claim it)
// ============================================================================
function cmdNext(args) {
  const tasks = backlogTasks();
  // mode routing: an agent of mode M claims only tasks tagged mode M, plus
  // UNTAGGED tasks (claimable by any mode, so the common case is never starved).
  // The claiming mode is `--mode <id>` if given (lets pooled agents self-specify),
  // else the resolved mode (loop.mode ?? default_mode).
  const agentMode = (typeof args.mode === 'string' && args.mode.trim()) ? args.mode.trim() : resolveModeId();
  const matchesMode = (t) => {
    const tm = (t.mode && String(t.mode).trim()) || null;
    return !tm || !agentMode || tm === agentMode;
  };
  const todo = tasks.filter((t) => t.status === 'todo');
  // Layered planning gates the CLAIM, on the same path `dependencies` already gates:
  // a task whose layer sits above a failing (or unverified) gate is not claimable.
  // The playbook's declared layer order is the plan, so honoring it by default is the
  // point. `--force` remains the explicit, RECORDED escape hatch for a one-off
  // override; there is no configuration switch that silently relaxes the partition,
  // because the partition is the claim the plan is making.
  const layerPlan = computeLayerPlan({ checkGates: true, allTasks: tasks });
  const openGateBlockers = (t) => gateBlockersFor(layerPlan, t);
  const claimable = todo.filter((t) => matchesMode(t) && unmetDeps(t, tasks).length === 0 && !openGateBlockers(t).length);
  const candidate = claimable.sort((a, b) => prio(a) - prio(b))[0];

  if (!candidate) {
    if (!todo.length) {
      console.log(`No actionable tasks (nothing in "todo"). Add one to ${BACKLOG}.`);
      return;
    }
    // distinguish "nothing for my mode" from "blocked by deps".
    const todoForMode = todo.filter(matchesMode);
    if (!todoForMode.length) {
      console.log(`No todo tasks match mode "${agentMode || '(none)'}". ${todo.length} task(s) are tagged for other modes.`);
      for (const t of todo) console.log(`  [${t.id}] mode: ${(t.mode && String(t.mode).trim()) || '(untagged)'}`);
      return;
    }
    console.log('No claimable todo tasks. Blockers:');
    for (const t of todoForMode) {
      const deps = unmetDeps(t, tasks);
      if (deps.length) console.log(`  [${t.id}] waiting on: ${deps.join(', ')}`);
      for (const g of openGateBlockers(t)) {
        const why = g.evaluated ? 'gate FAILING' : 'gate not verified — run `pb plan --layers --check-gates`';
        console.log(`  [${t.id}] layer ${t.layer || '?'} held by layer ${g.layer}: ${why}`);
        if (g.output) for (const l of g.output.split(/\r?\n/)) console.log(`        ${l}`);
      }
    }
    return;
  }

  const sk = candidate.skill ? skillForMode(candidate.skill, candidate.mode) : null;
  console.log(`\n  Next task: [${candidate.id}] ${candidate.title}`);
  console.log(`  Priority:  ${prio(candidate)}`);
  if (candidate.notes) console.log(`  Notes:     ${candidate.notes}`);
  console.log(`  Skill:     ${candidate.skill || '(none — improvise, then write one)'}`);
  if (sk) {
    console.log(`    → open:    ${sk.file}`);
    if (sk.process) console.log(`    → process: ${sk.process}`);
  }
  const checks = taskChecks(candidate);
  if (checks.length) {
    console.log(`  Done means (these must exit 0):`);
    for (const c of checks) console.log(`    $ ${c}`);
  } else {
    console.log(`  Checks:    none — "done" is on your honor. Add acceptance_checks if possible.`);
  }

  if (args.claim) {
    const loop = activeLoop();
    const journal = readJournal().filter((e) => !e.__malformed);
    const blockers = [];
    if (!loop) blockers.push('No active loop — run `pb loop new` before claiming work.');
    // one-in-progress is PER AGENT, not global: N agents share one backlog, so a
    // task held by ANOTHER agent must not block this agent. Attribution falls back
    // to the default agent id, so legacy/unstamped in_progress still blocks `agent`.
    const agent = resolveAgentId(args);
    const myWip = tasks.find((t) => t.status === 'in_progress' && taskHolder(t) === agent);
    if (myWip) blockers.push(`You (agent ${agent}) already hold [${myWip.id}] in_progress. Finish or release it before claiming another.`);
    // (The cycle-brief / phase blockers below stay SHARED on purpose — all agents
    // work one phase; they are set per-phase and don't serialize concurrent agents.)
    blockers.push(...cycleBlockers(journal));
    if (blockers.length && !args.force) {
      console.log(`\n  Refusing to claim [${candidate.id}] — phase-loop guardrail gap:`);
      for (const b of blockers) console.log(`    ! ${b}`);
      console.log('  Fix these, then re-run `pb next --claim` (or override with --force, not recommended).');
      console.log('');
      process.exit(1);
    }
    // resolve the mode for THIS candidate (it isn't in_progress yet, so resolve directly):
    // task.mode ?? loop.mode ?? default_mode.
    const claimMode = (candidate.mode && String(candidate.mode).trim()) || (loop && loop.mode) || DEFAULT_MODE || undefined;
    // ATOMIC claim: the candidate was chosen BEFORE the lock, so the whole claim —
    // re-verify it is still todo, stamp the holder, and append the claim row —
    // happens inside ONE state transaction. The previous version took the state
    // lock here and then called the (also-locking) state writer, which self-
    // deadlocked: the inner acquisition burned its whole timeout, the outer write
    // happened anyway, and the command stalled ~30s while reporting success.
    let claimed = false;
    const claimToken = newClaimToken();
    const claimRow = {
      ts: nowISO(),
      loop_id: loop.id,
      task: candidate.id,
      agent,
      agent_id: agent,
      claimed_by: agent,
      mode: claimMode,
      action: 'claim',
      status: 'in_progress',
      checks: 'none',
      result: null,
      files: [],
      notes: `claimed by ${agent}`,
    };
    try {
      withStateTxn((draft, ctx) => {
        ctx.draft = draft;
        const fresh = backlogTasks().find((t) => t.id === candidate.id);
        if (!fresh || fresh.status !== 'todo') return;
        applyTaskMutation(candidate.id, () => ({
          status: 'in_progress',
          claimed_at: claimRow.ts,
          loop_id: loop.id,
          claimed_by: agent,
          agent_id: agent,
          claim_token: claimToken,
          claim_token_issued_at: claimRow.ts,
          mode: claimMode,
        }), ctx, agent);
        appendJournal({ ...claimRow, seq: ctx.seq });
        claimed = true;
      }, { agent });
    } catch (e) {
      if (!(e instanceof StateTxnBusy)) throw e;
      console.error('\n  Could not acquire the state lock (another agent is writing). Re-run `pb next --claim`.');
      process.exit(1);
    }
    if (!claimed) {
      console.error(`\n  [${candidate.id}] was claimed by another agent while you were selecting. Re-run \`pb next --claim\` for the next task.`);
      process.exit(1);
    }
    console.log(`\n  Claimed [${candidate.id}] → in_progress  (agent: ${agent}, mode: ${claimMode || 'none'}).`);
    console.log(`  Claim token: ${claimToken}`);
    console.log('    Pass it to a sub-agent as PB_CLAIM_TOKEN so it can record on your behalf,');
    console.log('    or set PB_AGENT_CHAIN=<you>,<sub> for delegation-chain ownership.');
    if (loop) console.log(`  Loop: ${loop.id}`);
    if (blockers.length) console.log(`  WARNING: claimed with --force despite ${blockers.length} guardrail gap(s).`);
    console.log(`  Next: do the work via the skill, then \`pb record --task ${candidate.id} ...\`.`);
  } else {
    console.log(`\n  Run with --claim to mark it in_progress.`);
  }
  console.log('');
}

// release — give a contested/abandoned task back to the pool. This is the missing
// half of a claim: without it a crashed or deprioritised holder pins a task as
// in_progress forever (`--force` on someone else's claim was the only escape).
// Ownership is enforced the same way as a write: holder, token, or delegation
// chain. `pb release --stale <minutes>` sweeps claims whose holder went away.
function cmdRelease(args) {
  const taskId = args.task || args._[0];
  const staleMinutes = args.stale ? Number(args.stale) : null;
  if (!taskId && !staleMinutes) {
    console.error('Usage: pb release --task <id> [--agent <id>] [--token <claim-token>] [--reason "..."]');
    console.error('       pb release --stale <minutes> [--dry-run]   # release claims older than N minutes');
    process.exit(1);
  }
  const agent = resolveAgentId(args);
  const releaseRow = (id, holder, token, reason) => ({
    ts: nowISO(),
    loop_id: activeLoop()?.id || 'legacy',
    task: id,
    agent,
    agent_id: agent,
    claimed_by: holder,
    action: 'release',
    status: 'todo',
    checks: 'none',
    result: null,
    files: [],
    notes: reason || `released by ${agent}`,
    released_token: token || undefined,
  });

  if (staleMinutes) {
    const cutoff = Date.now() - staleMinutes * 60_000;
    const stale = backlogTasks().filter((t) => t.status === 'in_progress' && (t.claimed_at ? Date.parse(t.claimed_at) < cutoff : true));
    if (!stale.length) { console.log(`No in_progress claims older than ${staleMinutes} minute(s).`); return; }
    if (args['dry-run']) {
      for (const t of stale) console.log(`[dry-run] would release [${t.id}] (held by ${taskHolder(t)} since ${t.claimed_at || 'unknown'})`);
      return;
    }
    let released = 0;
    for (const t of stale) {
      const holder = taskHolder(t);
      const entry = readBacklogState()[t.id] || {};
      const commit = commitIteration(t.id, releaseRow(t.id, holder, entry.claim_token, `stale claim (>${staleMinutes}m) swept by ${agent}`),
        () => ({ status: 'todo', __unset: ['claimed_by', 'agent_id', 'claim_token', 'claim_token_issued_at', 'claimed_at'], released_at: nowISO(), released_by: agent }),
        { agent });
      if (commit) released++;
    }
    console.log(`Released ${released} stale claim(s) (>${staleMinutes} minute(s) old).`);
    return;
  }

  const task = backlogTasks().find((t) => t.id === taskId);
  if (!task) { console.error(`Task not found: ${taskId}`); process.exit(1); }
  if (task.status !== 'in_progress') {
    console.log(`[${taskId}] is "${task.status}", not in_progress — nothing to release.`);
    return;
  }
  const ownership = verifyTaskClaim(taskId, args);
  if (!ownership.ok && !args.force) {
    console.error(`Refusing to release [${taskId}] — it is held by "${ownership.holder}", and this writer cannot prove ownership.`);
    console.error('Pass --token <claim-token>, set PB_AGENT_CHAIN, or use --force (recorded on the journal row).');
    process.exit(1);
  }
  const holder = ownership.holder || taskHolder(task);
  const claimRecord = readBacklogState()[taskId] || {};
  const commit = commitIteration(taskId, releaseRow(taskId, holder, claimRecord.claim_token, args.notes || (args.force ? `force-released by ${agent}` : undefined)),
    () => ({ status: 'todo', __unset: ['claimed_by', 'agent_id', 'claim_token', 'claim_token_issued_at', 'claimed_at'], released_at: nowISO(), released_by: agent }),
    { agent });
  if (!commit) process.exit(1);
  console.log(`Released [${taskId}] → todo (was held by ${holder}${ownership.ok ? '' : ', FORCED'}).`);
}

// unlock — clear a leaked lock. The age-based stale break is deliberately
// conservative (a lock broken too early loses data), so a holder killed at the
// wrong moment can leave a lock that outlives its stale window. This is the
// explicit, human-authorized escape hatch: it reports the holder first and only
// removes on --force, so it cannot be used to bulldoze an active writer by accident.
function cmdUnlock(args) {
  const locks = [
    { label: 'state', path: p(STATE_LOCK) },
    { label: 'worker', path: p(WORKER_LOCK) },
  ];
  let found = 0;
  for (const lock of locks) {
    if (!existsSync(lock.path)) continue;
    found++;
    let holder = {};
    try { holder = JSON.parse(readText(lock.path) || '{}'); } catch { /* unreadable */ }
    const ageMs = (() => { try { return Date.now() - statSync(lock.path).mtimeMs; } catch { return null; } })();
    console.log(`[${lock.label} lock] ${lock.path}`);
    console.log(`  holder: pid=${holder.pid ?? '?'} token=${holder.token ?? '?'} since=${holder.ts ?? '?'} age=${ageMs === null ? '?' : `${Math.round(ageMs / 1000)}s`}`);
    let holderRunning = null;
    try { if (typeof holder.pid === 'number') { process.kill(holder.pid, 0); holderRunning = true; } } catch { holderRunning = false; }
    if (holderRunning) {
      console.error(`  ⚠ pid ${holder.pid} still appears to be RUNNING — clearing this lock could corrupt a live write.`);
    }
    if (args.force) {
      rmSync(lock.path, { force: true });
      console.log('  cleared.');
    } else {
      console.log('  (dry run — re-run with --force to clear)');
    }
  }
  if (!found) console.log('No locks held.');
  else if (!args.force) console.log('\nRe-run `pb unlock --force` to clear the locks listed above.');
}

// --- state repair (crash recovery) -------------------------------------------
// The journal is the append-only record of what happened, in order; backlog-state.json
// is a projection of it. That ordering is what makes recovery possible: if a state
// write was lost (a crash between the append and the state commit, a truncated file,
// a killed process), the journal still holds the facts and the projection can be
// rebuilt. Replay rules, in journal order:
//   claim                → in_progress, holder/loop/mode/token from the row
//   done | blocked       → terminal status
//   release              → back to todo with the claim cleared
//   anything else        → loop-liveness only (progress, checker, provider, …)
// Fields a journal row cannot carry (the worker record, a checker verdict, a
// provider cooldown) are PRESERVED from the existing projection rather than dropped —
// silently deleting state that the journal does not model would be a data loss
// dressed up as a repair. `--strict` opts into dropping them.
const TERMINAL_ROW_STATUSES = new Set(['done', 'blocked']);
const CLAIM_CLEAR_FIELDS = ['claimed_by', 'agent_id', 'claim_token', 'claim_token_issued_at', 'claimed_at'];
function reconstructStateFromJournal({ strict = false, ids = null } = {}) {
  const journal = readJournal().filter((e) => !e.__malformed);
  // Order by the monotonic seq where present; rows without one predate ordering and
  // keep their file position (a stable sort preserves append order for them).
  const ordered = journal
    .map((e, i) => ({ e, i }))
    .sort((a, b) => {
      const sa = typeof a.e.seq === 'number' ? a.e.seq : null;
      const sb = typeof b.e.seq === 'number' ? b.e.seq : null;
      if (sa === null && sb === null) return a.i - b.i;
      if (sa === null) return -1;
      if (sb === null) return 1;
      return sa - sb || a.i - b.i;
    })
    .map((x) => x.e);

  const rebuilt = {};
  let applied = 0;
  const inScope = ids ? new Set(ids) : null;
  for (const row of ordered) {
    const id = row.task;
    if (!id || id === 'reflect' || typeof id !== 'string') continue;
    // Scope: the projection describes the CURRENT backlog, so replaying a task that
    // has since left the backlog would resurrect dead state (an old loop's tasks are
    // history in the journal, not entries in today's queue).
    if (inScope && !inScope.has(id)) continue;
    const entry = rebuilt[id] || (rebuilt[id] = {});
    const ts = row.ts || null;
    // loop_id is stamped on every row: the most recent one describes where the task
    // last belonged, which is what the projection stores.
    if (row.loop_id && row.loop_id !== 'legacy') entry.loop_id = row.loop_id;
    if (row.mode) entry.mode = row.mode;
    // A row that carries the worker record it committed (the merge row does) is
    // replayed as that record. Without this the journal could hold the merge and the
    // strict rebuild would still drop it as "projection-only" — a fact recorded but
    // not replayable, which is the same as not recorded.
    if (row.worker && typeof row.worker === 'object') entry.worker = { ...(entry.worker || {}), ...row.worker };
    if (row.action === 'claim') {
      entry.status = 'in_progress';
      entry.claimed_at = ts;
      entry.claimed_by = row.claimed_by || row.agent || row.agent_id;
      entry.agent_id = row.agent_id || row.claimed_by || row.agent;
      if (row.claim_token) entry.claim_token = row.claim_token;
      if (row.claim_token_issued_at) entry.claim_token_issued_at = row.claim_token_issued_at;
      entry.updated_at = ts;
      applied++;
      continue;
    }
    // TERMINAL FIRST, action second. A row can carry both a lifecycle action and a
    // terminal status — `pb record --action release --status blocked` is exactly that,
    // and it is how a blocked task ends its iteration. Reading the action first
    // replayed such a row as `todo`, so a task the journal plainly records as blocked
    // came back as unclaimed work and `pb repair-state --check` reported drift on a
    // healthy playbook (then offered a "repair" that resurrected finished work).
    // A terminal status is the stronger, less recoverable fact: when the two
    // disagree, the terminal one wins.
    if (TERMINAL_ROW_STATUSES.has(row.status)) {
      entry.status = row.status;
      entry.updated_at = ts;
      applied++;
      continue;
    }
    if (row.action === 'release') {
      entry.status = 'todo';
      for (const f of CLAIM_CLEAR_FIELDS) delete entry[f];
      entry.released_at = ts;
      entry.released_by = row.agent || row.agent_id;
      entry.updated_at = ts;
      applied++;
      continue;
    }
    // Non-terminal activity: it moves the "last touched" clock but not the status.
    if (ts) entry.updated_at = ts;
  }

  // `updated_by` is the writer of the winning row for that task.
  for (const id of Object.keys(rebuilt)) {
    const winner = ordered.filter((r) => r.task === id && typeof r.seq === 'number')
      .reduce((a, b) => (!a || b.seq > a.seq ? b : a), null);
    if (winner) rebuilt[id].updated_by = winner.agent || winner.agent_id;
  }

  // Preserve projection-only fields the journal does not model.
  const current = readBacklogState();
  const preserved = {};
  if (!strict) {
    for (const [taskId, cur] of Object.entries(current)) {
      if (taskId.startsWith('__')) continue;
      const extra = {};
      for (const key of ['worker', 'checker', 'provider', 'gate', 'ledger']) {
        if (cur[key] !== undefined) extra[key] = cur[key];
      }
      if (Object.keys(extra).length) {
        rebuilt[taskId] = { ...extra, ...(rebuilt[taskId] || {}) };
        preserved[taskId] = Object.keys(extra);
      }
    }
  }

  // Ordering metadata: keep the highest sequence the records can justify, and never
  // move it backwards past a `seq` that already exists in the projection.
  const maxRowSeq = ordered.reduce((m, r) => (typeof r.seq === 'number' && r.seq > m ? r.seq : m), 0);
  const currentSeq = touchSeqOf(current);
  const next = { ...rebuilt, __seq: Math.max(maxRowSeq, currentSeq) };
  next.__journal_seq = maxRowSeq || current.__journal_seq;
  next.__written_at = nowISO();
  next.__written_by = 'repair-state';

  return { rebuilt, next, applied, preserved, maxRowSeq, currentSeq, journalRows: ordered.length };
}
// Compare the projection against what the journal implies. This is the alarm that
// turns silent divergence (the exact failure mode of a lost update) into a report.
// Scoped to the CURRENT backlog: a task the journal mentions but the backlog no
// longer carries is history, not drift.
function stateDriftReport() {
  const backlogIds = backlogTasks().map((t) => t.id);
  const backlogSet = new Set(backlogIds);
  const { rebuilt, maxRowSeq, currentSeq } = reconstructStateFromJournal({ strict: true, ids: backlogIds });
  const current = readBacklogState();
  const drift = [];
  for (const id of backlogIds) {
    const want = rebuilt[id];
    const have = current[id]?.status ?? null;
    if (!want) {
      // A backlog task with no journal history at all is normal for a fresh todo.
      if (have && have !== 'todo') drift.push({ task: id, field: 'status', state: have, journal: null, kind: 'state-only' });
      continue;
    }
    if (have !== (want.status ?? null)) {
      drift.push({ task: id, field: 'status', state: have, journal: want.status ?? null, kind: 'mismatch' });
    }
  }
  // A journal ahead of the projection means a state write was lost: the records
  // committed, the projection did not.
  return {
    schema: 'agent-playbook.state-drift.v1',
    drift,
    state_seq: currentSeq,
    journal_max_seq: maxRowSeq,
    lost_state_write: maxRowSeq > currentSeq,
    backlog_ids: [...backlogSet],
  };
}
// repair-state — check or rebuild the projection from the journal.
function cmdRepairState(args) {
  const backlogIds = backlogTasks().map((t) => t.id);
  const report = stateDriftReport();
  const { next, rebuilt } = reconstructStateFromJournal({ strict: !!args.strict, ids: backlogIds });
  const payload = {
    schema: 'agent-playbook.repair-state.v1',
    apply: !!args.apply,
    strict: !!args.strict,
    state_seq: report.state_seq,
    journal_max_seq: report.journal_max_seq,
    lost_state_write: report.lost_state_write,
    drift: report.drift,
    tasks_in_backlog: backlogIds.length,
    tasks_in_journal: Object.keys(rebuilt).length,
    tasks_in_state: Object.keys(readBacklogState()).filter((k) => !k.startsWith('__')).length,
  };
  if (args.check) {
    if (args.json) printJson(payload);
    else {
      console.log(`state seq ${report.state_seq} · journal max seq ${report.journal_max_seq}`);
      if (report.lost_state_write) console.log('  ⚠ the journal is AHEAD of the projection — a state write was lost.');
      if (!report.drift.length) console.log('No drift: the projection agrees with the journal.');
      else {
        console.log(`Drift in ${report.drift.length} task(s):`);
        for (const d of report.drift) console.log(`  [${d.task}] ${d.field}: state=${d.state ?? '(absent)'} journal=${d.journal ?? '(absent)'} (${d.kind})`);
        console.log('\nRun `pb repair-state --apply` to rebuild the projection from the journal.');
      }
    }
    // A check is a gate: drift is a non-zero exit so it can be wired into CI.
    if (!args.json && (report.drift.length || report.lost_state_write)) process.exit(1);
    return;
  }
  if (!args.apply) {
    if (args.json) return printJson({ ...payload, dry_run: true });
    console.log(`Would rebuild ${Object.keys(rebuilt).length} task state(s) from ${report.journal_max_seq} journal record(s).`);
    if (report.drift.length) {
      console.log(`Drift to repair: ${report.drift.length} task(s).`);
      for (const d of report.drift.slice(0, 20)) console.log(`  [${d.task}] ${d.field}: state=${d.state ?? '(absent)'} → journal=${d.journal ?? '(absent)'}`);
    } else console.log('No drift — a rebuild would be a no-op.');
    console.log('\nDry run. Re-run with --apply to write the rebuilt projection.');
    return;
  }
  try {
    withStateTxn((draft) => {
      for (const key of Object.keys(draft)) delete draft[key];
      for (const [k, v] of Object.entries(next)) draft[k] = v;
    }, { agent: 'repair-state' });
  } catch (e) {
    console.error(`Could not rebuild the projection: ${e.message}`);
    process.exit(1);
  }
  if (args.json) return printJson({ ...payload, applied: true, tasks_written: Object.keys(rebuilt).length });
  console.log(`Rebuilt the projection from ${report.journal_max_seq} journal record(s): ${Object.keys(rebuilt).length} task state(s) written.`);
  if (report.drift.length) {
    for (const d of report.drift.slice(0, 20)) console.log(`  [${d.task}] ${d.field}: ${d.state ?? '(absent)'} → ${d.journal ?? '(absent)'}`);
  }
}

function nextPlanId() {
  const prefix = `plan-${today().replace(/-/g, '')}`;
  const tasks = backlogTasks();
  const n = tasks.filter((t) => String(t.id || '').startsWith(prefix)).length + 1;
  return `${prefix}-${String(n).padStart(3, '0')}`;
}

// ============================================================================
//  plan — generate a backlog task from a goal. The agent (or human) refines the
//  acceptance_checks; the command only formalizes the goal into the backlog.
// ============================================================================
// One definition of what a dry run's exit code means, shared by the text renderer
// and `--json` so the two can never disagree about whether a plan is healthy:
//   2 = the plan is structurally invalid (a cycle, an unknown layer, a task declared
//       earlier than its dependencies) OR a checked layer gate is failing — the plan
//       is not actionable, so a script must not proceed on 0;
//   1 = the plan is sound but work remains, and --strict was asked to treat open work
//       as a failure;
//   0 = the plan is sound. `pb validate` is the structural gate for the repo; this is
//       the plan's own verdict, and open work alone is never an error.
function planVerdict(plan, { checkGates = false, strict = false } = {}) {
  if (!plan.structurally_valid) return 2;
  if (checkGates && Object.values(plan.gate_results).some((r) => !r.ok)) return 2;
  if (strict && plan.tasks.some((t) => t.status !== 'done')) return 1;
  return 0;
}

// `pb plan --layers` — the DRY RUN. Report the derived plan and stop: what layer a
// task lands in, which layers are held back by which gates, what is claimable right
// now, the order work would actually proceed in, and the critical path. It executes
// nothing and writes nothing (gate commands run only under --check-gates, and only
// after the caller has taken the snapshot it uses to prove nothing changed).
function renderPlanLayers(plan, { checkGates = false, strict = false } = {}) {
  const line = '─'.repeat(68);
  console.log(`\n  ${line}`);
  console.log(`  Layered plan${checkGates ? ' (gates checked)' : ' (gates NOT checked)'}`);
  console.log(`  ${line}`);
  const statusCount = (counts) => ['done', 'in_progress', 'blocked', 'todo']
    .filter((s) => counts[s]).map((s) => `${counts[s]} ${s}`).join(' · ') || 'no tasks';

  if (!plan.ordered) {
    console.log('  No `layers` declared in the master — the backlog is a flat queue.');
    console.log('  Declare them in playbook.yaml, then `pb plan --layers` becomes a plan:');
    console.log('    layers:');
    console.log('      - {id: L0, name: substrate, gate: "npm test"}');
    console.log('      - {id: L1, name: data}');
    console.log('');
  } else {
    for (const layer of plan.layers) {
      const held = [];
      const behind = plan.layers.filter((l) => l.position < layer.position && !l.counts.done);
      if (behind.length) held.push(`waiting on lower layer(s): ${behind.map((l) => l.id).join(', ')}`);
      const gateState = layer.gate
        ? (layer.gate_result ? (layer.gate_result.ok ? 'gate PASS' : (layer.human ? 'gate BLOCKED (human)' : 'gate FAIL')) : (checkGates ? 'gate ?' : 'gate unchecked'))
        : 'no gate';
      console.log(`\n  ${layer.id}${layer.name ? ` (${layer.name})` : ''} — ${statusCount(layer.counts)} · ${gateState}`);
      if (layer.gate) console.log(`      gate: $ ${layer.gate}`);
      if (layer.about) console.log(`      about: ${layer.about}`);
      if (layer.gate_result && !layer.gate_result.ok && layer.gate_result.output) {
        for (const l of layer.gate_result.output.split(/\r?\n/)) console.log(`      ${l}`);
      }
      if (!layer.tasks.length) console.log('      (no tasks declared in this layer)');
      for (const id of layer.tasks) console.log(`      [${id}]`);
      if (held.length) console.log(`      ${held.join('; ')}`);
      console.log(`      ready: ${layer.ready.length ? layer.ready.join(', ') : 'none'}`);
    }
    console.log('');
  }

  const open = plan.tasks.filter((t) => t.status !== 'done');
  console.log(`  ready now (claimable): ${plan.ready.length ? plan.ready.join(', ') : 'none'}`);
  if (plan.critical_path.head) {
    const tail = plan.critical_path.head;
    console.log(`  critical path: the longest open chain runs ${plan.critical_path.length} task(s) deep, through ${tail} — no shorter`);
    console.log(`                 sequence of claims can finish these ${plan.critical_path.open_tasks} open task(s).`);
  } else {
    console.log('  critical path: none — nothing is open.');
  }
  // Unlayered tasks are unconstrained in BOTH directions: no gate holds them back,
  // and they hold nothing back. That is the whole of the rule — there is deliberately
  // no knob to "relax the partition", because the partition IS the claim being made.
  // An earlier draft shipped a `layers_unlayered_loose` flag that was read and printed
  // but never consulted, so it advertised a fast lane that did not exist; a switch that
  // reports behavior it does not have is worse than no switch. `--force` (recorded on
  // the journal row) remains the explicit escape hatch for a one-off override.
  const unlayered = plan.tasks.filter((t) => t.unlayered);
  if (unlayered.length) {
    console.log(`  ${unlayered.length} task(s) declare no layer — no gate holds them back, and they hold nothing back.`);
  }

  if (plan.problems.length) {
    console.log(`\n  ${line}`);
    console.log(`  PLAN PROBLEMS (${plan.problems.length}) — these fail \`pb validate\`:`);
    for (const p of plan.problems) console.log(`    ${p.task ? `[${p.task}] ` : ''}${p.message}`);
  } else {
    console.log(`\n  Plan is structurally valid: ${plan.layers.length} layer(s), ${plan.tasks.length} task(s), no cycles.`);
  }

  const gateFailed = Object.entries(plan.gate_results).filter(([, r]) => !r.ok).map(([id]) => id);
  if (checkGates && gateFailed.length) {
    console.log(`  Gates FAILING: ${gateFailed.join(', ')} — every layer above them is blocked.`);
  }
  // The batch. A red gate on a `human: true` layer is a question, not a retry: collect
  // them all so ONE hand-off answers everything instead of the run stopping at the first.
  if (checkGates && (plan.waiting_on_human.length || plan.waiting_on_agent.length)) {
    if (plan.waiting_on_human.length) {
      console.log(`\n  ${line}`);
      console.log(`  WAITING ON A HUMAN (${plan.waiting_on_human.length}) — no agent retry turns these green:`);
      for (const w of plan.waiting_on_human) {
        console.log(`    · ${w.layer}${w.name ? ` (${w.name})` : ''}: ${w.blocked_tasks.length} task(s) blocked → ${w.blocked_tasks.join(', ') || 'none'}`);
        console.log(`      needs: $ ${w.gate}`);
      }
      console.log(`  Answer these in one pass, then re-run \`pb plan --layers --check-gates\`.`);
    }
    if (plan.waiting_on_agent.length) {
      console.log(`\n  BLOCKED ON AGENT WORK (${plan.waiting_on_agent.length}) — these gates go green when the layer below is finished:`);
      for (const w of plan.waiting_on_agent) {
        console.log(`    · ${w.layer}${w.name ? ` (${w.name})` : ''}: ${w.blocked_tasks.length} task(s) blocked → ${w.blocked_tasks.join(', ') || 'none'}`);
      }
    }
  }
  const verdict = planVerdict(plan, { checkGates, strict });
  console.log(`  ${line}`);
  console.log(`  exit ${verdict}: ${!plan.structurally_valid ? 'the plan is structurally invalid'
    : (checkGates && Object.values(plan.gate_results).some((r) => !r.ok)) ? 'a layer gate is failing'
      : (strict && open.length) ? `${open.length} task(s) still open`
        : 'plan is valid but has open work'}`);
  console.log(`  ${line}\n`);
  return verdict;
}

function cmdPlan(args) {
  // `--layers` is a DRY RUN of the whole plan, not a task generator: it reports the
  // derived layer graph and exits. It is unambiguous (no --goal), and it must be
  // able to run with no active loop and no cycle brief, because deciding whether the
  // plan is sound is exactly what you do BEFORE opening a phase.
  if (args.layers) {
    // Proof of read-only: fingerprint the files a dry run must never touch, then
    // compare after rendering. A dry run that mutates is the whole failure mode, so
    // it is asserted rather than promised.
    const guarded = [BACKLOG, BACKLOG_STATE, JOURNAL, p(CYCLE)].map((f) => {
      const abs = f.startsWith(ROOT) ? f : p(f);
      try { return { abs, before: existsSync(abs) ? statSync(abs).mtimeMs + ':' + statSync(abs).size : 'absent' }; }
      catch { return { abs, before: 'unreadable' }; }
    });
    const plan = computeLayerPlan({ checkGates: !!args['check-gates'] });
    const options = { checkGates: !!args['check-gates'], strict: !!args.strict };
    const verdict = args.json ? (printJson(plan), planVerdict(plan, options)) : renderPlanLayers(plan, options);
    const mutated = guarded.filter((g) => {
      try { return (existsSync(g.abs) ? statSync(g.abs).mtimeMs + ':' + statSync(g.abs).size : 'absent') !== g.before; }
      catch { return true; }
    });
    if (mutated.length) {
      console.error(`ERROR: the dry run MODIFIED ${mutated.map((m) => m.abs).join(', ')} — a dry run must not write. This is a bug.`);
      process.exit(3);
    }
    process.exit(verdict);
  }
  if (!args.goal) {
    console.error('Usage: pb plan --goal "..." [--skill <id>] [--priority <n>] [--check <cmd>] [--dep <task-id>] [--manual] [--layer <id>]');
    console.error('       pb plan --layers [--check-gates] [--strict] [--json]   # DRY RUN: report the layered plan, write nothing');
    console.error('Pass --check multiple times to add multiple acceptance checks.');
    console.error('Pass --dep multiple times to declare dependencies AT BIRTH: the order the claim path');
    console.error('enforces and the edges `pb graph` draws are fixed when the task is created, not later.');
    process.exit(1);
  }
  const loop = activeLoop();
  if (!loop) {
    console.error('No active loop. Start one with `pb loop new` before planning.');
    process.exit(1);
  }
  const journal = readJournal().filter((e) => !e.__malformed);
  const blockers = cycleBlockers(journal);
  if (blockers.length) {
    console.error('Refusing to plan — phase-loop guardrail gap:');
    for (const b of blockers) console.error(`  ! ${b}`);
    process.exit(1);
  }
  const skill = args.skill || 'run-task';
  const mode = resolveModeId();
  if (skill && !skillForMode(skill, mode)) {
    console.error(`Unknown skill: ${skill}`);
    process.exit(1);
  }
  const priority = Number(args.priority) || 1;
  const checksRaw = args.check || [];
  const checks = (Array.isArray(checksRaw) ? checksRaw : (checksRaw === true ? [] : [checksRaw]))
    .map((s) => String(s).trim()).filter(Boolean);
  // `--dep` at BIRTH. `dependencies:` already orders tasks and already gates the claim
  // path, but until now the only way to get an edge was to hand-edit `backlog.yaml`
  // after the fact — so every scaffolded task was born unlinked and the graph had
  // nothing to draw. Resolving the flag here fixes that at the source.
  //
  // Every refusal happens BEFORE anything is written. A task born with a broken edge is
  // worse than no task: `pb validate` would be red and `pb graph` would have an edge to
  // a card that does not exist.
  const knownIds = new Set(backlogTasks().map((t) => t.id));
  const depRaw = args.dep === undefined ? [] : (Array.isArray(args.dep) ? args.dep : [args.dep]);
  const depIds = [];
  const taskId = nextPlanId();
  for (const raw of depRaw) {
    const dep = String(raw).trim();
    if (!dep) {
      console.error('Refusing to plan — --dep needs a task id (e.g. --dep plan-20261010-001). Nothing was written.');
      process.exit(1);
    }
    if (dep === taskId) {
      console.error(`Refusing to plan — ${taskId} cannot depend on itself: no order can satisfy that. Nothing was written.`);
      process.exit(1);
    }
    if (!knownIds.has(dep)) {
      console.error(`Refusing to plan — dependency "${dep}" is not in the backlog. Name an existing task, or plan it first. Nothing was written.`);
      process.exit(1);
    }
    if (depIds.includes(dep)) {
      console.error(`Refusing to plan — dependency "${dep}" was given more than once. Nothing was written.`);
      process.exit(1);
    }
    depIds.push(dep);
  }
  const task = {
    id: taskId,
    title: String(args.goal).trim(),
    status: 'todo',
    skill,
    mode,
    priority,
    acceptance_checks: checks,
  };
  if (depIds.length) task.dependencies = depIds;
  if (args.manual) task.manual = true;
  // `--layer` stamps the task's stratum. `pb validate` then enforces that the layer
  // is declared and that the task is not sitting earlier than its dependencies, so a
  // typo or a stale layer becomes a guardrail failure rather than a silent mis-plan.
  if (args.layer) {
    const layerId = String(args.layer).trim();
    const defs = readLayerDefs();
    if (!defs.layers.some((l) => l.id === layerId)) {
      console.error(`Unknown layer: ${layerId}. Declared layers: ${defs.layers.map((l) => l.id).join(', ') || '(none — add a \`layers\` list to the master)'}`);
      process.exit(1);
    }
    task.layer = layerId;
  }
  // Structural probe: the SAME rules `pb validate` and `plan --layers` run, applied to
  // the CANDIDATE before it exists on disk. `--dep` plus `--layer` can describe a task
  // validate would reject (a dependency from the same or a later layer, a task declared
  // earlier than its dependencies). Refusing it here is the difference between a CLI
  // that cannot write a broken task and one that writes it and blames the gate.
  // checkGates:false — planning never runs a gate command.
  if (depIds.length || task.layer) {
    const probe = computeLayerPlan({ allTasks: [...backlogTasks(), task] });
    const mine = probe.problems.filter((p) => p.task === task.id);
    if (mine.length) {
      console.error(`Refusing to plan [${task.id}] — it would make the plan invalid (\`pb validate\` would fail):`);
      for (const p of mine) console.error(`  ! ${p.message}`);
      console.error('Nothing was written.');
      process.exit(1);
    }
  }
  appendBacklogTask(task);
  console.log(`Planned [${task.id}] ${task.title}`);
  console.log(`  skill: ${skill}`);
  console.log(`  priority: ${priority}`);
  if (task.layer) console.log(`  layer: ${task.layer}`);
  if (depIds.length) {
    console.log('  dependencies (declared at birth — the claim path enforces them and `pb graph` draws them):');
    for (const d of depIds) console.log(`    ← ${d}`);
  }
  if (checks.length) {
    console.log('  acceptance_checks:');
    for (const c of checks) console.log(`    $ ${c}`);
  } else {
    console.log('  acceptance_checks: none — add executable checks before auto-executing.');
  }
  // --- spawn provenance: which task this one was born UNDER --------------------
  // An agent that plans a task while it is executing another is the origin of that task,
  // and the journal — not the graph's inference — is where that belongs. `origin_task`
  // makes `pb graph` draw a task→task `spawn` edge (proven: an explicit action:spawn row
  // is the proof) instead of hanging the new card off `start`. No task in flight ⇒ no
  // spawn row: the card is a plain unclaimed todo, exactly as before.
  const agentId = resolveAgentId(args);
  const origin = backlogTasks().find((t) => t.status === 'in_progress' && taskHolder(t) === agentId) || null;
  if (origin) {
    const ownership = verifyTaskClaim(task.id, args, readBacklogState());
    const entry = {
      ts: nowISO(),
      loop_id: loop.id,
      task: task.id,
      agent: agentId,
      agent_id: agentId,
      claimed_by: agentId,
      mode,
      ownership: ownership.status,
      action: 'spawn',
      // The truth at birth: the task is `todo`. A spawn row is non-terminal to the
      // replay, so this can never move the task's status — asserted in the test suite.
      status: 'todo',
      checks: 'none',
      result: null,
      files: [],
      notes: `spawned while executing [${origin.id}]`,
      origin_task: origin.id,
    };
    const commit = commitIteration(task.id, entry, () => ({ updated_at: entry.ts }), { agent: agentId });
    if (!commit) process.exit(1);
    console.log(`  spawn: journal seq ${commit.seq} records origin_task ${origin.id} — \`pb graph\` now draws ${origin.id} → ${task.id}`);
  }
}

// ============================================================================
//  record — append a structured journal entry (the agent-first record).
//  Recording done RUNS the task's acceptance_checks first and refuses on
//  failure. --skip-checks is the escape hatch, and it is stamped on the entry.
// ============================================================================
function cmdRecord(args) {
  if (!args.task || !args.action || !args.status) {
    console.error('Usage: pb record --task <id> --action <action> --status <status> [--result <r>] [--files a,b] [--notes "..."] [--agent <name>] [--loop <id>] [--at <dir>] [--token <claim-token>] [--skip-checks] [--require-loop]');
    console.error('  --at <dir>  run the acceptance_checks in that tree (e.g. a worker worktree) instead of the playbook root');
    console.error(`status must be one of: ${ALLOWED_STATUSES.join(', ')}`);
    process.exit(1);
  }
  if (!ALLOWED_STATUSES.includes(args.status)) {
    console.error(`Invalid status "${args.status}". Allowed: ${ALLOWED_STATUSES.join(', ')}`);
    process.exit(1);
  }

  const task = backlogTasks().find((t) => t.id === args.task);
  if (['done', 'blocked'].includes(args.status) && !task) {
    console.error(`Task not found in backlog: ${args.task}. Cannot record ${args.status} for an unknown task.`);
    process.exit(1);
  }
  const loop = args.loop ? loopById(args.loop) : activeLoop();
  if (args['require-loop'] && !loop) {
    console.error('No active loop. Start one with `pb loop new`, or pass --loop <id>.');
    process.exit(1);
  }
  const loopId = loop?.id || args.loop || 'legacy';
  if (!loop && !args.loop) console.log('WARNING: no active loop; recording with loop_id=legacy.');
  let checksOutcome = 'none';
  let checkDir = ROOT;
  if (args.status === 'done' && task) {
    const checks = taskChecks(task);
    // `--at <worktree>`: run the checks against the ISOLATED tree whose results are
    // being recorded. Recording done from a worker normally happens at the root,
    // where a worker-only artifact does not exist yet — so the verified-in-worktree
    // result could not be recorded honestly, and the only ways out were
    // --skip-checks (which blocks the merge gate by design) or merging first (which
    // is backwards). The journal stamps the tree the checks actually ran in.
    checkDir = typeof args.at === 'string' && args.at.trim() ? resolve(process.cwd(), args.at.trim()) : ROOT;
    if (checkDir !== ROOT && !existsSync(checkDir)) {
      console.error(`--at ${args.at} does not exist — refusing to record done against a missing tree.`);
      process.exit(1);
    }
    if (checks.length && args['skip-checks']) {
      checksOutcome = 'skipped';
      console.log(`WARNING: recording done with ${checks.length} acceptance check(s) SKIPPED. The journal will say so.`);
    } else if (checks.length) {
      console.log(`Running ${checks.length} acceptance check(s) for [${task.id}] before recording done${checkDir === ROOT ? '' : ` in ${checkDir}`}:`);
      const results = runChecks(task, checkDir);
      printCheckResults(results);
      if (results.some((r) => !r.ok)) {
        console.error(`\nRefusing to record [${task.id}] as done — acceptance checks failed.`);
        console.error('Fix the work, or record --status blocked with notes. (--skip-checks overrides, and is stamped on the entry.)');
        process.exit(1);
      }
      checksOutcome = 'passed';
    }
  }

  const agentId = resolveAgentId(args);
  const claimRecord = readBacklogState()[args.task] || {};
  // Ownership check: a writer should be the claim holder, hold its token, or be
  // downstream of it in a declared delegation chain. An unproven writer is still
  // recorded (work is never silently dropped) but the row is flagged, so
  // "who wrote this and were they entitled to" is answerable after the fact.
  const ownership = verifyTaskClaim(args.task, args, readBacklogState());
  if (!ownership.ok) {
    console.error(`WARNING: [${args.task}] is held by "${ownership.holder}" but this writer (chain: ${ownership.chain.join(' → ') || agentId}) cannot prove it holds it.`);
    console.error('         Recording anyway, flagged as ownership=unproven. Pass --token <claim-token> or set PB_AGENT_CHAIN if this is a delegated write.');
  }
  const entry = {
    ts: nowISO(),
    loop_id: loopId,
    task: args.task,
    agent: agentId,
    // multi-agent + modes provenance on every journal row:
    agent_id: agentId,
    claimed_by: claimRecord.claimed_by || agentId,
    mode: claimRecord.mode || resolveModeId() || undefined,
    ownership: ownership.status,
    agent_chain: ownership.chain || undefined,
    action: args.action,
    status: args.status,
    checks: checksOutcome,
    check_cwd: checksOutcome === 'passed' ? (checkDir === ROOT ? 'root' : checkDir) : undefined,
    result: args.result || null,
    files: args.files ? String(args.files).split(',').map((s) => s.trim()).filter(Boolean) : [],
    notes: args.notes || null,
  };
  // The journal row and the task-state touch commit together, in one order. This
  // is what makes "who wrote last" answerable and identical across both stores.
  const endsIteration = !!(task && ['done', 'blocked'].includes(args.status));
  const commit = commitIteration(args.task, entry, (existing) => {
    if (!endsIteration) return {};
    return {
      status: args.status,
      updated_at: entry.ts,
      loop_id: existing.loop_id || (loop ? loop.id : undefined),
    };
  }, { agent: agentId });
  if (!commit) process.exit(1);
  console.log(`Recorded [${entry.task}] ${entry.action} → ${entry.status}${checksOutcome !== 'none' ? ` (checks: ${checksOutcome})` : ''} (seq ${commit.seq})`);
  if (endsIteration) console.log(`Backlog [${task.id}] → ${args.status}.`);
}

// ============================================================================
//  comment — a steering note on a task, journal-native (design D5).
// ----------------------------------------------------------------------------
// Append-only and attributable: the row carries the writer, the claim ownership and
// the delegation chain, so a steer survives compaction and is answerable after the
// fact. It is constructed so that it CANNOT move the task's status: the row's `status`
// is the task's CURRENT status (a non-terminal replay for any live task) and the
// transaction patches nothing but the touch stamp. That property is pinned by
// scripts/test-pb-graph.mjs — a "comment" that could close a task would be a status
// change wearing a note's clothes.
// ============================================================================
function cmdComment(args) {
  const taskId = typeof args.task === 'string' ? args.task.trim() : '';
  const text = typeof args.text === 'string' ? args.text : '';
  if (!taskId || !text.trim()) {
    console.error('Usage: pb comment --task <id> --text "..." [--agent <name>] [--token <claim-token>] [--chain <a,b>]');
    process.exit(1);
  }
  const task = backlogTasks().find((t) => t.id === taskId);
  if (!task) { console.error(`Task not found in backlog: ${taskId}`); process.exit(1); }
  const agent = resolveAgentId(args);
  const claim = readBacklogState()[taskId] || {};
  const ownership = verifyTaskClaim(taskId, args, readBacklogState());
  if (!ownership.ok) {
    console.error(`WARNING: [${taskId}] is held by "${ownership.holder}" but this writer (chain: ${ownership.chain.join(' → ') || agent}) cannot prove it holds it.`);
    console.error('         Recording anyway, flagged as ownership=unproven. Pass --token <claim-token> or set PB_AGENT_CHAIN if this is a delegated write.');
  }
  const entry = {
    ts: nowISO(),
    loop_id: activeLoop()?.id || 'legacy',
    task: taskId,
    agent,
    agent_id: agent,
    claimed_by: claim.claimed_by || agent,
    mode: claim.mode || resolveModeId() || undefined,
    ownership: ownership.status,
    // Always stamped, not only when the chain is what proved the claim: a steering
    // row's delegation path is part of its attribution. (`record` stamps
    // ownership.chain, which the token path leaves undefined — a comment carries the
    // declared path unconditionally instead of inheriting that hole.)
    agent_chain: resolveAgentChain(args),
    action: 'comment',
    status: task.status,          // current status, so a replay cannot move it
    checks: 'none',
    result: null,
    files: [],
    notes: text.trim(),
  };
  const commit = commitIteration(taskId, entry, () => ({}), { agent });
  if (!commit) process.exit(1);
  console.log(`Comment on [${taskId}] recorded (seq ${commit.seq}, ownership: ${entry.ownership}) — status unchanged (${task.status}).`);
}

// ============================================================================
//  loop — durable loop epochs. A failed loop can be closed/quarantined without
//  erasing its journal rows; the next loop gets a clean active loop_id.
// ============================================================================
function claimedTasksForLoop(loopId) {
  return backlogTasks().filter((t) => t.loop_id === loopId);
}
function terminalJournalForTask(loopId, taskId) {
  return readJournal().filter((e) => !e.__malformed)
    .some((e) => e.loop_id === loopId && e.task === taskId && ['done', 'blocked'].includes(e.status));
}
function closeGateErrors(loop, args = {}) {
  const errors = [];
  const failures = runValidate();
  if (failures.length) errors.push(`Guardrails fail (${failures.length}); run \`pb validate\`.`);

  const wip = backlogTasks().filter((t) => t.status === 'in_progress');
  if (wip.length) errors.push(`${wip.length} task(s) still in_progress: ${wip.map((t) => t.id).join(', ')}`);

  for (const t of claimedTasksForLoop(loop.id)) {
    if (!terminalJournalForTask(loop.id, t.id)) errors.push(`[${t.id}] was claimed in this loop but has no terminal loop-scoped journal record.`);
  }

  const live = latestProcessRecords(loop.id).filter((proc) => proc.status !== 'stopped' && pidAlive(proc.pid));
  if (live.length) errors.push(`${live.length} tracked process(es) still alive: ${live.map((p) => p.pid).join(', ')}`);

  const journal = readJournal().filter((e) => !e.__malformed);
  const reflectTs = lastReflectTs(journal, loop.id);
  if (!args['allow-unreflected'] && (!reflectTs || (loop.started_at && reflectTs < loop.started_at))) {
    errors.push('No reflection recorded for this loop; run `pb reflect --notes "..."` or close with --allow-unreflected.');
  }

  const cyc = readCycle();
  if (!cyc.exists || !cyc.stop) errors.push(`No cycle stop condition found in ${CYCLE}.`);
  // Tracked-state trap (defense in depth): closing a loop whose journal is git-tracked
  // risks those records being reverted by the next merge.
  for (const w of trackedStateWarnings()) errors.push(w);
  return errors;
}
function writeLoopReport(loop, status, notes = '') {
  const rel = loopArtifactsRel(loop.id, 'reports', 'close.md');
  const entries = readJournal().filter((e) => !e.__malformed && e.loop_id === loop.id);
  const lines = [
    `# Loop Close — ${loop.id}`,
    '',
    `- status: ${status}`,
    `- started_at: ${loop.started_at || ''}`,
    `- closed_at: ${loop.closed_at || ''}`,
    `- journal lines: ${loop.journal?.first_line ?? '?'}-${loop.journal?.last_line ?? '?'}`,
    notes ? `- notes: ${notes}` : null,
    '',
    '## Journal',
    '',
  ].filter(Boolean);
  if (!entries.length) lines.push('_No loop-scoped journal entries._');
  for (const e of entries) lines.push(`- ${e.ts?.slice(0, 19) || '?'} [${e.task || '-'}] ${e.action || '?'} -> ${e.status || '?'}`);
  ensureDir(dirname(rel));
  writeFileSync(p(rel), lines.join('\n') + '\n', 'utf8');
  return rel;
}
function writeQuarantine(loop, reason, stopped) {
  const rel = loopArtifactsRel(loop.id, 'quarantine.md');
  const lines = [
    `# Loop Quarantine — ${loop.id}`,
    '',
    `- reason: ${reason}`,
    `- started_at: ${loop.started_at || ''}`,
    `- closed_at: ${loop.closed_at || ''}`,
    `- journal lines: ${loop.journal?.first_line ?? '?'}-${loop.journal?.last_line ?? '?'}`,
    '',
    '## Processes',
    '',
  ];
  if (!stopped.length) lines.push('_No live tracked processes stopped._');
  for (const proc of stopped) lines.push(`- pid ${proc.pid}: ${proc.status} (${proc.cmd || proc.command || ''})`);
  lines.push('', '## Next', '', 'Run `pb learn --loop ' + loop.id + ' --source user --notes "..."` before starting the next loop.');
  ensureDir(dirname(rel));
  writeFileSync(p(rel), lines.join('\n') + '\n', 'utf8');
  return rel;
}
function failedLoopNeedsLearning(state) {
  return [...state.loops].reverse().find((l) =>
    l.status === 'failed' && !l.learning_skipped && lessonsForLoop(l.id).length === 0
  ) || null;
}
function seedCycleFromLoop(loop, args) {
  const cur = readCycle();
  const phase = (Number.isInteger(cur.phase) ? cur.phase : 0) + 1;
  const high = openLessons().filter((l) => l.severity === 'high');
  const prior = high.length
    ? high.map((l) => `- [${l.id}] ${l.problem || l.notes || l.raw_notes || '(no problem)'}`).join('\n')
    : 'No open high-severity lessons.';
  const challenges = args['from-lessons'] && high.length
    ? high.map((l) => `- Avoid repeating ${l.loop_id || 'prior loop'}: ${l.problem || l.notes || l.raw_notes || '(no problem)'}`).join('\n')
    : null;
  const conflicts = args['from-lessons'] && high.length
    ? 'Review open high-severity lessons before following host memory or old assumptions.'
    : null;
  ensureDir(dirname(CYCLE));
  writeFileSync(p(CYCLE), cycleTemplate({
    phase,
    goal: args.goal || loop.goal,
    stop: args.stop || loop.stop,
    challenges,
    priorChallenges: prior,
    conflicts,
  }), 'utf8');
}
function cmdLoopRunAuto(args) {
  const loop = activeLoop();
  if (!loop) {
    console.error('No active loop. Start one with `pb loop new` before running auto.');
    process.exit(1);
  }
  const journal = readJournal().filter((e) => !e.__malformed);
  const blockers = cycleBlockers(journal);
  if (blockers.length) {
    console.error('Refusing auto run — phase-loop guardrail gap:');
    for (const b of blockers) console.error(`  ! ${b}`);
    process.exit(1);
  }
  const maxTasks = Number(args['max-tasks']) || Infinity;
  const retry = Number(args.retry) || 3;
  const dryRun = args['dry-run'];
  // --defer-blocked: keep going past a faulted task instead of stopping the whole
  // run. A blocked task drops out of the `todo` filter, so the run naturally ends
  // when nothing claimable remains. If anything was deferred, the terminal status
  // is `stalled` (not `done`) — done is still earned only by passing checks.
  const defer = !!args['defer-blocked'];
  let tasksCompleted = 0;
  let deferred = 0;
  let finalStatus = 'done';
  console.log(`\nStarting autonomous run for [${loop.id}] (max-tasks=${maxTasks === Infinity ? 'unlimited' : maxTasks}, retry=${retry}${defer ? ', defer-blocked' : ''})${dryRun ? ' [DRY RUN]' : ''}\n`);
  while (tasksCompleted < maxTasks) {
    const tasks = backlogTasks();
    const todo = tasks.filter((t) => t.status === 'todo');
    // Same two gates the interactive claim path applies: dependencies AND layer
    // gates. An autonomous run must not be the one path that can jump a layer.
    const autoPlan = computeLayerPlan({ checkGates: true, allTasks: tasks });
    const claimable = todo
      .filter((t) => unmetDeps(t, tasks).length === 0 && !gateBlockersFor(autoPlan, t).length)
      .sort((a, b) => prio(a) - prio(b));
    const candidate = claimable[0];
    if (!candidate) {
      // "Nothing claimable" is NOT "nothing to do". A failing layer gate filters work
      // out of `claimable`, so the old message — "Autonomous run complete." — reported
      // success while whole layers sat behind a red gate. Distinguish the two, and say
      // what the human owes: every human-gated layer is a question, collected here in
      // one batch rather than discovered one stop at a time.
      const blockedByGate = autoPlan.tasks.filter((t) => t.status === 'todo' && gateBlockersFor(autoPlan, t).length);
      if (blockedByGate.length) {
        const human = autoPlan.waiting_on_human || [];
        const agent = autoPlan.waiting_on_agent || [];
        console.log(`\nNo claimable work — ${blockedByGate.length} task(s) sit behind an unmet layer gate:`);
        for (const t of blockedByGate) {
          const g = gateBlockersFor(autoPlan, t)[0];
          console.log(`  [${t.id}] layer ${t.layer || '?'} blocked by ${g.layer}${g.human ? ' (human)' : ''}${g.evaluated ? '' : ' [gate not verified]'}`);
        }
        if (human.length) {
          console.log(`\nWAITING ON A HUMAN (${human.length}) — no agent retry turns these green:`);
          for (const w of human) console.log(`  · ${w.layer}: needs $ ${w.gate} → unblocks ${w.blocked_tasks.join(', ') || 'nothing'}`);
          console.log('Answer these in one pass — the run does not need to stop for each one.');
        }
        const onAgent = agent.reduce((n, w) => n + w.blocked_tasks.length, 0);
        if (onAgent) console.log(`\n${onAgent} further task(s) are blocked on AGENT work in a lower layer — finish that first (or run without --auto to claim it).`);
        finalStatus = 'stalled';
        break;
      }
      console.log('No actionable tasks. Autonomous run complete.');
      break;
    }
    if (candidate.manual) {
      if (defer) {
        recordAuto(loop, candidate, 'blocked', 'none', 'Deferred: marked manual, requires human approval.', { agent: autoAgent, claimToken: autoToken });
        console.log(`[${candidate.id}] → blocked (manual, deferred)`);
        deferred++;
        continue;
      }
      console.log(`Stopping auto run: [${candidate.id}] is marked manual and requires human approval.`);
      finalStatus = 'blocked';
      break;
    }
    const cmds = taskCommands(candidate);
    const checks = taskChecks(candidate);
    if (!cmds.length && !checks.length) {
      if (defer) {
        recordAuto(loop, candidate, 'blocked', 'none', 'Deferred: no executable commands or checks (honor-only).', { agent: autoAgent, claimToken: autoToken });
        console.log(`[${candidate.id}] → blocked (honor-only, deferred)`);
        deferred++;
        continue;
      }
      console.log(`Stopping auto run: [${candidate.id}] has no executable commands or checks (honor-only).`);
      finalStatus = 'blocked';
      break;
    }
    if (dryRun) {
      console.log(`[DRY RUN] would claim [${candidate.id}] ${candidate.title}`);
      console.log(`[DRY RUN] would run ${cmds.length} command(s) and ${checks.length} check(s).`);
      break;
    }
    // The auto runner is an agent like any other, so it takes the task the same way:
    // it mints a claim token at claim time and presents it on every write. That keeps
    // its rows attributable and proven rather than flagged `ownership: unproven`.
    const autoAgent = resolveAgentId(args);
    const autoToken = newClaimToken();
    updateBacklogState(candidate.id, () => ({
      status: 'in_progress',
      claimed_at: nowISO(),
      loop_id: loop.id,
      claimed_by: autoAgent,
      agent_id: autoAgent,
      claim_token: autoToken,
      claim_token_issued_at: nowISO(),
      mode: candidate.mode || loop.mode || DEFAULT_MODE || undefined,
    }), { agent: autoAgent });
    console.log(`Claimed [${candidate.id}] ${candidate.title} (agent: ${autoAgent})`);
    let cmdResults = [];
    if (cmds.length) {
      console.log(`Running ${cmds.length} command(s):`);
      cmdResults = runCommands(candidate);
      printCommandResults(cmdResults);
    }
    if (cmdResults.some((r) => !r.ok)) {
      const failed = cmdResults.find((r) => !r.ok);
      recordAuto(loop, candidate, 'blocked', 'none', `Auto-run command failed: ${failed.cmd}`, { agent: autoAgent, claimToken: autoToken });
      console.error(`[${candidate.id}] → blocked (command failed)`);
      if (defer) { deferred++; continue; }
      finalStatus = 'blocked';
      break;
    }
    let passed = false;
    let checkResults = [];
    for (let attempt = 0; attempt <= retry; attempt++) {
      if (attempt > 0) console.log(`  Retry ${attempt}/${retry}...`);
      checkResults = runChecks(candidate);
      if (!checkResults.some((r) => !r.ok)) { passed = true; break; }
      printCheckResults(checkResults);
    }
    if (passed) {
      recordAuto(loop, candidate, 'done', checks.length ? 'passed' : 'none', 'Auto-executed and verified.', { agent: autoAgent, claimToken: autoToken });
      console.log(`[${candidate.id}] → done`);
      tasksCompleted++;
    } else {
      recordAuto(loop, candidate, 'blocked', 'failed', `Auto-run acceptance checks failed after ${retry} retries.`, { agent: autoAgent, claimToken: autoToken });
      console.error(`[${candidate.id}] → blocked (checks failed)`);
      if (defer) { deferred++; continue; }
      finalStatus = 'blocked';
      break;
    }
  }
  // In defer mode the run never breaks on a fault, so finalStatus is still 'done'
  // here. If anything was deferred, the backlog did not fully drain — say so.
  if (defer && deferred > 0 && finalStatus === 'done') finalStatus = 'stalled';
  console.log(`\nAutonomous run finished. ${tasksCompleted} task(s) completed${deferred ? `, ${deferred} deferred (blocked)` : ''}. Status: ${finalStatus}.`);
  if (tasksCompleted > 0 || finalStatus === 'blocked' || deferred > 0) {
    try { cmdReport(args); } catch { /* report is best-effort */ }
  }
}

function cmdLoop(args) {
  const sub = args._[0] || 'status';
  if (sub === 'new') {
    const state = readLoops();
    const active = state.active ? state.loops.find((l) => l.id === state.active) : null;
    if (active && active.status === 'active') {
      console.error(`Refusing: loop already active: ${active.id}. Close it first with \`pb loop close\`.`);
      process.exit(1);
    }
    const failed = failedLoopNeedsLearning(state);
    if (failed) {
      if (!args['skip-learning']) {
        console.error(`Refusing: failed loop ${failed.id} has no learning reflection.`);
        console.error(`Run \`pb learn --loop ${failed.id} --source user --notes "..."\`, or use --skip-learning "reason".`);
        process.exit(1);
      }
      failed.learning_skipped = { ts: nowISO(), reason: args['skip-learning'] === true ? 'no reason supplied' : String(args['skip-learning']) };
    }
    const id = nextLoopId(state);
    const loop = {
      id,
      status: 'active',
      started_at: nowISO(),
      closed_at: null,
      goal: args.goal || '',
      stop: args.stop || '',
      journal: { first_line: journalLineCount() + 1, last_line: null },
      artifacts: loopArtifactsRel(id),
      reason: null,
    };
    state.active = id;
    state.loops.push(loop);
    for (const d of ['logs', 'reports', 'snapshots']) ensureDir(loopArtifactsRel(id, d));

    // --fresh: this loop starts from the current repo state, not the existing task
    // model. Archive the backlog as-is (nothing is lost) and reset it to empty, so a
    // stale backlog (tasks whose "done" artifacts no longer exist on disk, or whose
    // remaining tasks assume them) can't be silently inherited and claimed.
    let resetNote = null;
    if (args.fresh) {
      const tasks = backlogTasks();
      if (tasks.length) {
        const snapshotRel = loopArtifactsRel(id, 'backlog-snapshot-pre-fresh.yaml');
        ensureDir(dirname(snapshotRel));
        writeFileSync(p(snapshotRel), yaml.dump({ tasks }, { lineWidth: 100 }), 'utf8');
        writeBacklog({ tasks: [] });
        loop.reset_backlog = { archived_to: snapshotRel, count: tasks.length, ts: nowISO() };
        resetNote = `Backlog reset for a ground-up loop — ${tasks.length} prior task(s) archived to ${snapshotRel}.`;
      } else {
        resetNote = 'Backlog reset requested, but it was already empty — nothing archived.';
      }
    }

    writeLoops(state);
    if (args.goal || args.stop || args['from-lessons']) seedCycleFromLoop(loop, args);
    console.log(`Opened loop: ${id}`);
    console.log(`Artifacts: ${loop.artifacts}`);
    if (resetNote) console.log(resetNote);
    console.log(args.fresh
      ? 'Next: add backlog tasks that reflect the current repo state, then `pb status`.'
      : 'Next: `pb status`, then claim work or record progress.');
    return;
  }

  if (sub === 'status') {
    const state = readLoops();
    const loop = activeLoop();
    console.log('\nLoop state:');
    console.log(`  active: ${loop ? loop.id : '(none)'}`);
    console.log(`  total:  ${state.loops.length}`);
    if (loop) {
      const entries = readJournal().filter((e) => !e.__malformed && e.loop_id === loop.id);
      const live = latestProcessRecords(loop.id).filter((p) => p.status !== 'stopped' && pidAlive(p.pid));
      const errors = closeGateErrors(loop, { 'allow-unreflected': true });
      console.log(`  started: ${String(loop.started_at).slice(0, 19)}`);
      console.log(`  journal entries: ${entries.length}`);
      console.log(`  live tracked processes: ${live.length}`);
      console.log(errors.length ? `  close gate: blocked (${errors.length})` : '  close gate: clear (reflection may still be required)');
    }
    const failed = failedLoopNeedsLearning(state);
    if (failed) console.log(`  learning needed: ${failed.id}`);
    console.log('');
    return;
  }

  if (sub === 'close') {
    const status = args.status || 'done';
    if (!['done', 'failed', 'abandoned'].includes(status)) {
      console.error('Usage: pb loop close --status <done|failed|abandoned> [--reason "..."] [--allow-unreflected]');
      process.exit(1);
    }
    const state = readLoops();
    const loop = activeLoop();
    if (!loop) {
      console.error('No active loop to close.');
      process.exit(1);
    }
    if (status === 'done') {
      const errors = closeGateErrors(loop, args);
      if (errors.length) {
        console.error(`Refusing to close ${loop.id} as done:`);
        for (const e of errors) console.error(`  - ${e}`);
        process.exit(1);
      }
    }
    const stored = state.loops.find((l) => l.id === loop.id);
    stored.status = status;
    stored.closed_at = nowISO();
    stored.reason = args.reason || null;
    stored.journal = { ...(stored.journal || {}), last_line: journalLineCount() };
    if (args['allow-unreflected']) stored.allow_unreflected = { ts: nowISO(), reason: args['allow-unreflected'] === true ? 'operator override' : String(args['allow-unreflected']) };
    let artifact = null;
    if (status === 'failed' || status === 'abandoned') {
      const stopped = stopLoopProcesses(loop.id);
      artifact = writeQuarantine(stored, args.reason || status, stopped);
    } else {
      artifact = writeLoopReport(stored, status, args.reason || '');
    }
    state.active = null;
    writeLoops(state);
    console.log(`Closed loop ${loop.id} -> ${status}.`);
    if (artifact) console.log(`Artifact: ${artifact}`);
    if (status === 'failed') console.log(`Next: \`pb learn --loop ${loop.id} --source user --notes "..."\`.`);
    return;
  }

  if (sub === 'quarantine') {
    const id = args._[1] || args.loop;
    if (!id) { console.error('Usage: pb loop quarantine <loop_id>'); process.exit(1); }
    const state = readLoops();
    const loop = state.loops.find((l) => l.id === id);
    if (!loop) { console.error(`Loop not found: ${id}`); process.exit(1); }
    loop.status = 'quarantined';
    loop.quarantined_at = nowISO();
    writeLoops(state);
    console.log(`Loop ${id} -> quarantined.`);
    return;
  }

  if (sub === 'run') {
    if (args.auto) {
      cmdLoopRunAuto(args);
      return;
    }
    console.error('Usage: pb loop run --auto [--max-tasks N] [--retry N] [--dry-run]');
    process.exit(1);
  }

  console.error(`Unknown loop command: ${sub}`);
  process.exit(1);
}

// ============================================================================
//  learn — structured user/agent reflection. Raw lessons stay in lessons.ndjson;
//  durable rules, repair tasks, and skills are explicit promotions.
// ============================================================================
function cmdLearn(args) {
  if (args._[0] === 'status') {
    const lessons = readLessons();
    const open = lessons.filter((l) => l.status !== 'promoted' && l.status !== 'closed');
    console.log('\nLessons:');
    console.log(`  total: ${lessons.length}`);
    console.log(`  open:  ${open.length}`);
    for (const l of open) {
      console.log(`  [${l.id}] ${l.severity || 'medium'} ${l.loop_id || 'legacy'} -> ${l.promotion || 'journal'}: ${l.problem || l.notes || l.raw_notes || ''}`);
    }
    console.log('');
    return;
  }

  const loop = args.loop || activeLoop()?.id || latestLoop()?.id || 'legacy';
  const notes = args.notes || args.problem || args._.join(' ');
  if (!notes) {
    console.error('Usage: pb learn --loop <id> --source user --notes "what went wrong" [--severity high] [--promotion memory|backlog|skill|journal] [--target <file-or-task>]');
    process.exit(1);
  }
  const promotion = args.promotion || 'journal';
  if (!['journal', 'memory', 'backlog', 'skill'].includes(promotion)) {
    console.error('promotion must be one of: journal, memory, backlog, skill');
    process.exit(1);
  }
  const entry = {
    id: nextLessonId(),
    loop_id: loop,
    source: args.source || 'agent',
    severity: args.severity || 'medium',
    problem: args.problem || notes,
    root_cause: args['root-cause'] || args.root_cause || null,
    promotion,
    promotion_target: args.target || null,
    status: args.status || 'open',
    applies_to: args.applies_to ? String(args.applies_to).split(',').map((s) => s.trim()).filter(Boolean) : [],
    raw_notes: notes,
    created_at: nowISO(),
  };
  appendNdjson(LESSONS, entry);
  console.log(`Recorded lesson ${entry.id} for ${loop} -> ${promotion}.`);
  if (promotion !== 'journal' && !entry.promotion_target) {
    console.log('Promotion target is not set yet; add a backlog task or update the relevant memory/skill file before closing the lesson.');
  }
}

// ============================================================================
//  run / ps / stop — lightweight loop-scoped process tracking.
// ============================================================================
function cmdRun(args) {
  const loop = activeLoop();
  if (!loop) {
    console.error('No active loop. Start one with `pb loop new` before `pb run`.');
    process.exit(1);
  }
  const parts = args['--'] || args._;
  if (!parts?.length) {
    console.error('Usage: pb run -- <command>');
    process.exit(1);
  }
  const cmd = parts.join(' ');
  const file = parts[0];
  const argv = parts.slice(1);
  const stamp = nowISO().replace(/[:.]/g, '-');
  const safe = String(file).replace(/[^a-zA-Z0-9._-]/g, '_') || 'command';
  const outRel = loopArtifactsRel(loop.id, 'logs', `${stamp}-${safe}.out.log`);
  const errRel = loopArtifactsRel(loop.id, 'logs', `${stamp}-${safe}.err.log`);
  ensureDir(dirname(outRel));
  const child = spawnCommand(file, argv, {
    cwd: ROOT,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', openSync(p(outRel), 'a'), openSync(p(errRel), 'a')],
  });
  child.unref();
  appendNdjson(PROCESSES, {
    ts: nowISO(),
    loop_id: loop.id,
    pid: child.pid,
    cmd,
    cwd: '.',
    status: 'running',
    logs: { stdout: outRel, stderr: errRel },
  });
  console.log(`Started [${loop.id}] pid ${child.pid}: ${cmd}`);
  console.log(`Logs: ${outRel} / ${errRel}`);
}

function cmdPs(args) {
  const loopId = args.loop || activeLoop()?.id;
  const rows = latestProcessRecords(loopId || null);
  console.log('\nTracked processes:');
  if (!rows.length) console.log('  (none)');
  for (const proc of rows) {
    const alive = proc.status !== 'stopped' && pidAlive(proc.pid);
    console.log(`  ${proc.loop_id || 'legacy'} pid ${proc.pid} ${alive ? 'alive' : 'not-alive'} ${proc.status || ''} ${proc.cmd || ''}`);
  }
  console.log('');
}

function cmdStop(args) {
  const loopId = args.loop || activeLoop()?.id;
  if (!loopId) {
    console.error('Usage: pb stop --loop <loop_id>');
    process.exit(1);
  }
  const stopped = stopLoopProcesses(loopId);
  console.log(`Stopped ${stopped.length} tracked process(es) for ${loopId}.`);
}

// ============================================================================
//  report — roll the agent-first journal up into a human artifact
// ============================================================================
function cmdReport(args) {
  const journal = readJournal().filter((e) => !e.__malformed);
  const filtered = args.since ? journal.filter((e) => (e.ts || '') >= args.since) : journal;
  const tasks = backlogTasks();

  const counts = Object.fromEntries(ALLOWED_STATUSES.map((s) => [s, 0]));
  for (const t of tasks) if (counts[t.status] !== undefined) counts[t.status]++;

  const byTask = new Map();
  for (const e of filtered) {
    if (!byTask.has(e.task)) byTask.set(e.task, []);
    byTask.get(e.task).push(e);
  }
  const titleOf = (id) => tasks.find((t) => t.id === id)?.title || '';
  const taskById = new Map(tasks.map((t) => [t.id, t]));

  const lines = [];
  lines.push(`# ${master?.name || 'Playbook'} Report — ${today()}`);
  lines.push('');
  lines.push(`_Generated ${nowISO()} from \`${JOURNAL}\`${args.since ? ` (since ${args.since})` : ''}._`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| Status | Count |');
  lines.push('| --- | --- |');
  for (const s of ALLOWED_STATUSES) lines.push(`| ${s} | ${counts[s]} |`);
  lines.push(`| journal entries | ${filtered.length} |`);
  lines.push(`| loops | ${readLoops().loops.length} |`);
  lines.push(`| open lessons | ${openLessons().length} |`);
  lines.push('');

  lines.push('## Activity by task');
  lines.push('');
  if (byTask.size === 0) {
    lines.push('_No journal activity in range._');
  } else {
    for (const [taskId, entries] of byTask) {
      lines.push(`### [${taskId}] ${titleOf(taskId)}`.trimEnd());
      lines.push('');
      for (const e of entries) {
        const files = e.files?.length ? ` _(files: ${e.files.join(', ')})_` : '';
        const notes = e.notes ? ` — ${e.notes}` : '';
        const checks = reportCheckMarker(e, taskById.get(e.task));
        const loop = e.loop_id ? ` _(${e.loop_id})_` : '';
        lines.push(`- \`${e.ts?.slice(0, 19)}\`${loop} **${e.action}** → ${e.status}${checks}${notes}${files}`);
      }
      lines.push('');
    }
  }

  lines.push('## Open backlog');
  lines.push('');
  const open = tasks.filter((t) => t.status !== 'done').sort((a, b) => prio(a) - prio(b));
  if (open.length === 0) {
    lines.push('_Backlog clear._');
  } else {
    lines.push('| Priority | ID | Status | Task | Skill | Gate |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const t of open) lines.push(`| ${prio(t)} | ${t.id} | ${t.status} | ${t.title} | ${t.skill || '-'} | ${gateQuality(t)} |`);
  }
  lines.push('');

  ensureDir(REPORTS_DIR);
  const outRel = join(REPORTS_DIR, `report-${today()}.md`);
  writeFileSync(p(outRel), lines.join('\n'), 'utf8');
  console.log(`Report written: ${outRel}`);
}

// ============================================================================
//  list — print the indices
// ============================================================================
// The mode catalog as data (for `pb list modes --json` consumers: UIs and hosts).
function listModesPayload() {
  const cat = readData('modes/index.yaml');
  const entries = Array.isArray(cat?.modes) ? cat.modes : [];
  return {
    schema: 'agent-playbook.modes.v1',
    default_mode: DEFAULT_MODE || null,
    modes: entries.map((m) => ({
      id: m.id,
      default: m.id === DEFAULT_MODE,
      abstract: String(m.abstract || m.description || '').replace(/\s+/g, ' ').trim() || null,
    })),
  };
}
function listModes() {
  const cat = readData('modes/index.yaml');
  const entries = Array.isArray(cat?.modes) ? cat.modes : [];
  console.log(`\nModes (default: ${DEFAULT_MODE || 'none'} · * = default):`);
  if (!entries.length) {
    console.log('  (no mode catalog — create modes/index.yaml)');
  } else {
    for (const m of entries) {
      const mark = m.id === DEFAULT_MODE ? '*' : ' ';
      const abstract = String(m.abstract || m.description || '').replace(/\s+/g, ' ').trim();
      console.log(`  ${mark} ${String(m.id).padEnd(12)} ${abstract}`);
    }
  }
  console.log("\nInside a mode: `pb mode show <id>`.\n");
}

function cmdList(args) {
  const which = args._[0];
  if (which === 'modes') {
    if (args.json) return printJson(listModesPayload());
    listModes();
    return;
  }
  const mode = resolveModeId();
  // `--json` exists so a host runtime (the DSH plugin's skill provider) consumes the
  // resolved catalog as data instead of parsing this human table. It is the same
  // resolution the CLI uses, so one implementation serves both.
  if (args.json) {
    const payload = {
      schema: 'agent-playbook.list.v1',
      mode: mode || null,
      skills: resolvedSkillEntries().map((x) => ({
        id: x.id, file: x.file, process: x.process || null, owner: x.owner || null,
      })),
      processes: resolvedProcessEntries().map((x) => ({
        id: x.id, file: x.file, owner: x.owner || null,
      })),
    };
    if (which === 'skills') delete payload.processes;
    else if (which === 'processes') delete payload.skills;
    return printJson(payload);
  }
  if (!which || which === 'processes') {
    console.log(`\nProcesses (mode: ${mode || 'none'}):`);
    for (const x of resolvedProcessEntries()) console.log(`  ${String(x.id).padEnd(18)} ${x.file}${x.owner ? `  (${x.owner})` : ''}`);
  }
  if (!which || which === 'skills') {
    console.log(`\nSkills (mode: ${mode || 'none'}):`);
    for (const x of resolvedSkillEntries()) console.log(`  ${String(x.id).padEnd(18)} ${x.file}${x.process ? `  → ${x.process}` : ''}`);
  }
  console.log('');
}

// ============================================================================
//  init — ensure the runtime layout exists (safe: never overwrites content)
// ============================================================================
function cmdInit() {
  for (const dir of [MEMORY_DIR, REPORTS_DIR]) ensureDir(dir);
  const created = [];
  if (!existsSync(p(JOURNAL))) { writeFileSync(p(JOURNAL), '', 'utf8'); created.push(JOURNAL); }
  const gitkeep = join(REPORTS_DIR, '.gitkeep');
  if (!existsSync(p(gitkeep))) { writeFileSync(p(gitkeep), '', 'utf8'); created.push(gitkeep); }
  if (!existsSync(p(BACKLOG))) {
    writeBacklog({
      tasks: [{
        id: 'T1', title: 'First task', status: 'todo', skill: 'run-task', priority: 1,
        acceptance_checks: ['node scripts/pb.mjs validate'],
        notes: 'Replace me.', created: today(),
      }],
    });
    created.push(BACKLOG);
  }
  console.log(created.length ? `Initialized: ${created.join(', ')}` : 'Already initialized — runtime files present.');
  console.log('Note: init only creates missing runtime files; it never overwrites your content.');
  console.log('If this is an empty playbook with no processes/skills yet, run `node scripts/pb.mjs bootstrap`.');
}

// ============================================================================
//  bootstrap — seed the minimal operating playbook (safe: never overwrites)
// ----------------------------------------------------------------------------
//  `init` hydrates runtime state. `bootstrap` covers the earlier lifecycle stage:
//  an empty playbook folder that has structure but no runnable process/skill.
// ============================================================================
function cmdBootstrap() {
  const created = [];

  writeIfMissing('playbook.yaml', `name: agent-playbook
version: 0.3.5
description: Repo-local agent playbook.
entry: SKILL.md

north_star: >-
  (one invariant sentence — what this project drives toward; fill this before claiming work)

paths:
  root: .
  scripts: scripts
  processes: processes
  skills: skills
  memory: memory
  artifacts: artifacts
  reports: artifacts/reports

index:
  cli: scripts/pb.mjs
  processes_index: processes/index.yaml
  skills_index: skills/index.yaml
  memory:
    project_memory: memory/project-memory.md
    backlog: memory/backlog.yaml
    journal: memory/journal.ndjson
    cycle: memory/cycle.md
    loops: memory/loops.yaml
    lessons: memory/lessons.ndjson
    processes: memory/processes.ndjson
  artifacts:
    reports: artifacts/reports

loop:
  description: Orient -> Select -> Act -> Verify -> Record -> Report -> repeat.

fixation:
  - Re-anchor to playbook.yaml at the start of every loop iteration. The master wins.
  - Act only inside this folder. The playbook is self-contained (carry-on).
  - Skills-first. Find the matching skill before improvising. If none fits, write one.
  - Done means the task's acceptance_checks (shell commands) exit 0. Record only on pass.
  - Record every iteration to memory/journal.ndjson via pb record. No silent work.
  - A task's acceptance_checks must test the task's own artifacts — pb validate alone is not a task check.
  - Memory precedence: folder (north_star + memory/) outranks agent/host memory on project matters.

guardrails:
  validate_command: node scripts/pb.mjs validate
  allowed_statuses: [todo, in_progress, blocked, done]

hardening:
  principle: Externalize state to disk + re-anchor cheaply + auto-re-inject the anchor.
  commands:
    anchor: node scripts/pb.mjs anchor
    checkpoint: node scripts/pb.mjs checkpoint
  re_anchor: Call anchor at the start of every iteration and after every few actions.
`, created);

  writeIfMissing('SKILL.md', `# Playbook Skill

## Startup (every session)
1. Read \`playbook.yaml\` — the master (north_star, fixation, loop contract).
2. Read \`memory/project-memory.md\` — durable operating rules.
3. Run \`node scripts/pb.mjs status\` — orient on backlog + journal + guardrails.

## The loop
orient → select → act → verify → record → report

- Select: \`node scripts/pb.mjs next --claim\` — prints the task and its acceptance_checks.
  Claiming is refused if there's no active loop or the cycle brief is missing/stale/has an
  unanswered Q5 (see Phase loop below); fix the precondition or override with \`--force\`
  (not recommended).
- "Done" is enforced: \`pb record --status done\` runs the task's acceptance_checks (shell commands)
  and refuses if they fail. Exit codes, not prose.
- Roll up: \`node scripts/pb.mjs report\`.

## Phase loop (open each phase, close it)
- Open: \`node scripts/pb.mjs cycle --new\` — confirm the cycle brief (goal / challenges / stop).
- Close: \`node scripts/pb.mjs reflect\` — compare done tasks to the north_star; record notes.
- \`pb checkpoint\` warns on drift (missing/stale brief, done tasks awaiting reflection); \`pb next
  --claim\` enforces the missing/stale-brief part instead of just warning.

## Loop epochs and learning
- Open scoped work with \`node scripts/pb.mjs loop new --goal "..." --stop "..."\`.
- Default continues from the existing backlog. If it's stale relative to disk (assumes earlier
  "done" artifacts/paths that no longer exist), use \`loop new --fresh\` instead — it archives the
  current backlog (nothing lost) and resets it to empty for a ground-up loop.
- Close clean work with \`pb loop close --status done\`.
- Close contaminated work with \`pb loop close --status failed --reason "..."\`, then record
  reflection with \`pb learn --loop <id> --source user --notes "..."\` before the next loop.

## Memory precedence
Your host memory is the PAST; this folder is the project PRESENT/FUTURE. On any project conflict,
the folder wins — surface the conflict, do not silently follow host memory.
`, created);

  writeIfMissing(PROJECT_MEMORY, `# Project Memory

Durable repo-local facts for agents.

## Operating rules

1. Re-anchor to playbook.yaml at the start of every loop.
2. Keep work inside this playbook folder unless the task explicitly targets the parent repo.
3. Give every task executable acceptance_checks where possible — exit codes, not prose.
4. Record every completed or blocked iteration with pb record.
`, created);

  writeIfMissing(PROCESS_INDEX, `name: canonical-processes
version: 1.0.0
processes:
  - id: run-task
    file: processes/run-task.yaml
    owner: core
    summary: Generic task execution from claim to record/report.
`, created);

  writeIfMissing(SKILL_INDEX, `name: repo-skills
version: 1.0.0
skills:
  - id: run-task
    file: skills/run-task/SKILL.md
    process: run-task
    summary: Generic task execution.
`, created);

  writeIfMissing('processes/run-task.yaml', `name: run-task
version: 1.0.0
purpose: Take one backlog task from claim to verified, recorded outcome.
canonical_steps:
  - step: 1
    name: Orient
    requirements:
      - Read playbook.yaml and SKILL.md.
      - Run node scripts/pb.mjs status.
  - step: 2
    name: Act
    requirements:
      - Make the smallest change that satisfies the task.
      - Stay inside the intended repo/playbook scope.
  - step: 3
    name: Verify
    requirements:
      - Run node scripts/pb.mjs validate (structure) and node scripts/pb.mjs validate --task <id> (the task's checks).
  - step: 4
    name: Record and report
    requirements:
      - Run node scripts/pb.mjs record (recording done re-runs the checks and refuses on failure).
      - Run node scripts/pb.mjs report when useful for human handoff.
`, created);

  writeIfMissing('skills/run-task/SKILL.md', `# Run Task

Use this skill for any backlog item that does not have a more specific skill.

Canonical process: \`processes/run-task.yaml\`.

Steps:
1. Read the task from \`node scripts/pb.mjs next --claim\` — it prints the task's acceptance_checks.
2. Do the smallest safe change that satisfies them.
3. Verify: \`node scripts/pb.mjs validate\` and \`node scripts/pb.mjs validate --task <id>\`.
4. Record: \`node scripts/pb.mjs record --task <id> --action execute --status done --notes "..."\`.
   Recording done re-runs the checks; it refuses if they fail.
5. Run \`node scripts/pb.mjs report\` when a human-facing rollup is useful.
`, created);

  cmdInit();
  console.log(created.length ? `Bootstrapped: ${created.join(', ')}` : 'Already bootstrapped — minimal process/skill files present.');
  console.log('Note: bootstrap creates missing minimal files only; it never overwrites your content.');
}

// ============================================================================
//  anchor — the tiny constitution, cheap to re-inject so the playbook never
//  decays out of attention. `--brief` is a few lines safe to inject every turn.
//  Designed to be called from runtime hooks; never throws.
// ============================================================================
// ============================================================================
//  modes — resolve the active persona pack and render its anchor slice. A mode
//  NEVER weakens the floor; it only adds a `directive` (persona) + principles.
//  Resolution: task.mode (the in_progress task) ?? loop.mode (active loop) ??
//  master.default_mode. An empty directive is intentional and NON-BLOCKING:
//  it means "inherit the host agent's system prompt".
// ============================================================================
function loadMode(id) {
  if (!id || !(id in MODES)) return null;
  try {
    const doc = readData(MODES[id]);
    return doc && typeof doc === 'object' ? doc : null;
  } catch { return null; }
}
function resolveModeId() {
  const wip = backlogTasks().find((t) => t.status === 'in_progress');
  if (wip && typeof wip.mode === 'string' && wip.mode.trim()) return wip.mode.trim();
  const loop = activeLoop();
  if (loop && typeof loop.mode === 'string' && loop.mode.trim()) return loop.mode.trim();
  return DEFAULT_MODE;
}
function modeHasDirective(doc) {
  return !!(doc && typeof doc.directive === 'string' && doc.directive.trim());
}
// One tiny additive line for the anchor (brief + full both start with this).
function modeAnchorLine(id, doc) {
  if (!id) return 'Mode: (none — set `default_mode` in the master or run `pb mode set <id>`)';
  if (!doc) return `Mode: ${id} (UNREGISTERED — not in the modes registry)`;
  const names = Array.isArray(doc.principles) ? doc.principles.map((pr) => pr.id).filter(Boolean) : [];
  const tail = names.length ? ` · principles: ${names.join(', ')}` : '';
  const persona = modeHasDirective(doc) ? '' : ' · directive: inherits host prompt';
  return `Mode: ${id}${tail}${persona}`;
}

function cmdMode(args) {
  const sub = args._[0] || 'show';
  if (sub === 'list') {
    // `pb mode list` — first-class alias of `pb list modes` (same catalog output),
    // so both grammars work alongside `pb mode show|skills|processes`.
    listModes();
    return;
  }
  if (sub === 'show') {
    // `pb mode show` -> the active mode; `pb mode show <id>` -> that named mode's menu.
    const explicit = args._[1] ? String(args._[1]).trim() : null;
    const id = explicit || resolveModeId();
    const doc = loadMode(id);
    console.log(`\n${explicit ? 'Mode' : 'Active mode'}: ${id || '(none)'}`);
    if (!id) {
      console.log('No `default_mode` in the master and no loop/task override. Set one with `pb mode set <id>`.\n');
      return;
    }
    if (!doc) {
      console.log(`(UNREGISTERED — "${id}" is not in the modes registry: ${Object.keys(MODES).join(', ') || 'none'})\n`);
      return;
    }
    if (doc.description) console.log(`Description: ${String(doc.description).replace(/\s+/g, ' ').trim()}`);
    if (modeHasDirective(doc)) {
      console.log('Directive:');
      console.log(doc.directive.trim().split('\n').map((l) => `  ${l}`).join('\n'));
    } else {
      // Empty directive is intended and non-blocking — report, never gate.
      console.log("Directive: (empty by intent — inherits the host agent's system prompt)");
    }
    const prs = Array.isArray(doc.principles) ? doc.principles : [];
    if (prs.length) {
      console.log('Principles:');
      for (const pr of prs) {
        const c = pr.kind === 'check' ? ` (check: ${pr.check})` : '';
        console.log(`  - [${pr.kind}] ${pr.id}${c} — ${pr.text || ''}`);
      }
    }
    // The "what's inside" view — this mode's resolved menu (engine globals ∪ pack-local).
    const sks = modeSkillEntries(doc);
    const procs = modeProcessEntries(doc);
    console.log(`Skills (${sks.length}):`);
    for (const s of sks) console.log(`  ${String(s.id).padEnd(20)}${s.process ? ` → ${s.process}` : ''}`);
    console.log(`Processes (${procs.length}):`);
    for (const pr of procs) console.log(`  ${String(pr.id).padEnd(20)}${pr.owner ? ` (${pr.owner})` : ''}`);
    console.log(`Resolved via: task.mode ?? loop.mode ?? default_mode (${DEFAULT_MODE || 'unset'})\n`);
    return;
  }
  if (sub === 'skills' || sub === 'processes') {
    // Machine-readable menu: bare ids (one per line) for the named/active mode.
    // Used by the orchestrator to detect a scaffold capability gap.
    const explicit = args._[1] ? String(args._[1]).trim() : null;
    const id = explicit || resolveModeId();
    const doc = loadMode(id);
    if (!doc) { console.error(`Unknown or unregistered mode: ${id || 'none'}`); process.exit(1); }
    const entries = sub === 'skills' ? modeSkillEntries(doc) : modeProcessEntries(doc);
    for (const e of entries) console.log(e.id);
    return;
  }
  if (sub === 'check') {
    const id = resolveModeId();
    const doc = loadMode(id);
    if (!doc) {
      console.error(`No registered mode to check (resolved: ${id || 'none'}).`);
      process.exit(1);
    }
    const checks = modeCheckPrinciples(doc);
    if (!checks.length) {
      console.log(`Mode "${id}": no kind:check principles (advice-only) — nothing to gate. OK.`);
      return;
    }
    console.log(`Running ${checks.length} kind:check principle(s) for mode "${id}":`);
    const results = runModeChecks(doc);
    printModeCheckResults(results);
    if (results.some((r) => !r.ok)) {
      console.error(`\nMode "${id}" check FAILED.`);
      process.exit(1);
    }
    console.log(`Mode "${id}" checks passed.`);
    return;
  }
  if (sub === 'set') {
    const id = args._[1] || (typeof args.mode === 'string' ? args.mode : null);
    if (!id) { console.error('Usage: pb mode set <id>'); process.exit(1); }
    if (!(id in MODES)) {
      console.error(`Unknown mode "${id}". Registered: ${Object.keys(MODES).join(', ') || 'none'}`);
      process.exit(1);
    }
    const state = readLoops();
    const loop = state.active ? state.loops.find((l) => l.id === state.active && l.status === 'active') : null;
    if (!loop) {
      console.error('No active loop to scope the mode to. Open one with `pb loop new`, or rely on `default_mode`.');
      process.exit(1);
    }
    loop.mode = id;
    writeLoops(state);
    console.log(`Mode set: ${id} (scoped to loop ${loop.id}).`);
    return;
  }
  console.error('Usage: pb mode <list | show [<id>] | set <id> | check | skills [<id>] | processes [<id>]>');
  process.exit(1);
}

function cmdAnchor(args) {
  const name = master.name || 'playbook';
  const loopDesc = master.loop?.description || 'orient → select → act → verify → record → report';
  const cur = readCycle();
  const purpose = NORTH_STAR ? `North Star (invariant): ${NORTH_STAR}` : 'North Star: (unset — add `north_star:` to the master)';
  const cycleLine = cur.exists
    ? `This cycle (phase ${cur.phase ?? '?'}): ${cur.goal || '(goal unset)'}  ·  Stop: ${cur.stop || '(unset)'}`
    : 'This cycle: (no brief — run `pb cycle --new`)';
  const loop = activeLoop();
  const loopLine = loop
    ? `Loop: ${loop.id} active · artifacts: ${loop.artifacts || loopArtifactsRel(loop.id)}`
    : 'Loop: (none active — run `pb loop new` for scoped work)';
  const highLessons = openLessons().filter((l) => l.severity === 'high').length;
  const lessonLine = `Lessons: ${highLessons} open high-severity · run \`pb learn status\``;
  const memRule = 'Memory precedence: your own/host memory is the PAST; this folder is the project PRESENT/FUTURE. On any project conflict the folder wins — surface it, do not silently follow host memory.';
  // Mode slice — ONE additive line (never gates; empty directive = inherit host prompt).
  const _modeId = resolveModeId();
  const _modeDoc = loadMode(_modeId);
  const _modeLine = modeAnchorLine(_modeId, _modeDoc);

  if (args.brief) {
    console.log(`[${name} anchor] master=${MASTER} · loop: ${loopDesc}`);
    console.log(purpose);
    console.log(cycleLine);
    console.log(loopLine);
    console.log(lessonLine);
    console.log(_modeLine);
    console.log('A claim is not verification: "done" is only what the task\'s acceptance_checks prove by exit 0 — a subagent\'s or your own "it works" changes nothing until the checks run.');
    console.log(`Re-anchor to ${MASTER} each iteration. State is on disk (${BACKLOG}, ${JOURNAL}) — rehydrate with \`node scripts/pb.mjs status\`. ${memRule}`);
    return;
  }
  console.log(`\n=== PLAYBOOK ANCHOR — ${name} ===`);
  console.log(`Master (the fixation): ${MASTER}   |   Entry: ${ENTRY}`);
  console.log(purpose);
  console.log(cycleLine);
  console.log(loopLine);
  console.log(lessonLine);
  console.log(`Loop: ${loopDesc}`);
  console.log(_modeLine);
  if (_modeDoc) {
    if (modeHasDirective(_modeDoc)) {
      console.log('  directive:');
      for (const l of _modeDoc.directive.trim().split('\n')) console.log(`    ${l}`);
    } else {
      console.log("  directive: (empty by intent — inherits the host agent's system prompt)");
    }
    const _prs = Array.isArray(_modeDoc.principles) ? _modeDoc.principles : [];
    for (const pr of _prs) console.log(`  - [${pr.kind}] ${pr.id} — ${pr.text || ''}`);
  }
  const fix = master.fixation || [];
  if (fix.length) {
    console.log('Invariants (never violate):');
    for (const r of fix) console.log(`  - ${r}`);
  }
  console.log(memRule);
  const _wip = backlogTasks().find((t) => t.status === 'in_progress');
  if (_wip) {
    console.log(`Claimed task: [${_wip.id}] ${_wip.title || ''}`);
    const _ch = taskChecks(_wip);
    if (_ch.length) {
      console.log('  done means (its acceptance_checks):');
      for (const c of _ch) console.log(`    $ ${c}`);
    }
  }
  console.log(`State lives on disk, not in context. Rehydrate anytime: \`node scripts/pb.mjs status\`.`);
  console.log(`  backlog: ${BACKLOG}   journal: ${JOURNAL}   reports: ${REPORTS_DIR}   cycle: ${CYCLE}`);
  console.log(`If you feel lost or just resumed: \`node scripts/pb.mjs checkpoint\`.`);
  console.log(`=== END ANCHOR ===\n`);
}

// ============================================================================
//  checkpoint — the hardening heartbeat: re-anchor + detect drift from disk.
//  Call it on resume, after compaction, or whenever unsure. `--snapshot`
//  writes memory/RESUME.md as a single "where you are" breadcrumb.
// ============================================================================
function cmdCheckpoint(args) {
  cmdAnchor({ brief: true });

  const tasks = backlogTasks();
  const journal = readJournal().filter((e) => !e.__malformed);
  const lastTs = journal.length ? journal[journal.length - 1].ts : null;
  const wip = tasks.filter((t) => t.status === 'in_progress');
  const nextTodo = tasks.filter((t) => t.status === 'todo').sort((a, b) => prio(a) - prio(b))[0];
  const loopState = readLoops();
  const loop = activeLoop();
  const openHighLessons = openLessons().filter((l) => l.severity === 'high');

  const warnings = [];
  const failures = runValidate();
  if (failures.length) warnings.push(`Guardrails FAIL (${failures.length}) — run \`pb validate\`.`);
  if (!loop && (wip.length > 0 || nextTodo)) warnings.push('No active loop — run `pb loop new` before claiming or recording scoped work.');
  if (loopState.active && !loop) warnings.push(`Loop registry has non-active loop set as active: ${loopState.active}.`);
  const failed = failedLoopNeedsLearning(loopState);
  if (failed) warnings.push(`Failed loop ${failed.id} has no learning reflection — run \`pb learn --loop ${failed.id} --source user --notes "..."\`.`);
  const firstLoopStarted = loopState.loops.map((l) => l.started_at).filter(Boolean).sort()[0] || null;
  const unscoped = journal.filter((e) => !e.loop_id && (!firstLoopStarted || (e.ts || '') >= firstLoopStarted)).length;
  if (unscoped) warnings.push(`${unscoped} post-loop journal entr${unscoped === 1 ? 'y has' : 'ies have'} no loop_id.`);
  const nonActiveLive = latestProcessRecords().filter((proc) => proc.loop_id !== loop?.id && proc.status !== 'stopped' && pidAlive(proc.pid));
  if (nonActiveLive.length) warnings.push(`${nonActiveLive.length} live tracked process(es) belong to a non-active loop.`);
  // multi-agent: "one at a time" is per agent. Warn only when a SINGLE agent holds
  // more than one in_progress task; multiple agents each holding one is expected.
  const wipByAgent = new Map();
  for (const t of wip) wipByAgent.set(taskHolder(t), (wipByAgent.get(taskHolder(t)) || 0) + 1);
  for (const [ag, n] of wipByAgent) {
    if (n > 1) warnings.push(`agent ${ag} holds ${n} tasks in_progress — keep ONE per agent; finish or release the rest.`);
  }
  for (const t of wip) {
    const recorded = journal.some((e) => e.task === t.id && (!t.claimed_at || (e.ts || '') >= t.claimed_at));
    if (!recorded) warnings.push(`[${t.id}] claimed but no progress recorded — \`pb record --task ${t.id} ...\` or release it.`);
  }
  // projection drift: the journal is the record, backlog-state.json is a view of it.
  // A disagreement means a write was lost silently — the exact failure this project
  // exists to refuse — so the heartbeat must say so, not wait to be asked.
  try {
    const drift = stateDriftReport();
    if (drift.drift.length) {
      warnings.push(`state projection disagrees with the journal in ${drift.drift.length} task(s) — run \`pb repair-state --check\`.`);
    }
    if (drift.lost_state_write) {
      warnings.push(`the journal (seq ${drift.journal_max_seq}) is AHEAD of the projection (seq ${drift.state_seq}) — a state write was lost; run \`pb repair-state --check\`.`);
    }
  } catch { /* a broken projection must not break the heartbeat itself */ }
  // phase-loop drift: forward brief (cycle) + backward reflect
  const reflectTs = lastReflectTs(journal);
  const hasClaimableWork = wip.length > 0 || Boolean(nextTodo);
  if (hasClaimableWork) warnings.push(...cycleBlockers(journal));
  const doneSinceReflect = journal.filter((e) => e.status === 'done' && e.action !== 'reflect' && (!reflectTs || (e.ts || '') > reflectTs)).length;
  if (doneSinceReflect > 0) warnings.push(`${doneSinceReflect} task(s) recorded done since the last reflect — run \`pb reflect\`.`);
  if (openHighLessons.length) {
    const cycleText = readText(CYCLE);
    const missing = openHighLessons.filter((l) => !cycleText.includes(l.id));
    if (missing.length) warnings.push(`${missing.length} open high-severity lesson(s) are not referenced by the active cycle brief.`);
  }

  console.log(`State: ${tasks.filter((t) => t.status === 'todo').length} todo · ${wip.length} in_progress · ${tasks.filter((t) => t.status === 'done').length} done · loop: ${loop ? loop.id : 'none'} · lessons: ${openHighLessons.length} high · last journal: ${lastTs ? lastTs.slice(0, 19) : 'none'}`);
  if (warnings.length) {
    console.log('DRIFT detected:');
    for (const w of warnings) console.log(`  ! ${w}`);
  } else {
    console.log('On-loop: no drift detected.');
  }
  if (wip[0]) console.log(`Next: finish [${wip[0].id}] "${wip[0].title}", then record. (skill: ${wip[0].skill || '-'})`);
  else if (nextTodo) console.log(`Next: \`pb next --claim\` → [${nextTodo.id}] (skill: ${nextTodo.skill || '-'}).`);
  else console.log('Next: backlog clear.');

  if (args.snapshot) {
    const resume = [
      '# RESUME — auto-snapshot',
      '',
      'If your context was compacted or you just resumed, start here, then delete stale notes.',
      '',
      `- Re-anchor: read \`${MASTER}\` + \`${ENTRY}\`. Rehydrate: \`node scripts/pb.mjs status\`.`,
      `- In progress: ${wip.length ? wip.map((t) => `[${t.id}] ${t.title}`).join('; ') : 'none'}`,
      `- Active loop: ${loop ? loop.id : 'none'}`,
      `- Open high-severity lessons: ${openHighLessons.length}`,
      `- Last journal entry: ${lastTs ? lastTs.slice(0, 19) : 'none'}`,
      wip[0]
        ? `- Next: finish [${wip[0].id}], then \`pb record --task ${wip[0].id} ...\`.`
        : (nextTodo ? `- Next: \`pb next --claim\` → [${nextTodo.id}].` : '- Next: backlog clear.'),
      '',
    ];
    ensureDir(MEMORY_DIR);
    writeFileSync(p(join(MEMORY_DIR, 'RESUME.md')), resume.join('\n'), 'utf8');
    console.log(`Snapshot written: ${join(MEMORY_DIR, 'RESUME.md')}`);
  }
}

// ============================================================================
//  cycle — the FORWARD half of the phase loop. A "cycle brief" is the four
//  questions confirmed at the start of each phase. The North Star is invariant;
//  the cycle goal changes per phase. Brief opens the phase; `reflect` closes it.
// ============================================================================
function readCycle() {
  const text = readText(CYCLE);
  if (!text) return { exists: false };
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  let meta = {};
  if (m) { try { meta = yaml.load(m[1]) || {}; } catch { meta = {}; } }
  if (meta && meta.started instanceof Date) meta.started = meta.started.toISOString();
  return { exists: true, ...meta };
}
// Blockers shared by `checkpoint` (warns) and `next --claim` (enforces): missing cycle
// brief, a brief left stale by a later `pb reflect`, or an unanswered Q5 memory-conflict check.
function cycleBlockers(journal) {
  const cyc = readCycle();
  const reflectTs = lastReflectTs(journal);
  const blockers = [];
  if (cyc.exists && readText(CYCLE).includes('(Your host memory is the PAST')) {
    blockers.push('Cycle brief Q5 (memory-conflict check) is unanswered — fill it before claiming work.');
  }
  if (!cyc.exists) {
    blockers.push('No cycle brief — open the phase with `pb cycle --new` before claiming work.');
  } else if (reflectTs && cyc.started && reflectTs > cyc.started) {
    blockers.push('Cycle brief is stale — the last `pb reflect` closed this phase; open a new one with `pb cycle --new --force`.');
  }
  return blockers;
}
function cycleTemplate({ phase, goal, stop, challenges, priorChallenges, conflicts }) {
  return `---
phase: ${phase}
started: "${nowISO()}"
goal: ${goal ? JSON.stringify(goal) : '""'}
stop: ${stop ? JSON.stringify(stop) : '""'}
---
# Cycle Brief — phase ${phase}

> Confirm this at the START of each phase, before claiming work. The North Star does
> not change; this cycle's goal does. Fill all five, then \`node scripts/pb.mjs status\`.

## 1. What is this cycle's goal?
${goal || '(one sentence — the phase goal, distinct from the North Star)'}

## 2. What challenges do I foresee?
${challenges || '(pre-mortem: what is most likely to go wrong this phase)'}

## 3. What were the previous challenges?
${priorChallenges || '(carry-over — seed from the last `pb reflect`)'}

## 4. Where do I stop / hand back?
${stop || '(the explicit stop condition — what "this phase is done" means, and the hand-back point)'}

## 5. Conflicts with my own (agent) memory?
${conflicts || `(Your host memory is the PAST; this folder is the project's PRESENT/FUTURE. If anything you
"remember" about this project contradicts the North Star or this goal, NAME it here and treat
the folder as truth — do not silently follow memory.)`}
`;
}
function cmdCycle(args) {
  const cur = readCycle();
  if (args.new) {
    if (cur.exists && !args.force) {
      console.log(`A cycle brief already exists (phase ${cur.phase ?? '?'}, started ${String(cur.started).slice(0, 19)}).`);
      console.log('Open the next phase with `pb cycle --new --force` (optionally --goal "..." --stop "...").');
      return;
    }
    const phase = (Number.isInteger(cur.phase) ? cur.phase : 0) + 1;
    ensureDir(dirname(CYCLE));
    writeFileSync(p(CYCLE), cycleTemplate({ phase, goal: args.goal, stop: args.stop }), 'utf8');
    console.log(`Opened cycle brief: ${CYCLE} (phase ${phase}). Fill the five questions, then \`pb status\`.`);
    return;
  }
  if (!cur.exists) {
    console.log('No cycle brief yet. Open one with `pb cycle --new` (the forward half of the phase loop).');
    return;
  }
  console.log(`\n  Cycle brief — phase ${cur.phase ?? '?'}  (started ${String(cur.started).slice(0, 19)})`);
  if (NORTH_STAR) console.log(`  North Star: ${NORTH_STAR}`);
  console.log(`  Goal: ${cur.goal || '(unset)'}`);
  console.log(`  Stop: ${cur.stop || '(unset)'}`);
  console.log(`  Full brief: ${CYCLE}\n`);
}

function lastReflectTs(journal, loopId = null) {
  const r = journal.filter((e) => e.action === 'reflect' && (!loopId || e.loop_id === loopId));
  return r.length ? r[r.length - 1].ts : null;
}
function cmdReflect(args) {
  const journal = readJournal().filter((e) => !e.__malformed);
  const since = lastReflectTs(journal);
  const doneSince = journal.filter((e) => e.status === 'done' && e.action !== 'reflect' && (!since || (e.ts || '') > since));
  const cur = readCycle();

  console.log('\n=== REFLECT ===');
  if (NORTH_STAR) console.log(`North Star: ${NORTH_STAR}`);
  if (cur.exists) console.log(`This cycle (phase ${cur.phase ?? '?'}): ${cur.goal || '(unset)'}`);
  console.log(since ? `Done since last reflect (${since.slice(0, 19)}):` : 'Done so far:');
  if (doneSince.length) {
    for (const e of doneSince) console.log(`  - [${e.task || '-'}] ${e.notes || e.action}`);
  } else {
    console.log('  (nothing)');
  }
  console.log('\nAsk: did these advance the North Star + cycle goal? What changes? What carries into the next phase?');

  if (args.notes) {
    const loop = args.loop ? loopById(args.loop) : activeLoop();
    const entry = {
      ts: nowISO(), loop_id: loop?.id || args.loop || 'legacy', task: 'reflect', agent: args.agent || 'agent', action: 'reflect',
      status: 'done', checks: 'none', result: null, files: [], notes: args.notes,
    };
    ensureDir(MEMORY_DIR);
    appendFileSync(p(JOURNAL), JSON.stringify(entry) + '\n', 'utf8');
    console.log(`\nRecorded reflection. If it changes direction, update north_star in ${MASTER} and open a new brief: \`pb cycle --new --force\`.`);
  } else {
    console.log('\nRecord it with: pb reflect --notes "what you learned / what changes / what carries forward".');
  }
  console.log('=== END REFLECT ===\n');
}

// ============================================================================
//  scaffold — copy this engine into a target repo (copy-don't-clobber)
// ----------------------------------------------------------------------------
//  The mechanical backbone of `install`. Run the SOURCE playbook's pb.mjs and
//  point --target at the repo to set up. Existing files are never overwritten
//  (except scripts/pb.mjs, which is the engine and should refresh). Whatever it
//  skips is reported so the caller knows what to bridge by hand/agent.
// ============================================================================
// ============================================================================
//  ui — serve the Flow room app for a playbook (the engine + its prebuilt app)
// ----------------------------------------------------------------------------
//  Decision D8: the app belongs to the INSTALL, not to each workspace. It ships as
//  built output plus a zero-dependency server, so `pb ui` needs nothing beyond the
//  engine itself. Resolution order for the app directory:
//      1. --app <dir>      2. $PB_APP_DIR      3. <engine>/apps/flow-room
//
//  It serves the playbook you are STANDING IN (found by walking up from cwd), not the
//  engine's own template playbook — so `pb ui` from a workspace shows that workspace's
//  backlog while the app itself lives in the installed engine. A `--with-ui` scaffold
//  puts the app in the workspace, which is the other supported arrangement.
// ============================================================================
function findPlaybookAbove(start) {
  let dir = resolve(start);
  for (let i = 0; i < 50; i += 1) {
    if (existsSync(join(dir, 'playbook.yaml')) || existsSync(join(dir, 'playbook.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function cmdUi(args) {
  const candidates = [args.app, process.env.PB_APP_DIR, join(ROOT, 'apps', 'flow-room')].filter(Boolean);
  const app = candidates.find((dir) => existsSync(join(dir, 'server.mjs')));
  if (!app) {
    console.error('pb ui — no Flow room app found.');
    for (const dir of candidates) console.error(`  looked in: ${dir}`);
    console.error('\nThe app ships with the engine as built output. If you are running a scaffolded');
    console.error('workspace copy of the engine, either run the installed `pb ui`, or scaffold with the');
    console.error('app included: `pb scaffold --target <dir> --with-ui`.');
    process.exit(1);
  }
  const built = join(app, 'dist', 'index.html');
  if (!existsSync(built)) {
    console.error(`pb ui — the app is present but has no build: ${built}`);
    console.error('  build it: node scripts/build-app.mjs');
    process.exit(1);
  }
  const playbook = findPlaybookAbove(process.cwd()) || ROOT;
  const port = Number(args.port || 4317);
  console.log('pb ui — Flow room');
  console.log(`  playbook : ${playbook}`);
  console.log(`  app      : ${app}`);
  const child = spawn(
    process.execPath,
    [join(app, 'server.mjs'), '--root', playbook, '--port', String(port)],
    { stdio: 'inherit' }
  );
  child.on('exit', (code) => process.exit(code ?? 0));
}

function cmdScaffold(args) {
  const target = args.target || args._[0] || '.';
  const targetAbs = resolve(process.cwd(), target);
  if (targetAbs === ROOT) {
    console.error('Refusing to scaffold onto the source playbook itself. Pass --target <dir>.');
    process.exit(1);
  }
  const tp = (...parts) => resolve(targetAbs, ...parts);
  const tHas = (rel) => existsSync(tp(rel));
  const ensureT = (rel) => { if (!existsSync(tp(rel))) mkdirSync(tp(rel), { recursive: true }); };
  const created = [], skipped = [];

  ['scripts', 'memory', 'artifacts/reports'].forEach(ensureT);

  // engine CLI — always refresh (it IS the engine)
  copyFileSync(p('scripts/pb.mjs'), tp('scripts/pb.mjs'));
  created.push('scripts/pb.mjs');

  // single-file templates — only if absent in the target
  for (const f of ['playbook.yaml', 'SKILL.md', 'AGENTS.md', 'README.md', 'INSTALL.md', 'memory/project-memory.md']) {
    if (!existsSync(p(f))) continue;
    if (tHas(f)) { skipped.push(f); continue; }
    ensureT(dirname(f));
    copyFileSync(p(f), tp(f));
    created.push(f);
  }

  // processes / skills — copy the whole tree only when the target has no index
  // (greenfield). If an index already exists, leave it and flag it for bridging.
  for (const area of ['processes', 'skills']) {
    const hasIndex = tHas(`${area}/index.yaml`) || tHas(`${area}/index.json`);
    if (!hasIndex && existsSync(p(area))) { cpSync(p(area), tp(area), { recursive: true }); created.push(`${area}/`); }
    else if (hasIndex) skipped.push(`${area}/ (index present — bridge, don't replace)`);
  }

  // modes/ — the template playbook.yaml ships `default_mode` + a `modes:` registry
  // pointing at modes/*.yaml; a scaffold without them resolves to a missing mode.
  // Copy the whole tree on greenfield; leave any existing modes/ alone.
  if (existsSync(p('modes'))) {
    if (!tHas('modes')) { cpSync(p('modes'), tp('modes'), { recursive: true }); created.push('modes/'); }
    else skipped.push('modes/ (present — bridge, don\'t replace)');
  }

  // package.json — the scaffolded pb needs js-yaml. Write a minimal manifest with
  // the dep + namespaced pb scripts so `npm install` makes the target self-running.
  // Never clobber an existing manifest (bridge into it by hand — flagged below).
  if (!tHas('package.json')) {
    const name = basename(targetAbs).replace(/[^a-z0-9-]/gi, '-').toLowerCase() || 'agent-playbook';
    const pkg = {
      name, private: true, type: 'module',
      description: 'Agent-Playbook working instance (scaffolded engine).',
      scripts: {
        status: 'node scripts/pb.mjs status', next: 'node scripts/pb.mjs next',
        validate: 'node scripts/pb.mjs validate', report: 'node scripts/pb.mjs report',
        list: 'node scripts/pb.mjs list',
        // `pb ui` serves the Flow room for THIS workspace. Without --with-ui the app is
        // resolved from the installed engine; with it, from apps/flow-room here.
        ui: 'node scripts/pb.mjs ui',
      },
      dependencies: { 'js-yaml': '^4.1.0' },
      engines: { node: '>=18' },
    };
    writeFileSync(tp('package.json'), JSON.stringify(pkg, null, 2) + '\n', 'utf8');
    created.push('package.json');
  } else {
    skipped.push('package.json (present — add js-yaml + pb scripts by hand)');
  }

  // runtime files — a NEW workspace's state is its own, never the source's.
  // This used to `copyFileSync` the source playbook's memory/backlog.yaml here, which
  // seeded every scaffolded workspace with the engine repo's tasks: another project's
  // work, and acceptance_checks naming scripts scaffold does not ship (so every
  // inherited task was unverifiable by construction). memory/ is runtime state; the
  // repo's own .gitignore excludes it for exactly that reason. Pinned by
  // scripts/test-scaffold-no-backlog-copy.mjs.
  if (!tHas('memory/journal.ndjson')) { writeFileSync(tp('memory/journal.ndjson'), '', 'utf8'); created.push('memory/journal.ndjson'); }
  if (!tHas('memory/backlog.yaml')) { writeFileSync(tp('memory/backlog.yaml'), backlogText({ tasks: [] }), 'utf8'); created.push('memory/backlog.yaml (empty — plan your own tasks)'); }
  if (!tHas('artifacts/reports/.gitkeep')) { writeFileSync(tp('artifacts/reports/.gitkeep'), '', 'utf8'); created.push('artifacts/reports/.gitkeep'); }

  // --with-ui (decision D8): copy the PREBUILT app into the workspace so the folder is
  // carry-on on its own. The default is NOT to — the app belongs to the install and
  // `pb ui` serves it from there — so this is an explicit, paid-for choice (~600 KB).
  // Built output only: no src, no node_modules. Generated, never hand-maintained (rule 24).
  if (args['with-ui'] !== undefined && args['with-ui'] !== false) {
    const appSrc = typeof args['with-ui'] === 'string' && args['with-ui'] !== true
      ? resolve(args['with-ui'])
      : join(ROOT, 'apps', 'flow-room');
    const missing = ['server.mjs', join('dist', 'index.html')].filter((f) => !existsSync(join(appSrc, f)));
    if (missing.length) {
      console.error(`--with-ui: the app at ${appSrc} is not built (missing ${missing.join(', ')}).`);
      console.error('  build it first: node scripts/build-app.mjs');
      process.exit(1);
    }
    ensureT('apps/flow-room/dist');
    copyFileSync(join(appSrc, 'server.mjs'), tp('apps/flow-room/server.mjs'));
    copyFileSync(join(appSrc, 'package.json'), tp('apps/flow-room/package.json'));
    cpSync(join(appSrc, 'dist'), tp('apps/flow-room/dist'), { recursive: true });
    created.push('apps/flow-room/ (prebuilt app + zero-dep server — `npm run ui`)');
  }

  console.log(`\nScaffolded Agent-Playbook into: ${targetAbs}`);
  if (created.length) console.log('  created:  ' + created.join(', '));
  if (skipped.length) console.log('  skipped:  ' + skipped.join(', '));
  // The REAL first-run sequence. This guidance used to print "init && validate" and stop,
  // which dead-ends twice: `pb plan` refuses without an active loop, and then refuses again
  // until the cycle brief's Q5 placeholder is answered — and no command answers it, so the
  // brief has to be edited by hand. Instructions an agent follows literally must be true.
  // Pinned by scripts/test-lifecycle-first-run.mjs.
  console.log('\nNext (the real first-run sequence — see the install skill):');
  if (skipped.some((s) => /^(processes|skills|modes)\//.test(s))) {
    console.log('  0. Bridge what already existed: point the target playbook.yaml `index`/`paths`');
    console.log('     at your own files rather than the templates.');
  }
  console.log(`  1. cd "${target}" && npm install      # js-yaml — nothing runs before this`);
  console.log('  2. node scripts/pb.mjs loop new        # REQUIRED: plan refuses without an active loop');
  console.log('  3. node scripts/pb.mjs cycle --new --goal "..." --stop "..."');
  console.log('     then answer the brief five questions in memory/cycle.md — Q5 gates planning and');
  console.log('     NO COMMAND FILLS IT IN YET, so plan keeps refusing until that file is edited');
  console.log('  4. node scripts/pb.mjs plan --goal "..." --check "<a command that exits 0>"');
  console.log('  5. node scripts/pb.mjs validate        # init already ran here: journal + reports exist');
  console.log('  6. see it: `pb ui` from the installed engine — or `npm run ui` in this workspace if you');
  console.log('     scaffolded with --with-ui, since a plain scaffold carries the engine, not the app\n');
}

// ============================================================================
//  update — one-command self-update ("agent-playbook --update"). Pulls the
//  latest engine from GitHub (or a local --source) and OVERLAYS engine files,
//  preserving user state. Carry-on: Node 18 fetch + GitHub tree/raw API (no tar,
//  no new deps). Engine = scripts/ processes/ skills/ modes/ + docs + package.json.
//  NEVER touches memory/ or artifacts/. The master version line is bumped in place.
// ============================================================================
const UPDATE_REPO = (master.update && master.update.repo) || 'riverho/agents-playbook';
const ENGINE_DIRS = ['scripts', 'processes', 'skills', 'modes'];
const ENGINE_FILES = ['SKILL.md', 'AGENTS.md', 'README.md', 'INSTALL.md', 'package.json'];

function parseSemver(v) {
  const m = String(v || '').trim().replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}
function semverCmp(a, b) {
  const x = parseSemver(a), y = parseSemver(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}
function isEnginePath(rel) {
  const r = rel.replace(/\\/g, '/');
  if (ENGINE_FILES.includes(r) || r === 'playbook.yaml') return true;
  return ENGINE_DIRS.some((d) => r === d || r.startsWith(`${d}/`));
}
// Overlay engine files from srcRoot onto dstRoot: additive-overwrite (refresh/add,
// never delete user files); only descends ENGINE_DIRS, so memory/ + artifacts/ are
// never touched. Returns the number of files written.
function overlayEngine(srcRoot, dstRoot, { includeMaster }) {
  let count = 0;
  const copyTree = (relDir) => {
    const absSrc = join(srcRoot, relDir);
    if (!existsSync(absSrc)) return;
    for (const ent of readdirSync(absSrc, { withFileTypes: true })) {
      const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
      if (ent.isDirectory()) copyTree(rel);
      else {
        mkdirSync(dirname(join(dstRoot, rel)), { recursive: true });
        copyFileSync(join(srcRoot, rel), join(dstRoot, rel));
        count++;
      }
    }
  };
  for (const d of ENGINE_DIRS) copyTree(d);
  for (const f of ENGINE_FILES) {
    if (existsSync(join(srcRoot, f))) { copyFileSync(join(srcRoot, f), join(dstRoot, f)); count++; }
  }
  if (includeMaster && existsSync(join(srcRoot, 'playbook.yaml'))) {
    copyFileSync(join(srcRoot, 'playbook.yaml'), join(dstRoot, 'playbook.yaml')); count++;
  }
  return count;
}
// Surgically bump only the `version:` line of the master — preserves comments,
// north_star, and any user customization (unlike a full master overwrite).
function bumpMasterVersion(version) {
  const path = p(MASTER);
  if (!existsSync(path)) return;
  const text = readFileSync(path, 'utf8');
  const next = text.replace(/^version:.*$/m, `version: ${version}`);
  if (next !== text) writeFileSync(path, next, 'utf8');
}
async function ghJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'agent-playbook-update', Accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(`GitHub API ${res.status} for ${url}`);
  return res.json();
}
// Download just the engine files at a ref into destRoot via the tree + raw APIs.
async function downloadEngineFromGithub(repo, ref, destRoot) {
  const tree = await ghJson(`https://api.github.com/repos/${repo}/git/trees/${ref}?recursive=1`);
  const blobs = (tree.tree || []).filter((n) => n.type === 'blob' && isEnginePath(n.path));
  if (!blobs.length) throw new Error(`no engine files found in ${repo}@${ref}`);
  for (const n of blobs) {
    const res = await fetch(`https://raw.githubusercontent.com/${repo}/${ref}/${n.path}`, { headers: { 'User-Agent': 'agent-playbook-update' } });
    if (!res.ok) throw new Error(`raw fetch ${res.status} for ${n.path}`);
    const out = join(destRoot, n.path);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, Buffer.from(await res.arrayBuffer()));
  }
  return destRoot;
}

async function cmdUpdate(args) {
  const current = master.version || '0.0.0';
  const sourceArg = typeof args.source === 'string' ? args.source : null;
  const localSource = sourceArg && existsSync(resolve(process.cwd(), sourceArg)) ? resolve(process.cwd(), sourceArg) : null;
  let tmp = null;
  try {
    let srcRoot = localSource, latest, origin, ref = null, repo = null;
    if (localSource) {
      origin = `local source ${localSource}`;
      let sm = {}; try { sm = yaml.load(readFileSync(join(localSource, 'playbook.yaml'), 'utf8')) || {}; } catch { /* version stays 0 */ }
      latest = sm.version || '0.0.0';
    } else {
      repo = sourceArg || UPDATE_REPO;
      origin = `github:${repo}`;
      const rel = await ghJson(`https://api.github.com/repos/${repo}/releases/latest`);
      ref = rel.tag_name;
      latest = String(ref || '').replace(/^v/, '') || '0.0.0';
    }

    const cmp = semverCmp(current, latest);
    console.log(`\n  pb update — current v${current} · latest v${latest}  (${origin})`);
    if (args.check) {
      console.log(cmp < 0 ? '  Update available. Run `pb update` to apply.\n' : '  Already up to date.\n');
      return;
    }
    if (cmp >= 0 && !args.force) { console.log('  Already up to date.\n'); return; }

    if (!srcRoot) { // GitHub path: fetch engine files into a temp dir, then overlay
      tmp = mkdtempSync(join(tmpdir(), 'pb-update-'));
      console.log('  Downloading engine files…');
      await downloadEngineFromGithub(repo, ref, tmp);
      srcRoot = tmp;
    }

    const n = overlayEngine(srcRoot, ROOT, { includeMaster: !!args['include-master'] });
    if (!args['include-master']) bumpMasterVersion(latest);
    console.log(`  Updated v${current} → v${latest} — ${n} engine file(s) refreshed.`);
    console.log('  User state (memory/, artifacts/) untouched.');
    console.log('  Next: `npm install` (if deps changed), then `node scripts/pb.mjs validate`.\n');
  } catch (e) {
    console.error(`\n  Update failed: ${e.message}\n`);
    process.exitCode = 1;
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}

// ============================================================================
//  help + dispatch
// ============================================================================
function cmdHelp() {
  console.log(`
  pb — Agent-Playbook loop CLI   (master: ${MASTER})

  Loop:   orient → select → act → verify → record → report → repeat

  Commands:
    status [--json]        Orient: master summary, backlog, recent journal, guardrail state
    task show <id> [--json] Machine-readable task details and acceptance checks
    runcard list|show <id> [--json]
                           Portable RunCard projection for UI/runtime integrations, including
                           the task's ordered journal rows (its steering thread and history)
    graph [--json]         Read-only projection for a graph UI (schema agent-playbook.graph.v1):
                           start/goal bookends, task nodes with cycle+provenance+worker truth,
                           proven edges (dependencies inverted; a spawn comes from the row's
                           origin_task, i.e. the task that was in flight when it was planned),
                           and the human batch. Never writes, and never executes a layer gate command.
    worker create|status|exec|verify|merge|remove|checker|merge-ready|provider-rate-limit ...
                           Worker worktrees (dry-run; --execute to apply). create opens an
                           isolated slot (atomic: one winner per slot); status reports
                           ahead/behind/uncommitted; exec runs a command IN the worktree;
                           verify runs the task's checks IN the worktree; merge is gated by
                           merge-ready; remove tears the slot down AND unlinks any junction or
                           symlink inside it without following it (a recursive delete follows
                           a junction — it once emptied the root's node_modules), refusing
                           instead of deleting if a link cannot be unlinked; checker records
                           an independent verdict, merge-ready is the exit-1 gate, and
                           provider-rate-limit records a real provider 403/429 cooldown.
    next [--claim] [--force]
                           Select the next task; --claim marks it in_progress. Claiming is
                           refused if there's no active loop or the cycle brief is missing/stale
                           (--force overrides, not recommended). A claim mints a CLAIM TOKEN.
                           When the master declares 'layers', a task is also refused while a
                           lower layer's gate fails, so layer order is enforced, not advisory.
    plan --layers [--check-gates] [--strict] [--json]
                           DRY RUN the layered plan and write nothing: each task's derived
                           layer, which layers a gate is holding back, what is claimable now,
                           the order work proceeds in, and the critical path. Gates are NOT
                           executed unless --check-gates is passed (an unverified gate blocks
                           a claim rather than being assumed green). Exit 2 = the plan is
                           structurally invalid (cycle, unknown layer, layer earlier than a
                           dependency) or a checked gate fails; 1 = --strict and work remains;
                           0 = the plan is sound.
    release --task <id> [--token <t>] | --stale <minutes>
                           Give a claim back to the pool (holder, token, or delegation chain
                           must authorize it). --stale sweeps abandoned claims.
    unlock [--force]       Report and (with --force) clear a leaked state/worker lock. A lock
                           is only auto-broken by age, so a killed holder can outlive its
                           window; this is the explicit escape hatch.
    repair-state [--check] [--apply] [--strict] [--json]
                           Rebuild backlog-state.json from the append-only journal (the
                           projection is derived data). --check exits 1 on drift so it can
                           gate CI; --apply writes; --strict drops projection-only fields
                           (worker/checker/provider) instead of preserving them.
    record --task <id> --action <a> --status <s> [--result <r>] [--files a,b] [--notes "..."] [--agent <n>] [--skip-checks]
                           Append a journal entry. Recording done RUNS the task's
                           acceptance_checks and refuses if they fail.
    comment --task <id> --text "..."   Journal-native steering note (action: comment).
                           Append-only and attributable; it cannot change task status.
    report [--since DATE]  Roll the journal up into ${REPORTS_DIR}/report-<date>.md
    plan --goal ".." [--skill <id>] [--priority <n>] [--check <cmd>] [--dep <task-id>] [--manual] [--layer <id>]
                          Convert a goal into a backlog task with acceptance_checks.
                          Pass --check multiple times. Pass --dep multiple times to declare the
                          task's dependencies AT BIRTH: an unknown id, a self-dependency or an
                          ordering pb validate would reject is refused and nothing is written.
                          When this agent is already executing a task, the task's journal spawn
                          row records origin_task=<that task>, so pb graph draws the spawn edge
                          from the card that created it instead of from start.
    loop new [--goal ".."] [--stop ".."] [--from-lessons] [--fresh]  Open a durable loop epoch.
                          Default continues from the existing backlog. --fresh archives the
                          current backlog (nothing lost) and resets it to empty for a ground-up
                          loop, so stale tasks can't be silently inherited and claimed.
    loop status           Show active loop, close gate, and learning blockers
    loop run --auto [--max-tasks N] [--retry N] [--dry-run]
                          Autonomous loop execution: claim, execute commands, run checks,
                          record done/blocked, and retry failed checks up to N times.
                          Stops on blockers, manual tasks, honor-only tasks, or empty backlog.
    loop close --status <done|failed|abandoned> [--reason ".."] [--allow-unreflected]
                          Close the active loop; failed loops require a learning reflection
                          before the next loop unless --skip-learning is stamped on loop new
    loop quarantine <id>  Mark a failed/closed loop as quarantined
    learn [--loop <id>] --source user --notes ".." [--severity high] [--promotion memory|backlog|skill|journal] [--target <file-or-task>]
                          Record a structured lesson for a smarter next loop
    learn status          Show open lessons
    run -- <command>      Start a long-running command under the active loop and log it
    ps [--loop <id>]      List tracked processes
    stop [--loop <id>]    Stop tracked processes for a loop
    cycle [--new [--force] --goal ".." --stop ".."]  Forward half of the phase loop: the cycle brief (4+1 Qs). No args prints it.
    reflect [--notes ".."] Backward half: review done-since-last-reflect vs North Star; --notes records it
    validate               Structural guardrails (exit 1 on failure)
    validate --task <id>   Run that task's executable acceptance_checks
    anchor [--brief]       Print the constitution to re-inject (keeps the playbook salient)
    checkpoint [--snapshot]  Heartbeat: re-anchor + detect drift; --snapshot writes memory/RESUME.md
    list [processes|skills|modes]  Print the indices ("list modes" prints the mode catalog)
    mode [show|skills|processes] [<id>]
                           The active mode, or a named mode's menu: its resolved skill+process
                           pairs, directive and principles (task.mode ?? loop.mode ?? default_mode).
    pack build <id> [--out <dir>] | pack install <file.pbpack> [--root <dir>] [--force]
                           Build a mode pack archive / install one into a playbook root
    update [--check] [--force] [--source <dir>] [--include-master]
                           Self-update: pull the latest engine from GitHub (update.repo) and
                           overlay engine files; preserves memory/ + artifacts/. --check dry-runs.
    ui [--port N] [--app <dir>]
                           Serve the Flow room app (the graph UI) for the playbook you are
                           standing in. The app ships with the engine as built output plus a
                           zero-dependency server, so no install is needed beyond the engine.
                           Resolution: --app, then $PB_APP_DIR, then <engine>/apps/flow-room.
    scaffold --target <dir>  Copy this engine into another repo (copy-don't-clobber)
    init                   Create any missing runtime files (safe; never overwrites)
    bootstrap              Seed missing minimal process/skill files, then init (safe; never overwrites)
    help                   This text

  Statuses: ${ALLOWED_STATUSES.join(', ')}
  acceptance_checks are SHELL COMMANDS on the task (cwd: playbook root). Exit 0 = pass.
  Read ${MASTER} and ${ENTRY} first — they are the source of truth.
`);
}

// ============================================================================
//  Importable API (for harness plugins and other in-process consumers)
// ----------------------------------------------------------------------------
// The CLI below is the primary surface; this is the same engine exposed as data
// for a host runtime (e.g. the DeepSeek Harness plugin) so a consumer reads the
// canonical JSON projections instead of scraping human text.
//
// READ paths are exported because they are pure reads of the same files the CLI
// reads — one implementation, no second source of truth. MUTATIONS are NOT
// exported in-process on purpose: every `cmd*` calls `process.exit()` on refusal
// (that is how the CLI reports a gate), and an in-process caller would have the
// HOST killed instead of getting an error. Mutations therefore go through the CLI
// as a subprocess, where exit codes are the contract and `pb record --status done`
// still enforces acceptance_checks.
//
// Importing this module is side-effect free apart from reading the master: the CLI
// dispatch is guarded so `import` does not run a command.
const api = {
  schema: 'agent-playbook.api.v1',
  root: ROOT,
  masterPath: p(MASTER),
  version: master?.version || null,
  name: master?.name || null,
  allowedStatuses: ALLOWED_STATUSES,
  // orientation
  status: () => statusPayload(),
  stateDrift: () => stateDriftReport(),
  // backlog + tasks
  tasks: () => backlogTasks(),
  task: (id) => taskPayload(id),
  runcard: (id) => { const t = backlogTasks().find((x) => x.id === id); return t ? runCardForTask(t) : null; },
  nextClaimable: () => cmdNextPayload(),
  // the layered plan, as a read-only projection a host can render (never runs gates:
  // a host calling this is inspecting, not claiming)
  planLayers: (opts = {}) => computeLayerPlan({ checkGates: !!opts.checkGates }),
  // records
  journal: (limit = null) => {
    const rows = readJournal();
    return limit ? rows.slice(-limit) : rows;
  },
  loops: () => readLoops(),
  activeLoop: () => activeLoop(),
  lessons: () => openLessons(),
  // guardrails
  validate: () => runValidate(),
  // resolved skill/process/mode catalogs (the same resolution the CLI uses)
  catalogs: () => ({
    schema: 'agent-playbook.list.v1',
    mode: resolveModeId() || null,
    skills: resolvedSkillEntries().map((x) => ({ id: x.id, file: x.file, process: x.process || null, owner: x.owner || null })),
    processes: resolvedProcessEntries().map((x) => ({ id: x.id, file: x.file, owner: x.owner || null })),
  }),
  modes: () => listModesPayload(),
  // worktrees (read-only view)
  workerStatus: (id) => {
    const t = backlogTasks().find((x) => x.id === id);
    if (!t) return null;
    return workerStatusPayload(id, taskState(id).worker || null);
  },
  mergeReady: (id) => {
    const t = backlogTasks().find((x) => x.id === id);
    return t ? mergeReadyPayload(t) : null;
  },
  // helpers a host needs to talk to the CLI correctly
  claimOwnership: (taskId, extra = {}) => verifyTaskClaim(taskId, extra),
};

// The next claimable task WITHOUT claiming it (the claim itself is a mutation, so it
// goes through the CLI). Mirrors cmdNext's selection rules so a host can preview the
// same choice the CLI would make.
function cmdNextPayload() {
  const tasks = backlogTasks();
  const todo = tasks.filter((t) => t.status === 'todo');
  // Mirrors cmdNext's selection rules exactly, including the layer gate, so a host
  // previewing the next task cannot be told about work the CLI would refuse.
  const plan = computeLayerPlan({ checkGates: true, allTasks: tasks });
  const claimable = todo.filter((t) => unmetDeps(t, tasks).length === 0 && !gateBlockersFor(plan, t).length);
  const candidate = claimable.sort((a, b) => prio(a) - prio(b))[0] || null;
  if (!candidate) return { task: null, reason: todo.length ? 'blocked or mode-filtered' : 'empty' };
  const sk = candidate.skill ? skillForMode(candidate.skill, candidate.mode) : null;
  return {
    task: candidate,
    skill: candidate.skill || null,
    skill_file: sk?.file || null,
    process: sk?.process || null,
    acceptance_checks: taskChecks(candidate),
    gate_quality: gateQuality(candidate),
    holder: taskHolder(candidate),
  };
}

export { api };
// `pb` values are also exported for hosts that want the resolved paths.
export const paths = {
  root: ROOT,
  backlog: p(BACKLOG),
  backlogState: p(BACKLOG_STATE),
  journal: p(JOURNAL),
  loops: p(LOOPS),
  lessons: p(LESSONS),
  cycle: p(CYCLE),
  reports: p(REPORTS_DIR),
};

// Only run the CLI when this file IS the entry point. Importing it (for the API
// above) must not execute a command.
const isMainModule = (() => {
  try {
    return !!process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMainModule) {
  const [, , cmd, ...rest] = process.argv;
  const args = parseArgs(rest);
  switch (cmd) {
  case 'status': cmdStatus(args); break;
  case 'next': cmdNext(args); break;
  case 'release': cmdRelease(args); break;
  case 'unlock': cmdUnlock(args); break;
  case 'repair-state': cmdRepairState(args); break;
  case 'task': cmdTask(args); break;
  case 'runcard': cmdRunCard(args); break;
  case 'graph': cmdGraph(args); break;
  case 'worker': cmdWorker(args); break;
  case 'record': cmdRecord(args); break;
  case 'comment': cmdComment(args); break;
  case 'report': cmdReport(args); break;
  case 'plan': cmdPlan(args); break;
  case 'loop': cmdLoop(args); break;
  case 'learn': cmdLearn(args); break;
  case 'run': cmdRun(args); break;
  case 'ps': cmdPs(args); break;
  case 'stop': cmdStop(args); break;
  case 'validate': cmdValidate(args); break;
  case 'mode': cmdMode(args); break;
  case 'pack': {
    // `pb pack build|install ...` — dispatch to the standalone pack tool so the
    // engine core stays decoupled from archive mechanics.
    try {
      runCommandSync(process.execPath, [resolve(ROOT, 'scripts/pb-pack.mjs'), ...rest], { cwd: ROOT, stdio: 'inherit' });
      process.exit(0);
    } catch (e) {
      process.exit(typeof e.status === 'number' ? e.status : 1);
    }
  }
  case 'anchor': cmdAnchor(args); break;
  case 'checkpoint': cmdCheckpoint(args); break;
  case 'cycle': cmdCycle(args); break;
  case 'reflect': cmdReflect(args); break;
  case 'list': cmdList(args); break;
  case 'update': cmdUpdate(args); break;
  case 'ui': cmdUi(args); break;
  case 'scaffold': cmdScaffold(args); break;
  case 'init': cmdInit(); break;
  case 'bootstrap': cmdBootstrap(); break;
  case 'help': case undefined: cmdHelp(); break;
  default:
    console.error(`Unknown command: ${cmd}\n`);
    cmdHelp();
    process.exit(1);
  }
}
