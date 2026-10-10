#!/usr/bin/env node
// ============================================================================
//  test-app-pack.mjs — the Flow room ships with the engine, and the shipped copy works.
// ----------------------------------------------------------------------------
//  Requirement: "when I install agents-playbook, the app should be there too."
//  The engine has exactly ONE dependency (js-yaml) while the app needs React + React
//  Flow + Vite, so the app travels as BUILT OUTPUT plus a zero-dependency server
//  (decision D2), produced at `prepack` by scripts/build-app.mjs.
//
//  What this proves:
//    A. the tarball carries apps/flow-room/{dist/, server.mjs, package.json} — and
//       carries NO app source and NO app node_modules
//    B. `pb ui` resolves the app, serves it, and answers GET / and GET /api/graph with
//       the projection schema — run from an EXTRACTED tarball, i.e. what a consumer gets
//    C. `pb ui` fails with guidance (not a stack trace) when no app is reachable
//
//  HONEST LIMITS, stated rather than hidden:
//    · the tarball is EXTRACTED, not `npm install`ed, because installing would fetch
//      js-yaml from the registry and this machine refuses remote fetches (EALLOWREMOTE).
//      The one dependency a real install would place is copied in by REAL COPY instead
//      (project rule 27: never a junction).
//    · the pre-existing `dsh-plugin/node_modules` in the tarball (1252 of 1437 entries)
//      is NOT asserted against here — it predates this work and is reported separately.
//    · `pb ui` is killed with `taskkill /T`, because the engine's own lesson
//      (plan-20261010-009) is that killing a shim leaves its grandchild running.
// ============================================================================

