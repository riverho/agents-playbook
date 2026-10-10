#!/usr/bin/env node
// scripts/test-worker-remove-links.mjs
// ----------------------------------------------------------------------------
// `pb worker remove --execute` MUST NOT DELETE THROUGH A LINK. This is the
// regression test for a real, data-destroying incident:
//
//   A worker worktree's `node_modules` was a Windows JUNCTION to the root
//   checkout's node_modules (the workaround the session brief recommended, because
//   `npm install` is refused with EALLOWREMOTE here). `pb worker remove` ran
//   `git worktree remove`, whose recursive delete WALKED THROUGH the junction and
//   emptied the ROOT's node_modules to zero entries — js-yaml gone. On this box
//   Node's own `rmSync(recursive)` does NOT follow a junction; git's does.
//
// So the test is about a SENTINEL that lives OUTSIDE the worktree: if the teardown
// follows a link, the sentinel's contents are destroyed and the bytes assertion
// fails. It drives the REAL paths — a real git repo, a real `git worktree` opened by
// `pb worker create --execute`, and the real `pb worker remove --execute` — never a
// reimplementation of the removal. RED before the fix; GREEN after.
//
//   A. fixture: real git repo + playbook, sentinel with a byte-exact file outside it
//   B. `pb worker create --execute` opens a real slot; a junction (and a dir/file
//      symlink where the platform allows) is planted inside it, pointing at the sentinel
//   C. `pb worker remove --execute --delete-branch` runs the teardown that destroyed
//      the root's modules
//   D. the sentinel survives byte-for-byte, the worktree is gone, the branch is gone,
//      and the slot bookkeeping says `removed`
//   E. a link-free teardown still works (the fix must not break the normal path)
//
// Fixtures are %TEMP% trees; nothing here touches this worktree or the root checkout.
// ----------------------------------------------------------------------------
import {
  mkdirSync, mkdtempSync, copyFileSync, cpSync, writeFileSync, readFileSync, existsSync,
  symlinkSync, rmSync, readdirSync, lstatSync, readlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.error(`  FAIL  ${name}${extra ? `\n        ${extra}` : ''}`); fail++; }
}

// `record --status done` runs this check with PB_CLAIM_TOKEN/PB_AGENT_CHAIN stamped on
// the environment; scrub the identity vars so the fixture's own agents are what runs.
const BASE_ENV = (() => {
  const e = { ...process.env };
  for (const k of ['PB_CLAIM_TOKEN', 'PB_AGENT_CHAIN', 'PB_PARENT_AGENT_ID', 'PB_AGENT_ID', 'PB_SESSION_ID', 'PB_RUNTIME']) delete e[k];
  return e;
})();
function runPb(root, args, { agent = 'agent', env = {} } = {}) {
  const r = spawnSync(process.execPath, [join(root, 'scripts/pb.mjs'), ...args], {
    cwd: root, encoding: 'utf8', env: { ...BASE_ENV, PB_AGENT_ID: agent, ...env },
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '', combined: `${r.stdout || ''}${r.stderr || ''}` };
}
const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; } };

// The sentinel is OUTSIDE the repo and OUTSIDE the worktree: the only way its contents
// can vanish is the teardown walking through a link to reach it.
const SENTINEL_FILE = 'must-survive.txt';
const SENTINEL_BYTES = 'these bytes are the root checkout in miniature\n';

