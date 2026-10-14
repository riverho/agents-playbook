// ============================================================================
//  scripts/test-release-blocked-card.mjs
// ----------------------------------------------------------------------------
// A DEADLOCK: a `blocked` card can hold a claim token it can never shed — and then no
// documented path can carry, drop, or release it.
//
//   pb version carry <id>   → "V6: Release the active claim before carrying or dropping its card"
//   pb version drop  <id>   → the same refusal
//   pb release --task <id>  → "is blocked, not in_progress — nothing to release"
//   pb release --stale N    → scanned only in_progress, so it never saw the card
//
// The two guards contradicted each other: carry/drop refuse while a token exists, and the
// only command that clears a token refused to look at a blocked card. `--force` existed on
// `release` but was unreachable — the status check exited before the ownership check ran.
//
// THE ROOT CAUSE is the JOURNAL REPLAY, not `release`. `pb record --status blocked` clears
// the claim correctly, but `rebuildStateFromJournal` treated a terminal status as "set the
// status and move on": it never cleared the claim fields, so the token from the earlier
// `claim` row SURVIVED the rebuild and was re-attached to a card the same journal says is
// blocked. `repair-state --apply` — the documented recovery for exactly that kind of state
// disagreement — is what manufactured it.
//
// (Observed on a real card: plan-20261010-007, claimed seq 333, blocked seq 334; a later
// rebuild re-attached the token and it was unclearable from 12 Oct onward.)
//
// This is the same defect class as the endless loop this project just fixed: a state the
// system can ENTER but not EXIT.
//
// WHAT MUST BE TRUE AFTER THE FIX:
//   1. A terminal row CLEARS the claim in the replay; live and rebuilt state agree.
//   2. `pb release` clears a claim on a card in ANY status, and reports what it did.
//   3. Releasing does NOT un-block the card: a claim is orthogonal to status.
//   4. The stale sweep reaches an abandoned claim on a blocked card.
//   5. A card ALREADY stuck on disk (the pre-fix shape) is rescuable.
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
const stateOf = (cwd, id) => {
  try { return JSON.parse(readFileSync(join(cwd, 'memory', 'backlog-state.json'), 'utf8'))[id] || {}; } catch { return {}; }
};
const readState = (cwd) => JSON.parse(readFileSync(join(cwd, 'memory', 'backlog-state.json'), 'utf8'));
const writeState = (cwd, obj) => writeFileSync(join(cwd, 'memory', 'backlog-state.json'), JSON.stringify(obj, null, 2), 'utf8');

/**
 * A minimal playbook fixture: the REAL engine, an empty backlog, an empty journal.
 *
 * Deliberately NO version. The version machinery adds a second, unrelated guard
 * (`versionWriteGuard`) whose refusals would mask the defect under test — and the deadlock
 * is reachable without it, because the carry/drop refusal and the release refusal are plain
 * status/token checks. Keeping the fixture version-free means a failure here is the deadlock
 * and nothing else.
 */
function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'pb-release-blocked-'));
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
  // Strip the real stop_when: the fixture must not run this repository's phase gate.
  writeFileSync(join(dir, 'playbook.yaml'), readFileSync(join(ROOT, 'playbook.yaml'), 'utf8')
    .replace(/^[ \t]*stop_when:.*\r?\n?/gm, '').replace(/^[ \t]*stop_action:.*\r?\n?/gm, ''), 'utf8');
  writeFileSync(join(dir, 'memory', 'backlog.yaml'), [
    'tasks:',
    '  - id: T1',
    "    title: 'a card that gets blocked while claimed'",
    '    status: todo',
    '    skill: run-task',
    '    priority: 1',
    '    acceptance_checks: ["node -e \\"process.exit(0)\\""]',
    '',
  ].join('\n'), 'utf8');
  writeFileSync(join(dir, 'memory', 'journal.ndjson'), '', 'utf8');
  writeFileSync(join(dir, 'memory', 'cycle.md'),
    '---\nphase: 1\nstarted: "2026-01-01T00:00:00.000Z"\n---\n# brief\nAnswered — no conflict with my memory.\n', 'utf8');

  execFileSync(process.execPath, [join(dir, 'scripts', 'pb.mjs'), 'init'], { cwd: dir, encoding: 'utf8' });
  execFileSync(process.execPath, [join(dir, 'scripts', 'pb.mjs'), 'bootstrap'], { cwd: dir, encoding: 'utf8' });
  execFileSync(process.execPath, [join(dir, 'scripts', 'pb.mjs'), 'loop', 'new', '--goal', 'fixture loop', '--stop', 'fixture done'],
    { cwd: dir, encoding: 'utf8', env: { ...process.env, PB_AGENT_ID: 'fixture' } });
  // `loop new` reseeds the brief; answer Q5 (the claim path refuses while it is a placeholder).
  const cp = join(dir, 'memory', 'cycle.md');
  writeFileSync(cp, readFileSync(cp, 'utf8')
    .replace(/\(Your host memory is the PAST[\s\S]*?memory\.\)/, 'NONE — scratch fixture for a test.'), 'utf8');
  return dir;
}

