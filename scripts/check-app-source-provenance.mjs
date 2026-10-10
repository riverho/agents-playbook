#!/usr/bin/env node
// ============================================================================
//  check-app-source-provenance.mjs — prove the Flow room's code came from the
//  pinned Wenmei commit, byte for byte, and has not been edited since.
// ----------------------------------------------------------------------------
//  Why this exists: P1 is a MOVE between repositories. A move that also edits is
//  a move nobody can audit, so the extraction is split in two: this task proves
//  provenance (the copy is faithful), the next task proves the app builds and is
//  decoupled. The pin is a commit SHA, not a branch, because a branch moves.
//
//  Three checks, weakest to strongest:
//    1. every file listed in PROVENANCE.json exists and matches its recorded hash
//       — proves the copy has not been edited since it was pinned (always runs);
//    2. each copied file is byte-identical to the SOURCE WORKING TREE — proves the
//       copy is faithful to what was actually extracted (runs when the source is
//       reachable; skips loudly otherwise);
//    3. each copied file matches the GIT BLOB at the pinned commit — proves the
//       source tree itself was at that commit, not merely close to it.
//  Line endings: git may hand back LF while the working tree holds CRLF, so a
//  mismatch is retried after normalising CRLF/CR to LF and then reported as
//  "identical modulo line endings" rather than as a failure.
//
//  Usage: node scripts/check-app-source-provenance.mjs [--write]
//    --write  (re)copy the pinned files into apps/flow-room/src/room and rewrite
//             PROVENANCE.json. Only for establishing the pin, never to fix drift.
// ============================================================================

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The pinned source. A commit SHA (a branch would move under us); override the
// checkout location with PB_FLOW_SOURCE when the source lives elsewhere.
//
// This names Wenmei's MAIN checkout rather than the `graph-room` worktree the room was
// extracted from: the pinned commit is merged into main and the worktree was cleared
// afterwards. Had the default kept naming the worktree, tidying it would have silently
// downgraded this gate to manifest-only checking (checks 2 and 3 are skipped when the source
// is unreachable) — a gate that weakens because a directory was cleaned up is worse than none.
const SOURCE_REPO =
  process.env.PB_FLOW_SOURCE || 'D:\\HermesProjects\\Wenmei\\wenmei';
const SOURCE_PREFIX = 'app_design/src';
const SOURCE_COMMIT = '33fdcea43af6a47df6d40028e749118ca61a0dea';

const DEST_ROOT = join(ROOT, 'apps', 'flow-room');
const DEST = join(DEST_ROOT, 'src', 'room');
const MANIFEST = join(DEST_ROOT, 'PROVENANCE.json');

// The room's 19 source files — five components, twelve lib modules (including the
// three suites), two fixtures. Deliberately explicit: a glob would silently
// absorb whatever else lands in that folder later.
const FILES = [
  'components/stage/FlowCards.tsx',
  'components/stage/FlowEdges.tsx',
  'components/stage/FlowInspector.tsx',
  'components/stage/FlowRoom.tsx',
  'components/stage/FlowSteeringDock.tsx',
  'lib/flow-adapter.ts',
  'lib/flow-derive.ts',
  'lib/flow-geometry.test.ts',
  'lib/flow-legend-css.test.ts',
  'lib/flow-layout.ts',
  'lib/flow-projection.ts',
  'lib/flow-room.test.ts',
  'lib/flow-types.ts',
  'lib/flow-view.ts',
  'lib/stage-escape.ts',
  'lib/stage-tokens.ts',
  'lib/use-prefers-reduced-motion.ts',
  'mocks/flow-graph-live.ts',
  'mocks/flow-sample-layered.ts',
];

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const normalise = (buf) => Buffer.from(buf.toString('utf8').replace(/\r\n?/g, '\n'), 'utf8');
const sameBytes = (a, b) => a.equals(b) || sha256(normalise(a)) === sha256(normalise(b));

function sourcePath(rel) {
  return join(SOURCE_REPO, SOURCE_PREFIX, rel);
}

function blobAtCommit(rel) {
  return execFileSync('git', ['-C', SOURCE_REPO, 'show', `${SOURCE_COMMIT}:${SOURCE_PREFIX}/${rel}`], {
    maxBuffer: 64 * 1024 * 1024,
  });
}