function makeFixture() {
  const base = mkdtempSync(join(tmpdir(), 'pbrmlinks-'));
  const root = join(base, 'repo');
  const sentinel = join(base, 'shared-deps');
  mkdirSync(sentinel, { recursive: true });
  writeFileSync(join(sentinel, SENTINEL_FILE), SENTINEL_BYTES);

  for (const d of ['scripts', 'memory', 'modes', 'skills/run-task', 'processes', 'artifacts/reports']) {
    mkdirSync(join(root, d), { recursive: true });
  }
  copyFileSync(resolve('scripts/pb.mjs'), join(root, 'scripts/pb.mjs'));
  // A REAL COPY of this worktree's deps, never a link: the fixture must not plant the
  // very hazard it is testing (and a link here would be deleted through by the buggy
  // teardown as well, which would make the RED reason ambiguous).
  cpSync(resolve('node_modules'), join(root, 'node_modules'), { recursive: true });
  writeFileSync(join(root, 'SKILL.md'), '---\nname: remove-links-test\ndescription: t\n---\n');
  writeFileSync(join(root, 'skills/index.yaml'), 'skills:\n  - {id: run-task, file: skills/run-task/SKILL.md, process: run-task}\n');
  writeFileSync(join(root, 'skills/run-task/SKILL.md'), '# run-task\n');
  writeFileSync(join(root, 'processes/index.yaml'), 'processes:\n  - {id: run-task, file: processes/run-task.yaml}\n');
  writeFileSync(join(root, 'processes/run-task.yaml'), 'id: run-task\nsteps: []\n');
  writeFileSync(join(root, 'modes/coding.yaml'), 'id: coding\ndirective: ""\n');
  writeFileSync(join(root, 'memory/project-memory.md'), '# fixture memory\n');
  writeFileSync(join(root, 'memory/loops.yaml'), 'active: L1\nloops:\n  - id: L1\n    status: active\n    started_at: 2026-01-01T00:00:00.000Z\n');
  writeFileSync(join(root, 'memory/cycle.md'), '# c\n## 1. Goal\nunlink links\n## 4. Stop\nnone\n## 5. Conflicts\nNone\n');
  writeFileSync(join(root, 'memory/journal.ndjson'), '');
  writeFileSync(join(root, 'memory/lessons.ndjson'), '');
  writeFileSync(join(root, 'memory/processes.ndjson'), '');
  writeFileSync(join(root, 'playbook.yaml'),
    'name: remove-links-test\nversion: 0.7.1\nentry: SKILL.md\n' +
    'paths:\n  scripts: scripts\n  memory: memory\n  modes: modes\n  artifacts: artifacts\n  reports: artifacts/reports\n' +
    'index:\n  cli: scripts/pb.mjs\n  skills_index: skills/index.yaml\n  processes_index: processes/index.yaml\n  memory:\n    backlog: memory/backlog.yaml\n    journal: memory/journal.ndjson\n    loops: memory/loops.yaml\n    cycle: memory/cycle.md\n' +
    'loop:\n  description: test\n  steps:\n    - id: orient\n      do: orient\n      command: node scripts/pb.mjs status\n' +
    'default_mode: coding\nmodes:\n  coding: modes/coding.yaml\n' +
    'guardrails:\n  allowed_statuses: [todo, in_progress, blocked, done]\n');
  writeFileSync(join(root, 'memory/backlog.yaml'),
    'tasks:\n' +
    '  - {id: link-victim, title: a slot whose node_modules is a junction, status: todo, skill: run-task, mode: coding, priority: 1}\n' +
    '  - {id: plain-victim, title: a slot with no links at all, status: todo, skill: run-task, mode: coding, priority: 2}\n' +
    '  - {id: rootlink-victim, title: a slot whose path itself is a link, status: todo, skill: run-task, mode: coding, priority: 3}\n');
  // node_modules is gitignored in the real repo, which is exactly why `git worktree
  // remove` deletes it (and, before the fix, what it reached THROUGH it) without asking.
  // Slash-LESS patterns on purpose: a link is not a directory to git, so `node_modules/`
  // would leave it untracked and `git worktree remove` would REFUSE — and a refusal would
  // make the sentinel assertions pass through the back door, proving nothing. These names
  // must be ignored however the platform types them, so the teardown runs exactly as it
  // did in the incident (no --force).
  writeFileSync(join(root, '.gitignore'), 'node_modules\nvendor\ntool.link\nordinary-work.txt\n');

  const git = (args, cwd = root) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  git(['init', '--quiet']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  git(['add', '-A']);
  git(['commit', '--quiet', '-m', 'seed']);
  return { base, root, sentinel, git, pb: (args, opts) => runPb(root, args, opts) };
}

// Plant a link, and report honestly when the platform refuses to create one.
function plantLink(target, linkPath, type) {
  try { symlinkSync(target, linkPath, type); return { ok: true }; }
  catch (e) { return { ok: false, error: e.code || e.message }; }
}

// ============================================================================
//  A–D. the incident: a junction inside the worktree, and the real teardown
// ============================================================================
const fx = makeFixture();
const stateFile = join(fx.root, 'memory/backlog-state.json');
{
  ok('the fixture is a real git repo with a commit to branch a worktree from',
    (fx.git(['rev-parse', 'HEAD']) || '').length > 0, fx.git(['rev-parse', 'HEAD']));
  ok('the sentinel holds the byte-exact file every assertion below depends on',
    existsSync(join(fx.sentinel, SENTINEL_FILE)) &&
    readFileSync(join(fx.sentinel, SENTINEL_FILE), 'utf8') === SENTINEL_BYTES);

  const wt = join(fx.base, 'wt-link-victim');
  const created = fx.pb(['worker', 'create', 'link-victim', '--agent', 't', '--worktree', wt, '--execute']);
  ok('`pb worker create --execute` opens the real slot (a real git worktree)',
    created.code === 0 && existsSync(wt) && /Worker slot open/.test(created.out), created.combined.slice(0, 500));
  const rec = readJson(stateFile)['link-victim']?.worker || {};
  ok('the slot is recorded with its worktree path and branch',
    rec.worktree_path === wt && /^agent\//.test(rec.branch || ''), JSON.stringify(rec));

  // The junction that destroyed the root's node_modules — plus the other link kinds.
  const junction = join(wt, 'node_modules');
  const j = plantLink(fx.sentinel, junction, 'junction');
  const dirLink = join(wt, 'vendor');
  const dl = plantLink(fx.sentinel, dirLink, 'dir');
  const fileLink = join(wt, 'tool.link');
  const fl = plantLink(join(fx.sentinel, SENTINEL_FILE), fileLink, 'file');
  ok('a real junction is planted inside the worktree, pointing at the sentinel',
    j.ok && existsSync(junction) && lstatSync(junction).isSymbolicLink() && readlinkSync(junction).includes('shared-deps'),
    JSON.stringify({ planted: j, link: j.ok && existsSync(junction) ? readlinkSync(junction) : `(no link at ${junction})` }));
  if (!j.ok || !existsSync(junction)) {
    // Do not crash and do not pass vacuously: the fixture could not plant the hazard,
    // so there is nothing to prove. Red with a reason.
    ok('the fixture could plant the hazard (otherwise this suite proves nothing)', false, `junction not created: ${JSON.stringify(j)}`);
    console.log(`\ntest-worker-remove-links: ${pass} pass, ${fail} fail (aborted: no junction planted)`);
    try { rmSync(fx.base, { recursive: true, force: true }); } catch { /* best effort */ }
    process.exit(1);
  }
  ok('the junction is what lstat must see as a link (never `stat`/readdir type alone)',
    lstatSync(junction).isSymbolicLink() === true && !lstatSync(fx.sentinel).isSymbolicLink(),
    `junction.isSymbolicLink=${lstatSync(junction).isSymbolicLink()} sentinel.isSymbolicLink=${lstatSync(fx.sentinel).isSymbolicLink()}`);

  const removed = fx.pb(['worker', 'remove', 'link-victim', '--agent', 't', '--delete-branch', '--execute']);
  ok('the real removal path ran in --execute mode (not a dry run)',
    /\[exec\]/.test(removed.out) && removed.code === 0, `exit=${removed.code}\n${removed.combined.slice(0, 600)}`);

  // --- the property the incident violated -------------------------------------
  const sentinelFile = join(fx.sentinel, SENTINEL_FILE);
  ok('THE SENTINEL SURVIVES BYTE-FOR-BYTE (the teardown did not delete through the junction)',
    existsSync(sentinelFile) && readFileSync(sentinelFile, 'utf8') === SENTINEL_BYTES,
    existsSync(sentinelFile)
      ? `bytes changed: ${JSON.stringify(readFileSync(sentinelFile, 'utf8'))}`
      : `the file is GONE; sentinel now holds ${JSON.stringify(readdirSync(fx.sentinel))} — the delete followed the link`);
  ok('the sentinel directory still holds exactly the file it started with',
    readdirSync(fx.sentinel).join() === SENTINEL_FILE, JSON.stringify(readdirSync(fx.sentinel)));

  // --- normal teardown behaviour must be unchanged ----------------------------
  ok('the worktree itself is gone', !existsSync(wt), wt);
  ok('git no longer lists the worktree', !fx.git(['worktree', 'list']).includes(wt), fx.git(['worktree', 'list']));
  ok('the slot bookkeeping says removed',
    readJson(stateFile)['link-victim']?.worker?.status === 'removed',
    JSON.stringify(readJson(stateFile)['link-victim']?.worker));
  ok('--delete-branch deleted the branch',
    !fx.git(['branch', '--list', rec.branch]).includes(rec.branch), fx.git(['branch', '--list']));

  // The links the platform could create must be gone with the tree, never left dangling.
  for (const [name, res, path] of [['dir symlink', dl, dirLink], ['file symlink', fl, fileLink]]) {
    if (!res.ok) { console.log(`  SKIP  ${name} not creatable here (${res.error}) — covered by the junction case`); continue; }
    ok(`${name} was removed with the tree, not left behind`, !existsSync(path), path);
  }
  ok('the sentinel survived every link kind planted in that worktree',
    existsSync(sentinelFile) && readFileSync(sentinelFile, 'utf8') === SENTINEL_BYTES,
    JSON.stringify(readdirSync(fx.sentinel)));
}

// ============================================================================
//  E. a link-free teardown still works (the fix must not break the normal path)
// ============================================================================
{
  const wt = join(fx.base, 'wt-plain-victim');
  const created = fx.pb(['worker', 'create', 'plain-victim', '--agent', 't', '--worktree', wt, '--execute']);
  writeFileSync(join(wt, 'ordinary-work.txt'), 'no links here\n');
  const removed = fx.pb(['worker', 'remove', 'plain-victim', '--agent', 't', '--delete-branch', '--execute']);
  ok('a link-free slot still opens and tears down cleanly',
    created.code === 0 && removed.code === 0 && /\[exec\]/.test(removed.out) && !existsSync(wt),
    `create=${created.code}\n${created.combined.slice(0, 300)}\nremove=${removed.code}\n${removed.combined.slice(0, 300)}`);
  ok('its bookkeeping was updated too',
    readJson(stateFile)['plain-victim']?.worker?.status === 'removed',
    JSON.stringify(readJson(stateFile)['plain-victim']?.worker));
}

// ============================================================================
//  F. the worktree path ITSELF is a link → REFUSE, and delete nothing at all
// ============================================================================
{
  const wt = join(fx.base, 'wt-rootlink-victim');
  const target = join(fx.base, 'rootlink-target');
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'target-bytes.txt'), 'do not touch me\n');
  const created = fx.pb(['worker', 'create', 'rootlink-victim', '--agent', 't', '--worktree', wt, '--execute']);
  ok('the refusal case: a slot opens, and its path is then replaced by a junction',
    created.code === 0 && existsSync(wt), created.combined.slice(0, 300));
  rmSync(wt, { recursive: true, force: true });                 // the real tree goes away (plain dir: safe)
  symlinkSync(target, wt, 'junction');                          // …and its path becomes a link
  const refused = fx.pb(['worker', 'remove', 'rootlink-victim', '--agent', 't', '--delete-branch', '--execute']);
  ok('a worktree path that is itself a link is REFUSED, with the path named',
    refused.code === 1 && /worktree path ITSELF is a link/.test(refused.combined) && refused.combined.includes(wt),
    `exit=${refused.code}\n${refused.combined.slice(0, 500)}`);
  ok('the refusal deleted NOTHING: the link is still there and its target is untouched',
    existsSync(wt) && lstatSync(wt).isSymbolicLink() &&
    existsSync(join(target, 'target-bytes.txt')) && readFileSync(join(target, 'target-bytes.txt'), 'utf8') === 'do not touch me\n',
    JSON.stringify(readdirSync(target)));
  ok('the refusal left the slot bookkeeping alone (it did not claim the slot was removed)',
    readJson(stateFile)['rootlink-victim']?.worker?.status === 'created',
    JSON.stringify(readJson(stateFile)['rootlink-victim']?.worker?.status));
}

// Cleanup is itself junction-safe (Node's rmSync does not follow one — measured, not
// assumed), and it runs only after the assertions.
try { rmSync(fx.base, { recursive: true, force: true }); } catch { /* a killed run may leave temp files */ }

console.log(`\ntest-worker-remove-links: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