/** Claim T1 then record it blocked — the ordinary sequence that leads to the defect. */
function claimThenBlock(dir) {
  const claim = pb(dir, ['next', '--claim']);
  const blocked = pb(dir, ['record', '--task', 'T1', '--action', 'blocked', '--status', 'blocked', '--notes', 'waiting on a dependency', '--skip-checks']);
  return { claim, blocked };
}

// ---------------------------------------------------------------------------
// 1. THE ROOT CAUSE: the replay must not resurrect a claim on a terminal card.
// ---------------------------------------------------------------------------
{
  const dir = makeFixture();
  try {
    const { claim, blocked } = claimThenBlock(dir);
    ok('the fixture claims T1', /Claimed \[T1\]/.test(claim.out), claim.out.slice(0, 400));
    ok('T1 records as blocked', blocked.code === 0 && !/V[0-9]:/.test(blocked.out), blocked.out.slice(0, 400));
    ok('recording blocked clears the HOLDER in LIVE state (nobody is working on it)',
      !stateOf(dir, 'T1').claimed_by && !stateOf(dir, 'T1').claimed_at, JSON.stringify(stateOf(dir, 'T1')));
    // The issued TOKEN deliberately stays: it is attribution, not a claim. A blocked card is
    // still written to afterwards (progress notes, comments), and those writers prove
    // themselves with the token they were issued — clearing it broke exactly that, caught by
    // test-claim-token-chain. What must NOT survive is the HOLDER, because "is it held?" is
    // what carry/drop and `pb next` key on.
    ok('…and keeps the issued token as attribution (it is proof of authorship, not a claim)',
      Boolean(stateOf(dir, 'T1').claim_token), JSON.stringify(stateOf(dir, 'T1')));

    pb(dir, ['repair-state', '--apply']);
    const after = stateOf(dir, 'T1');
    ok('a rebuilt projection does NOT resurrect the HOLDER on a blocked card',
      !after.claimed_by && !after.claimed_at, `rebuild re-attached a holder to a blocked card: ${JSON.stringify(after)}`);
    ok('the rebuilt card is still blocked (the status survived)', after.status === 'blocked', JSON.stringify(after));
    const chk = pb(dir, ['repair-state', '--check']);
    ok('live state and replayed state agree (repair-state --check clean)', chk.code === 0, chk.out.slice(0, 300));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------------------
// 2. THE ESCAPE HATCH: `release` must clear a claim on a card in ANY status.
//    The card is forced into the PRE-FIX stuck shape, because a real workspace
//    already holds cards in exactly that state.
// ---------------------------------------------------------------------------
{
  const dir = makeFixture();
  try {
    claimThenBlock(dir);
    // Force the stuck shape: blocked + a lingering token, as a pre-fix rebuild leaves it.
    const st = readState(dir);
    st.T1 = { ...st.T1, status: 'blocked', claimed_by: 'dead-session', agent_id: 'dead-session',
      claim_token: 'stale-token-abc', claim_token_issued_at: '2026-01-01T00:00:00.000Z', claimed_at: '2026-01-01T00:00:00.000Z' };
    writeState(dir, st);
    ok('a stuck card is reproduced (blocked + a HOLDER)', Boolean(stateOf(dir, 'T1').claimed_by), JSON.stringify(stateOf(dir, 'T1')));

    const rel = pb(dir, ['release', '--task', 'T1']);
    ok('pb release clears the claim on a BLOCKED card (the escape hatch exists)',
      !/not in_progress/.test(rel.out), rel.out.slice(0, 400));
    ok('release reports what it did rather than silently no-op-ing', /Released/i.test(rel.out), rel.out.slice(0, 400));
    ok('the HOLDER is gone after release', !stateOf(dir, 'T1').claimed_by && !stateOf(dir, 'T1').claimed_at, JSON.stringify(stateOf(dir, 'T1')));
    ok('releasing does NOT un-block the card (claim and status are orthogonal)',
      stateOf(dir, 'T1').status === 'blocked', JSON.stringify(stateOf(dir, 'T1')));

    // The deadlock's real symptom: carry/drop were refused while a HOLDER existed.
    const after = readState(dir);
    ok('the card is now carryable (no lingering holder to refuse on)',
      !after.T1.claimed_by, JSON.stringify(after.T1));

    // A second release with no claim must be an honest no-op, not a fake write.
    const journalBefore = readFileSync(join(dir, 'memory', 'journal.ndjson'), 'utf8');
    const again = pb(dir, ['release', '--task', 'T1']);
    ok('releasing an already-released card is an honest no-op',
      /nothing to release/i.test(again.out), again.out.slice(0, 300));
    ok('…and it wrote no journal row claiming otherwise',
      readFileSync(join(dir, 'memory', 'journal.ndjson'), 'utf8').length === journalBefore.length);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------------------
// 3. The stale sweep must reach an abandoned claim on a BLOCKED card. A card
//    blocked and then abandoned is exactly what a human wants swept.
// ---------------------------------------------------------------------------
{
  const dir = makeFixture();
  try {
    claimThenBlock(dir);
    const st = readState(dir);
    st.T1 = { ...st.T1, status: 'blocked', claimed_by: 'dead-session',
      claim_token: 'stale-2', claimed_at: new Date(Date.now() - 3 * 3600_000).toISOString() };
    writeState(dir, st);

    const dry = pb(dir, ['release', '--stale', '30', '--dry-run']);
    ok('the stale sweep SEES an abandoned claim on a blocked card',
      /would release \[T1\]/.test(dry.out), dry.out.slice(0, 400));
    const sweep = pb(dir, ['release', '--stale', '30']);
    ok('the stale sweep releases it, and the token is gone',
      /Released [1-9]/.test(sweep.out) && !stateOf(dir, 'T1').claim_token, sweep.out.slice(0, 400));
    ok('the swept card is still blocked (the sweep clears claims, not statuses)',
      stateOf(dir, 'T1').status === 'blocked', JSON.stringify(stateOf(dir, 'T1')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------------------
// 4. A claim on an in_progress card still requires proof of ownership — the
//    loosening above must not have opened a way to steal a live claim.
//    AND releasing live work must return it to the POOL (`todo`), or the card is
//    orphaned: claimed by nobody, still marked as being worked on, and invisible
//    to `pb next --claim`. That contract is pinned by test-concurrency-state, and
//    an early version of this fix broke it by preserving the status universally.
// ---------------------------------------------------------------------------
{
  const dir = makeFixture();
  try {
    const claim = pb(dir, ['next', '--claim']);
    const token = /claim token:\s*(\S+)/i.exec(claim.out)?.[1] || null;
    ok('T1 is in_progress and holds a token', stateOf(dir, 'T1').status === 'in_progress' && Boolean(stateOf(dir, 'T1').claim_token),
      JSON.stringify(stateOf(dir, 'T1')));
    // A different writer, with no token and no chain, must still be refused.
    const other = spawnSync(process.execPath, [join(dir, 'scripts', 'pb.mjs'), 'release', '--task', 'T1'],
      { cwd: dir, encoding: 'utf8', env: { ...process.env, PB_AGENT_ID: 'a-different-agent', PB_CLAIM_TOKEN: '' } });
    const out = `${other.stdout || ''}${other.stderr || ''}`;
    ok('a live in_progress claim is still protected from an unrelated writer',
      other.status !== 0 || /Refusing to release/i.test(out), out.slice(0, 400));
    ok('…and the claim survived the refused attempt', Boolean(stateOf(dir, 'T1').claim_token), JSON.stringify(stateOf(dir, 'T1')));

    // The holder releases its own live claim: the card must go back to the pool.
    const rel = pb(dir, ['release', '--task', 'T1', '--token', token]);
    ok('the holder can release its live claim', rel.code === 0, rel.out.slice(0, 300));
    ok('releasing LIVE work returns the card to `todo` (not orphaned in_progress)',
      stateOf(dir, 'T1').status === 'todo', JSON.stringify(stateOf(dir, 'T1')));
    ok('…with the claim cleared', !stateOf(dir, 'T1').claim_token && !stateOf(dir, 'T1').claimed_by, JSON.stringify(stateOf(dir, 'T1')));
    ok('…so it is claimable again', /Claimed \[T1\]/.test(pb(dir, ['next', '--claim']).out));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------------------
// 5. The stale sweep returns LIVE work to the pool too — same rule, same reason.
// ---------------------------------------------------------------------------
{
  const dir = makeFixture();
  try {
    pb(dir, ['next', '--claim']);
    const st = readState(dir);
    st.T1 = { ...st.T1, status: 'in_progress', claimed_by: 'dead-session',
      claim_token: 'stale-3', claimed_at: new Date(Date.now() - 3 * 3600_000).toISOString() };
    writeState(dir, st);
    pb(dir, ['release', '--stale', '30']);
    ok('a swept in_progress claim returns the card to `todo`',
      stateOf(dir, 'T1').status === 'todo', JSON.stringify(stateOf(dir, 'T1')));
    ok('…with the claim cleared', !stateOf(dir, 'T1').claim_token, JSON.stringify(stateOf(dir, 'T1')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

console.log(`\ntest-release-blocked-card: ${pass} pass, ${fail} fail`);
if (fail) process.exit(1);
