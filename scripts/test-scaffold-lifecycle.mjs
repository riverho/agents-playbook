#!/usr/bin/env node
// test-scaffold-lifecycle — scaffold refuses what it does not read, names the package
// validly, and the result runs (plan-20261010-019).
//
//   1. an unknown flag (`--goal` was silently swallowed), a bare --target and two targets
//      are refused, and the target directory is never created;
//   2. the package name is one npm accepts and that names the workspace: a hidden
//      `<repo>/.agents-playbook` becomes `<repo>-agents-playbook`, never '-agents-playbook';
//   3. the scaffolded playbook boots: bootstrap, then validate, exit 0.

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { BASE_ENV } from './test-fixture-playbook.mjs';

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.error(`  FAIL  ${name}${extra ? `\n        ${String(extra).slice(0, 1200)}` : ''}`); fail++; }
}
const PB = resolve('scripts/pb.mjs');
const base = mkdtempSync(join(tmpdir(), 'pbscaffold-'));
const run = (script, args, cwd) => {
  const r = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', env: BASE_ENV });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
};
// npm's rule for a new package name (lowercase, url-safe, no leading dot or underscore)
const NPM_NAME = /^[a-z0-9][a-z0-9._~-]*$/;
const pkgName = (dir) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name;

try {
  // ── 1. refusals write nothing ───────────────────────────────────────────────
  const repo = join(base, 'myrepo');
  mkdirSync(repo);
  const hidden = join(repo, '.agents-playbook');
  const refused = (label, args, re) => {
    const r = run(PB, ['scaffold', ...args], repo);
    ok(`refuses ${label}`, r.code === 1 && re.test(r.out) && /Nothing was written/.test(r.out), r.out);
    ok(`${label}: the target was never created`, !existsSync(hidden));
  };
  refused('an unknown flag (--goal)', ['--target', hidden, '--goal', 'x'], /unknown flag --goal/);
  refused('a bare --target', ['--target'], /--target needs a directory/);
  refused('two targets', [hidden, join(repo, 'other')], /more than one target/);

  // ── 2. a valid, meaningful package name ─────────────────────────────────────
  const made = run(PB, ['scaffold', '--target', hidden], repo);
  ok('scaffold into <repo>/.agents-playbook succeeds', made.code === 0, made.out);
  const name = pkgName(hidden);
  ok('the package name is valid for npm', NPM_NAME.test(name), name);
  ok('a hidden folder borrows its repo\'s name: myrepo-agents-playbook', name === 'myrepo-agents-playbook', name);

  const odd = join(base, 'My Repo!! (copy)');
  mkdirSync(odd);
  const oddMade = run(PB, ['scaffold', '--target', odd], base);
  ok('an awkward folder name still yields a valid name', oddMade.code === 0 && pkgName(odd) === 'my-repo-copy', `${pkgName(odd)}\n${oddMade.out}`);

  // ── 3. the result boots ──────────────────────────────────────────────────────
  // copied, never linked: a recursive delete once followed a link and emptied the source
  cpSync(resolve('node_modules/js-yaml'), join(hidden, 'node_modules/js-yaml'), { recursive: true });
  for (const dep of ['argparse']) {
    if (existsSync(resolve('node_modules', dep))) cpSync(resolve('node_modules', dep), join(hidden, 'node_modules', dep), { recursive: true });
  }
  const scaffolded = join(hidden, 'scripts/pb.mjs');
  const boot = run(scaffolded, ['bootstrap'], hidden);
  ok('pb bootstrap runs in the scaffold', boot.code === 0, boot.out.slice(-600));
  const val = run(scaffolded, ['validate'], hidden);
  ok('pb validate passes in the scaffold', val.code === 0, val.out.slice(-600));
} finally {
  rmSync(base, { recursive: true, force: true });
}

console.log(`\ntest-scaffold-lifecycle: ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
