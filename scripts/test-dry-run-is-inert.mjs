// ============================================================================
//  scripts/test-dry-run-is-inert.mjs
// ----------------------------------------------------------------------------
// `--dry-run` must WRITE NOTHING. That is the whole contract, and a command that accepts
// the flag without honouring it is worse than one that rejects it: the caller believes
// they took a safe look, and the action lands. `pb version close --dry-run` CLOSED the
// version — a state change that cannot be undone by re-running, on the one verb whose
// entire purpose is "show me what would happen".
//
// HOW IT SURVIVED: the flag is parsed generically (`args['dry-run']` is just another key),
// so any command that does not explicitly read it accepts it silently. Three commands read
// it (tick, release --stale, loop run --auto); the version verb — which closes versions,
// opens drafts, carries cards and moves tasks between them — read it nowhere.
//
// WHAT MUST BE TRUE:
//   1. `version close --dry-run` closes NOTHING and says what it would have done.
//   2. Exit 0 — a dry run is a successful look, not a failure.
//   3. `version open --dry-run` opens nothing.
//   4. Every command that DOES honour --dry-run still writes nothing (regression guard).
//   5. A command that does not implement --dry-run must REFUSE it, never ignore it.
//      (This is the durable half: the next flag added to the parser cannot silently
//      become a no-op just because some command forgot to read it.)
// ============================================================================

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
let fail = 0;
function ok(label, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ok   ${label}`); }
  else { fail += 1; console.log(`  FAIL ${label}${detail ? `\n       ${String(detail).replace(/\n/g, '\n       ').slice(0, 700)}` : ''}`); }
}

const pb = (cwd, args) => {
  const r = spawnSync(process.execPath, [join(cwd, 'scripts', 'pb.mjs'), ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, PB_AGENT_ID: 'fixture' },
  });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
};
const loops = (cwd) => readFileSync(join(cwd, 'memory', 'loops.yaml'), 'utf8');
const journal = (cwd) => readFileSync(join(cwd, 'memory', 'journal.ndjson'), 'utf8');
const backlogState = (cwd) => { try { return readFileSync(join(cwd, 'memory', 'backlog-state.json'), 'utf8'); } catch { return ''; } };

/**
 * A fixture playbook. `withLoop` opens a loop epoch — needed by the CLAIM path, but
 * mutually exclusive with a version (a versioned playbook refuses `loop new` with V1), so
 * the version tests and the claim tests each build the fixture they need.
 */
function makeFixture({ withLoop = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pb-dryrun-'));
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, 'memory'), { recursive: true });
  for (const f of ['scripts/pb.mjs', 'AGENTS.md', 'SKILL.md', 'README.md', 'INSTALL.md', 'package.json']) {
    const src = join(ROOT, f);
    if (existsSync(src)) cpSync(src, join(dir, f), { recursive: true });
  }
  const dep = join(ROOT, 'node_modules', 'js-yaml');
  if (existsSync(dep)) {
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    cpSync(dep, join(dir, 'node_modules', 'js-yaml'), { recursive: true });
  }
  writeFileSync(join(dir, 'playbook.yaml'), readFileSync(join(ROOT, 'playbook.yaml'), 'utf8')
    .replace(/^[ \t]*stop_when:.*\r?\n?/gm, '').replace(/^[ \t]*stop_action:.*\r?\n?/gm, ''), 'utf8');
  // `pb init` only writes a placeholder backlog when one is MISSING, so write a real task
  // here rather than depending on the placeholder (whose id is not guaranteed).
  writeFileSync(join(dir, 'memory', 'backlog.yaml'), [
    'tasks:',
    '  - id: T1',
    "    title: 'a task to sweep'",
    '    status: todo',
    '    skill: run-task',
    '    priority: 1',
    '    acceptance_checks: ["node -e \\"process.exit(0)\\""]',
    '',
  ].join('\n'), 'utf8');
  execFileSync(process.execPath, [join(dir, 'scripts', 'pb.mjs'), 'init'], { cwd: dir, encoding: 'utf8' });
  execFileSync(process.execPath, [join(dir, 'scripts', 'pb.mjs'), 'bootstrap'], { cwd: dir, encoding: 'utf8' });
  // An ACTIVE LOOP is required by the claim path — and is mutually exclusive with a version
  // (a versioned playbook refuses `loop new`: V1). So only the fixtures that claim turn it on.
  if (withLoop) {
    execFileSync(process.execPath, [join(dir, 'scripts', 'pb.mjs'), 'loop', 'new', '--goal', 'fixture', '--stop', 'fixture done'],
      { cwd: dir, encoding: 'utf8', env: { ...process.env, PB_AGENT_ID: 'fixture' } });
    const cp = join(dir, 'memory', 'cycle.md');
    writeFileSync(cp, readFileSync(cp, 'utf8')
      .replace(/\(Your host memory is the PAST[\s\S]*?memory\.\)/, 'NONE — scratch fixture for a test.'), 'utf8');
  }
  return dir;
}

// ---------------------------------------------------------------------------
// 1. `version close --dry-run` must close NOTHING.
// ---------------------------------------------------------------------------
{
  const dir = makeFixture();
  try {
    const newV = pb(dir, ['version', 'new', '--name', 'v1', '--goal', 'g', '--stop-check', 'node -e "process.exit(0)"']);
    ok('the fixture opens a version', newV.code === 0, newV.out.slice(0, 300));

    const loopsBefore = loops(dir);
    const journalBefore = journal(dir);
    const r = pb(dir, ['version', 'close', '--dry-run']);

    ok('version close --dry-run exits 0 (a dry run is a successful look, not a failure)',
      r.code === 0, `code=${r.code}\n${r.out.slice(0, 400)}`);
    ok('version close --dry-run does NOT close the version (loops.yaml unchanged)',
      loops(dir) === loopsBefore, `loops.yaml changed:\n       ${loops(dir).slice(0, 300)}`);
    ok('version close --dry-run writes NO journal row', journal(dir) === journalBefore);
    ok('version close --dry-run says what it would have done',
      /dry-run|would/i.test(r.out), r.out.slice(0, 400));
    // The version really is still open — proven through the engine, not just the file.
    const list = pb(dir, ['version', 'list', '--json']);
    let open = null;
    try { open = JSON.parse(list.out.slice(list.out.indexOf('{'))).versions.find((v) => v.state === 'open'); } catch { /* asserted */ }
    ok('the version is still open after the dry run', Boolean(open), list.out.slice(0, 300));

    // And the REAL close still works (the dry run must not have disabled the verb).
    const real = pb(dir, ['version', 'close']);
    ok('the real version close still closes', real.code === 0, real.out.slice(0, 300));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------------------
// 2. `version open --dry-run` must open nothing.
// ---------------------------------------------------------------------------
{
  const dir = makeFixture();
  try {
    pb(dir, ['version', 'new', '--draft', '--name', 'v2', '--goal', 'g', '--stop-check', 'node -e "process.exit(0)"']);
    const before = loops(dir);
    const journalBefore = journal(dir);
    const r = pb(dir, ['version', 'open', '--name', 'v2', '--dry-run']);
    ok('version open --dry-run exits 0', r.code === 0, `code=${r.code}\n${r.out.slice(0, 300)}`);
    ok('version open --dry-run opens nothing (loops.yaml unchanged)',
      loops(dir) === before, `loops.yaml changed:\n       ${loops(dir).slice(0, 300)}`);
    ok('version open --dry-run writes NO journal row', journal(dir) === journalBefore);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------------------
// 3. Commands that ALREADY honour --dry-run must keep honouring it. These are the
//    regression guards: the fix must not be "read the flag in version and forget
//    the others".
// ---------------------------------------------------------------------------
{
  const dir = makeFixture({ withLoop: true });
  try {
    // The `init` placeholder task is T1; claim it so there is a real claim to sweep.
    const claim = pb(dir, ['next', '--claim']);
    const id = /\[([^\]]+)\]/.exec(claim.out)?.[1] || null;
    ok('the fixture has a claimable task', Boolean(id) && /Claimed/.test(claim.out), claim.out.slice(0, 300));
    const st = JSON.parse(backlogState(dir));
    st[id] = { ...st[id], status: 'in_progress', claimed_by: 'dead-session',
      claim_token: 't', claimed_at: new Date(Date.now() - 3 * 3600_000).toISOString() };
    writeFileSync(join(dir, 'memory', 'backlog-state.json'), JSON.stringify(st, null, 2), 'utf8');
    const before = backlogState(dir);
    const beforeJ = journal(dir);
    const r = pb(dir, ['release', '--stale', '30', '--dry-run']);
    ok('release --stale --dry-run still writes nothing', backlogState(dir) === before && journal(dir) === beforeJ, r.out.slice(0, 300));
    ok('release --stale --dry-run still reports what it would do', /dry-run|would release/i.test(r.out), r.out.slice(0, 300));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------------------
// 4. THE DURABLE HALF: a command that does not implement --dry-run must REFUSE it.
//    The bug existed because the flag is parsed generically, so any command silently
//    accepted a flag it never read. A guard turns "forgot to implement" from a silent
//    destructive no-op into a visible refusal.
// ---------------------------------------------------------------------------
{
  const dir = makeFixture();
  try {
    const before = journal(dir);
    // `pb status` takes no --dry-run and has nothing to promise: it must refuse rather
    // than accept a safety flag it cannot honour.
    const r = pb(dir, ['status', '--dry-run']);
    ok('a read-only command refuses a --dry-run it does not implement',
      r.code !== 0 && /dry-run/i.test(r.out), `code=${r.code}\n${r.out.slice(0, 300)}`);
    ok('…and the refusal names the flag', /--dry-run/.test(r.out), r.out.slice(0, 300));
    ok('…and nothing was written', journal(dir) === before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

console.log(`\ntest-dry-run-is-inert: ${pass} pass, ${fail} fail`);
if (fail) process.exit(1);