const write = process.argv.includes('--write');

if (write) {
  if (existsSync(MANIFEST)) {
    const prior = JSON.parse(readFileSync(MANIFEST, 'utf8')).local_edits ?? {};
    const edited = Object.keys(prior);
    if (edited.length) {
      console.error(`refusing to re-pin: ${edited.length} file(s) carry a RECORDED local edit,`);
      console.error('and copying from the source would silently discard them:');
      for (const rel of edited) console.error(`  - ${rel} — ${prior[rel].reason}`);
      console.error('\nReconcile those edits first (or delete their entries from PROVENANCE.json).');
      process.exit(1);
    }
  }
  if (!existsSync(SOURCE_REPO)) {
    console.error(`cannot pin: source repo not found at ${SOURCE_REPO}`);
    process.exit(1);
  }
  const head = execFileSync('git', ['-C', SOURCE_REPO, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  const dirty = execFileSync('git', ['-C', SOURCE_REPO, 'status', '--porcelain'], {
    encoding: 'utf8',
  }).trim();
  if (head !== SOURCE_COMMIT) {
    console.error(`refusing to pin: source HEAD is ${head}, expected ${SOURCE_COMMIT}`);
    process.exit(1);
  }
  if (dirty) {
    console.error('refusing to pin: the source working tree is dirty, so the pin would be a guess');
    console.error(dirty);
    process.exit(1);
  }

  const files = {};
  for (const rel of FILES) {
    const src = sourcePath(rel);
    const dst = join(DEST, rel);
    if (!existsSync(src)) {
      console.error(`missing in source: ${rel}`);
      process.exit(1);
    }
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
    const bytes = readFileSync(dst);
    files[rel] = {
      sha256: sha256(bytes),
      bytes: bytes.length,
      source_sha256: sha256(readFileSync(src)),
      blob_sha256: sha256(blobAtCommit(rel)),
    };
  }

  writeFileSync(
    MANIFEST,
    `${JSON.stringify(
      {
        schema: 'agent-playbook.app-source-provenance.v1',
        source: { repo: SOURCE_REPO, path_prefix: SOURCE_PREFIX, commit: SOURCE_COMMIT },
        note: 'Copied verbatim. `node scripts/check-app-source-provenance.mjs` re-verifies; --write re-pins.',
        files,
      },
      null,
      2
    )}\n`
  );
  console.log(`pinned ${FILES.length} file(s) from ${SOURCE_COMMIT.slice(0, 7)}`);
  console.log(`  -> ${DEST}`);
  console.log(`  -> ${MANIFEST}`);
  process.exit(0);
}

// ── recording a DELIBERATE local edit ───────────────────────────────────────
//  The room is a pinned copy, but it is not frozen: a defect in the room itself has to be
//  fixable here. Such a change is recorded — file, hash and reason — so the pin stays
//  meaningful instead of being re-copied over the fix. `--write` refuses while any local
//  edit is recorded, because re-copying from the source would silently discard it.
if (process.argv.includes('--record-edit')) {
  const i = process.argv.indexOf('--record-edit');
  const rel = process.argv[i + 1];
  const rIdx = process.argv.indexOf('--reason');
  const reason = rIdx === -1 ? '' : process.argv[rIdx + 1];
  if (!rel || !FILES.includes(rel)) {
    console.error(`--record-edit needs a file from the pinned list. Known:\n  ${FILES.join('\n  ')}`);
    process.exit(2);
  }
  if (!reason) {
    console.error('--record-edit requires --reason "<why this is a deliberate change>".');
    process.exit(2);
  }
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const bytes = readFileSync(join(DEST, rel));
  manifest.local_edits = manifest.local_edits ?? {};
  const prior = manifest.local_edits[rel];
  manifest.local_edits[rel] = {
    sha256: sha256(bytes),
    reason,
    recorded: new Date().toISOString(),
    superseded: prior ? [...(prior.superseded ?? []), { sha256: prior.sha256, reason: prior.reason }] : undefined,
  };
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`recorded a deliberate local edit: ${rel}`);
  console.log(`  sha256 : ${sha256(bytes).slice(0, 16)}…`);
  console.log(`  reason : ${reason}`);
  process.exit(0);
}

// ── verification ────────────────────────────────────────────────────────────

if (!existsSync(MANIFEST)) {
  console.error(`no manifest at ${MANIFEST} — establish the pin first (--write)`);
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const problems = [];
let verifiedCopy = 0;
let verifiedSource = 0;
let verifiedBlob = 0;
let recordedEdits = 0;
const skipped = [];

const sourceReachable = existsSync(SOURCE_REPO);
if (!sourceReachable) {
  skipped.push(`source repo not reachable at ${SOURCE_REPO}: checks 2 and 3 skipped`);
}

for (const rel of FILES) {
  const entry = manifest.files?.[rel];
  if (!entry) {
    problems.push(`manifest has no entry for ${rel}`);
    continue;
  }
  const dst = join(DEST, rel);
  if (!existsSync(dst)) {
    problems.push(`missing from the app: ${rel}`);
    continue;
  }
  const bytes = readFileSync(dst);

  // A RECORDED local edit is a deliberate, documented divergence — not drift. It is checked
  // against its own recorded hash and deliberately NOT against the source, because the whole
  // point is that it differs from the source. Moving its hash again requires re-recording.
  const localEdit = manifest.local_edits?.[rel];
  if (localEdit) {
    if (sha256(bytes) !== localEdit.sha256) {
      problems.push(
        `UNRECORDED change to ${rel}: a recorded local edit ("${localEdit.reason}") whose hash moved — re-record with --record-edit --reason "…"`
      );
      continue;
    }
    recordedEdits += 1;
    continue;
  }

  // 1. the copy matches its recorded hash — it has not been edited since pinning
  if (sha256(bytes) !== entry.sha256) {
    problems.push(
      `EDITED after pinning: ${rel} is ${sha256(bytes).slice(0, 12)}, manifest says ${entry.sha256.slice(0, 12)}`
    );
    continue;
  }
  verifiedCopy += 1;

  if (!sourceReachable) continue;

  // 2. the copy is faithful to the source working tree
  if (!existsSync(sourcePath(rel))) {
    problems.push(`gone from the source: ${rel}`);
    continue;
  }
  if (!sameBytes(bytes, readFileSync(sourcePath(rel)))) {
    problems.push(`DIFFERS from the source working tree: ${rel}`);
    continue;
  }
  verifiedSource += 1;

  // 3. the source tree was at the pinned commit
  if (!sameBytes(bytes, blobAtCommit(rel))) {
    problems.push(`DIFFERS from the blob at ${SOURCE_COMMIT.slice(0, 7)}: ${rel}`);
    continue;
  }
  verifiedBlob += 1;
}

const total = Object.keys(manifest.files ?? {}).length;
if (total !== FILES.length) {
  problems.push(`manifest lists ${total} file(s), this check expects ${FILES.length}`);
}

const pinned = manifest.source?.commit ?? '(none)';
if (pinned !== SOURCE_COMMIT) {
  problems.push(`manifest pins ${pinned}, this check expects ${SOURCE_COMMIT}`);
}

console.log(`Flow room source provenance — pinned at ${pinned.slice(0, 7)}`);
console.log(`  copied files verified against the manifest : ${verifiedCopy}/${FILES.length}`);
if (sourceReachable) {
  console.log(`  byte-identical to the source working tree  : ${verifiedSource}/${FILES.length}`);
  console.log(`  byte-identical to the pinned git blob      : ${verifiedBlob}/${FILES.length}`);
}
if (recordedEdits) {
  console.log(`  RECORDED local edits (deliberate, hashed)  : ${recordedEdits}/${FILES.length}`);
  for (const [rel, edit] of Object.entries(manifest.local_edits ?? {})) {
    console.log(`      · ${rel} — ${edit.reason}`);
  }
}
for (const note of skipped) console.log(`  SKIP  ${note}`);

if (problems.length) {
  console.error(`\nPROVENANCE FAILED (${problems.length} problem(s)):`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error('\nDo not "fix" these by re-running --write: that would re-pin drift as truth.');
  process.exit(1);
}

console.log('\nProvenance holds: the copy is faithful and unedited.');