import { execFileSync, execSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const check = (condition, message) => { if (!condition) problems.push(message); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const work = mkdtempSync(join(tmpdir(), 'pb-app-pack-'));
let uiChild = null;

function killTree(pid) {
  try {
    execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
  } catch {
    /* already gone */
  }
}

try {
  // ── A. pack, and read the tarball's real contents ──────────────────────────
  execSync(`npm pack --pack-destination "${work}" --silent`, { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'] });
  const tgz = join(work, 'agents-playbook-0.7.1.tgz');
  check(existsSync(tgz), `npm pack produced no tarball in ${work}`);

  const entries = execFileSync('tar', ['-tzf', tgz], { encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter(Boolean);

  const has = (suffix) => entries.some((e) => e === `package/${suffix}`);
  check(has('apps/flow-room/server.mjs'), 'the tarball has no apps/flow-room/server.mjs — the app cannot serve');
  check(has('apps/flow-room/package.json'), 'the tarball has no apps/flow-room/package.json');
  check(has('apps/flow-room/dist/index.html'), 'the tarball has no built app (apps/flow-room/dist/index.html)');
  check(entries.some((e) => /^package\/apps\/flow-room\/dist\/assets\/.+\.(js|css)$/.test(e)),
    'the built app has no assets — dist looks empty');
  check(!entries.some((e) => e.startsWith('package/apps/flow-room/src/')),
    'the tarball leaks app SOURCE (apps/flow-room/src) — only built output should ship');
  check(!entries.some((e) => e.startsWith('package/apps/flow-room/node_modules/')),
    'the tarball leaks apps/flow-room/node_modules — the app ships as built output');

  // ── B. extract it, hydrate the one dependency, and serve it ────────────────
  const installDir = join(work, 'installed');
  mkdirSync(installDir, { recursive: true });
  execFileSync('tar', ['-xzf', tgz, '-C', installDir], { stdio: 'ignore' });
  const pkg = join(installDir, 'package');
  check(existsSync(join(pkg, 'scripts', 'pb.mjs')), 'the extracted package has no engine CLI');

  // what `npm install` would have placed, by REAL COPY (rule 27)
  mkdirSync(join(pkg, 'node_modules'), { recursive: true });
  for (const dep of ['js-yaml', 'argparse']) {
    cpSync(join(ROOT, 'node_modules', dep), join(pkg, 'node_modules', dep), { recursive: true });
  }
  execFileSync(process.execPath, [join(pkg, 'scripts', 'pb.mjs'), 'init'], { cwd: pkg, stdio: 'ignore' });

  const port = 9300 + Math.floor(Math.random() * 300);
  uiChild = spawn(process.execPath, [join(pkg, 'scripts', 'pb.mjs'), 'ui', '--port', String(port)], {
    cwd: pkg,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let uiOut = '';
  uiChild.stdout.on('data', (d) => { uiOut += String(d); });
  uiChild.stderr.on('data', (d) => { uiOut += String(d); });

  let served = null;
  for (let i = 0; i < 60 && !served; i += 1) {
    if (uiChild.exitCode !== null) {
      problems.push(`\`pb ui\` exited ${uiChild.exitCode} instead of serving.\n${uiOut.trim()}`);
      break;
    }
    try {
      const r = await fetch(`http://127.0.0.1:${port}/`);
      if (r.ok) served = r;
    } catch { /* not up yet */ }
    if (!served) await sleep(250);
  }

  if (served) {
    const html = await served.text();
    check(/<div id="root">/.test(html), '`pb ui` served something that is not the app page');
    const graph = await (await fetch(`http://127.0.0.1:${port}/api/graph`)).json().catch(() => null);
    check(graph?.schema === 'agent-playbook.graph.v1',
      `the shipped app's /api/graph did not return the projection schema (got ${graph?.schema})`);
  } else if (!problems.length) {
    problems.push(`\`pb ui\` never answered on http://127.0.0.1:${port}`);
  }

  if (uiChild && uiChild.exitCode === null) killTree(uiChild.pid);
  uiChild = null;

  // ── C. a workspace scaffolded WITHOUT --with-ui must be guided, not crashed ──
  // This is the real consumer shape: `pb scaffold` copies the engine (no apps/), so its
  // own `pb.mjs ui` has no app to resolve and must say so and name the fix.
  const bare = join(work, 'bare-repo');
  const barePb = join(bare, '.agents-playbook');
  mkdirSync(bare, { recursive: true });
  execFileSync(process.execPath, [join(pkg, 'scripts', 'pb.mjs'), 'scaffold', '--target', barePb], {
    cwd: bare, stdio: 'ignore',
  });
  mkdirSync(join(barePb, 'node_modules'), { recursive: true });
  for (const dep of ['js-yaml', 'argparse']) {
    cpSync(join(ROOT, 'node_modules', dep), join(barePb, 'node_modules', dep), { recursive: true });
  }

  let cOut = '';
  let cCode = 0;
  try {
    cOut = execFileSync(process.execPath, [join(barePb, 'scripts', 'pb.mjs'), 'ui'], {
      cwd: barePb, encoding: 'utf8',
    });
  } catch (err) {
    cOut = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    cCode = err.status ?? 1;
  }
  check(cCode === 1, `\`pb ui\` in a workspace with no app should exit 1, exited ${cCode}`);
  check(/no Flow room app found/.test(cOut),
    `\`pb ui\` did not print its guidance: ${cOut.trim().split('\n').slice(0, 2).join(' / ')}`);
  check(/--with-ui/.test(cOut), '`pb ui` guidance should name the --with-ui opt-in');
  check(!/^\s*at .*\(/m.test(cOut), '`pb ui` failed with a stack trace instead of guidance');

  // ── D. and scaffold --with-ui puts a working app in the workspace ──────────
  const uiRepo = join(work, 'ui-repo');
  const uiPb = join(uiRepo, '.agents-playbook');
  mkdirSync(uiRepo, { recursive: true });
  execFileSync(
    process.execPath,
    [join(pkg, 'scripts', 'pb.mjs'), 'scaffold', '--target', uiPb, '--with-ui', join(pkg, 'apps', 'flow-room')],
    { cwd: uiRepo, stdio: 'ignore' }
  );
  check(existsSync(join(uiPb, 'apps', 'flow-room', 'server.mjs')),
    '`scaffold --with-ui` did not copy the app server into the workspace');
  check(existsSync(join(uiPb, 'apps', 'flow-room', 'dist', 'index.html')),
    '`scaffold --with-ui` did not copy the built app');
  check(!existsSync(join(uiPb, 'apps', 'flow-room', 'src')),
    '`scaffold --with-ui` copied app SOURCE — only built output should travel');
} catch (err) {
  problems.push(`harness error: ${String(err.message ?? err).split('\n')[0]}`);
} finally {
  if (uiChild && uiChild.exitCode === null) killTree(uiChild.pid);
  rmSync(work, { recursive: true, force: true });
}

console.log('Flow room ⇄ npm pack');
console.log('  shape    : dist + server.mjs + package.json ship; src and node_modules do not');
console.log('  served   : `pb ui` from an extracted tarball answers / and /api/graph');
console.log('  guidance : with no app reachable, `pb ui` exits 1 with instructions');

if (problems.length) {
  console.error(`\nAPP PACK FAILED (${problems.length} problem(s)):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('\nThe app travels with the engine, and the copy that arrives works.');
