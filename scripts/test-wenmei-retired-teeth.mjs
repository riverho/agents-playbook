#!/usr/bin/env node
// ============================================================================
//  test-wenmei-retired-teeth.mjs — the escapes an independent checker found, as permanent cases.
// ----------------------------------------------------------------------------
//  `check-wenmei-retired.mjs` was mutation-tested six ways and still had holes, because its
//  ASSERTIONS were tested and its SCANNER was not: a regex "comment stripper" silently ate 95
//  lines of a shipped file, root configs and `index.html` were never read, `.cjs` and
//  dot-directories were skipped, Windows backslashes and split `join(...)` segments walked
//  through, only two of the four dependency fields were read, and the pin was checked for SHAPE
//  rather than truth (a forty-zero commit passed).
//
//  Each case below builds a scratch app whose only flaw is the one being tested, runs the real
//  gate against it with `--root`, and requires a RED. The control at the start must be GREEN;
//  otherwise every red proves nothing.
// ============================================================================

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GATE = join(ROOT, 'scripts', 'check-wenmei-retired.mjs');
const problems = [];

const work = mkdtempSync(join(tmpdir(), 'pb-wenmei-teeth-'));
const repo = join(work, 'repo');
const app = join(repo, 'apps', 'flow-room');
const source = join(work, 'wenmei-source');
const appDesign = join(source, 'app_design');

const write = (rel, text) => {
  const full = join(repo, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text, 'utf8');
};
const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// The gate's exit code, with the scratch repo as --root and the scratch checkout as the source.
function gate(extraArgs = [], env = {}) {
  const r = spawnSync(process.execPath, [GATE, '--root', repo, ...extraArgs], {
    encoding: 'utf8', env: { ...process.env, PB_FLOW_SOURCE: source, ...env },
  });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}
const expectRed = (label, needle) => {
  const r = gate();
  if (r.code === 0) problems.push(`${label}: the gate exited 0 — this escape is NOT caught`);
  else if (needle && !r.out.includes(needle)) problems.push(`${label}: caught, but not for the stated reason (wanted "${needle}")`);
  return r;
};

try {
  // ── the scratch world ───────────────────────────────────────────────────
  mkdirSync(appDesign, { recursive: true });
  writeFileSync(join(appDesign, 'README.md'), 'the other checkout\n', 'utf8');
  git(source, ['init', '-q']);
  git(source, ['add', '-A']);
  git(source, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'source']);
  const pin = git(source, ['rev-parse', 'HEAD']).trim();
  // Written second, so the tombstone names a commit that is a real ANCESTOR of this checkout's
  // HEAD — the gate verifies that now, rather than trusting the shape of the sha.
  writeFileSync(join(appDesign, 'TOMBSTONE.md'),
    `# TOMBSTONE\nRetired. It lives at Agents-Playbook apps/flow-room. One-way direction. Pinned at ${pin.slice(0, 7)}.\n`, 'utf8');
  git(source, ['add', '-A']);
  git(source, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'tombstone']);

  write('apps/flow-room/server.mjs', '// a thin /api/* that shells to pb\nimport { createServer } from "node:http";\n\nexport const server = createServer;\n');
  write('apps/flow-room/index.html', '<!doctype html><html><body><div id="root"></div></body></html>\n');
  write('apps/flow-room/vite.config.ts', 'import { defineConfig } from "vite";\nexport default defineConfig({});\n');
  write('apps/flow-room/src/room/flow.ts', 'export const flow = 1;\n');
  write('apps/flow-room/src/room/mocks/flow-graph-live.ts',
    'export const fixture = { files: ["D:/HermesProjects/Wenmei/wenmei/.worktrees/graph-room/app_design/src/x.ts"] };\n');
  write('apps/flow-room/package.json', JSON.stringify({ name: 'flow-room', dependencies: {} }, null, 2) + '\n');
  const provPath = join(app, 'PROVENANCE.json');
  const prov = { schema: 'x', source: { repo: source, commit: pin, path_prefix: 'app_design/src' }, files: { 'a.ts': { sha256: 'x' } } };
  writeFileSync(provPath, JSON.stringify(prov, null, 2) + '\n', 'utf8');
  write('docs/flow-room-retirement.md',
    '# Retirement\napps/flow-room is owned here and Wenmei is never read: one-way, no reach-back.\n');
  git(repo, ['init', '-q']);
  git(repo, ['add', 'docs/flow-room-retirement.md']);

  // ── control ─────────────────────────────────────────────────────────────
  const control = gate();
  if (control.code !== 0) {
    problems.push(`control is RED, so nothing below proves anything:\n      ${control.out.trim().split('\n').slice(-4).join('\n      ')}`);
  }
  if (!/scanned for resolution/.test(control.out)) problems.push('the gate did not report what it scanned');
  if (!/fixture file/.test(control.out)) problems.push('the gate did not report the fixture history it allows (report, do not hide)');

  // ── 1. the live defect: a scanner, not a regex ──────────────────────────
  write('apps/flow-room/server.mjs',
    `// a thin /api/* that shells to pb\nconst open = "/*";\nimport z from ${JSON.stringify(join(source, 'app_design/src/y'))};\nconst close = "*/";\n`);
  expectRed('stripper evasion (prose /* + a real import after it)', 'names the Wenmei tree');
  write('apps/flow-room/server.mjs', '// a thin /api/* that shells to pb\nimport { createServer } from "node:http";\n\nexport const server = createServer;\n');

  // ── 2-4. files the old walk never read ──────────────────────────────────
  write('apps/flow-room/vite.config.ts',
    `import { defineConfig } from "vite";\nconst REACH = ${JSON.stringify(join(source, 'app_design/src'))};\nexport default defineConfig({});\n`);
  expectRed('root config (vite.config.ts)', 'Wenmei');
  write('apps/flow-room/vite.config.ts', 'import { defineConfig } from "vite";\nexport default defineConfig({});\n');

  write('apps/flow-room/index.html', `<!doctype html><script type="module" src="${join(source, 'app_design/src/main.tsx')}"></script>\n`);
  expectRed('index.html', 'Wenmei');
  write('apps/flow-room/index.html', '<!doctype html><html><body><div id="root"></div></body></html>\n');

  write('apps/flow-room/src/room/legacy.cjs', `const x = require(${JSON.stringify(join(source, 'app_design/src/x'))});\nmodule.exports = x;\n`);
  expectRed('.cjs is scanned too', 'Wenmei');
  rmSync(join(app, 'src', 'room', 'legacy.cjs'), { force: true });

  write('apps/flow-room/src/.reach/hidden.ts', `export const p = ${JSON.stringify(join(source, 'app_design/src/x'))};\n`);
  expectRed('dot-directories are not pruned', 'Wenmei');
  rmSync(join(app, 'src', '.reach'), { recursive: true, force: true });

  // ── 5-6. path shapes that are not forward-slash relatives ───────────────
  write('apps/flow-room/src/room/backslash.ts', 'export const p = "..\\\\..\\\\..\\\\Wenmei\\\\wenmei\\\\app_design\\\\src\\\\x.ts";\n');
  expectRed('windows backslash relative escape', 'Wenmei');
  rmSync(join(app, 'src', 'room', 'backslash.ts'), { force: true });

  write('apps/flow-room/src/room/split.ts',
    'import { join } from "node:path";\nexport const p = join("..", "..", "Wenmei", "wenmei", "app_design", "src");\n');
  expectRed('split segments (join("..","..","Wenmei",...))', 'path-shaped literal reaches into Wenmei');
  rmSync(join(app, 'src', 'room', 'split.ts'), { force: true });

  // ── 7-8. dependency fields and values ───────────────────────────────────
  write('apps/flow-room/package.json', JSON.stringify({ name: 'flow-room', dependencies: { vite: '^5', linky: `file:${join(source, 'app_design')}` } }, null, 2) + '\n');
  expectRed('a dependency VALUE pointing into Wenmei (file:)', 'resolves into the Wenmei tree');
  write('apps/flow-room/package.json', JSON.stringify({ name: 'flow-room', peerDependencies: { 'wenmei-flow': '^1' } }, null, 2) + '\n');
  expectRed('a dependency NAME in peerDependencies', 'names the Wenmei tree');
  write('apps/flow-room/package.json', JSON.stringify({ name: 'flow-room', dependencies: {} }, null, 2) + '\n');

  // ── 9-10. the pin must be TRUE, not merely well-formed ──────────────────
  writeFileSync(provPath, JSON.stringify({ ...prov, source: { ...prov.source, commit: '0'.repeat(40) } }, null, 2) + '\n', 'utf8');
  expectRed('a pin of forty zeros (shape without truth)', 'git does not know');
  const wtPath = join(work, '.worktrees', 'wenmei');
  mkdirSync(wtPath, { recursive: true });
  writeFileSync(provPath, JSON.stringify({ ...prov, source: { ...prov.source, repo: wtPath } }, null, 2) + '\n', 'utf8');
  expectRed('a pin naming a worktree (no trailing separator)', 'points at a worktree');
  writeFileSync(provPath, JSON.stringify(prov, null, 2) + '\n', 'utf8');

  // ── 11. an unreachable source must be explicit, and can be made fatal ────
  const missing = gate([], { PB_FLOW_SOURCE: join(work, 'definitely-not-here') });
  if (missing.code !== 0) problems.push('with no checkout and no --require-source the gate must still pass (it is in npm test), but it exited non-zero');
  if (!/NOT EVALUATED/.test(missing.out)) problems.push('with no checkout the gate did not say the tombstone assertion was NOT EVALUATED');
  const strict = gate(['--require-source'], { PB_FLOW_SOURCE: join(work, 'definitely-not-here') });
  if (strict.code === 0) problems.push('--require-source with no checkout exited 0 — absence must be falsifiable');

  // ── 12. the two doc errors stay fixed ───────────────────────────────────
  const doc = readFileSync(join(ROOT, 'docs', 'flow-room-retirement.md'), 'utf8');
  if (/Unset .?PB_FLOW_SOURCE/i.test(doc)) problems.push('the doc still says "Unset PB_FLOW_SOURCE" — it is SET, not unset');
  if (/looked\s+\*?auditable\*?\s+while pointing at nothing/i.test(doc)) problems.push('the doc still claims the old pin was "pointing at nothing" — the directory existed, it had been de-registered');
  if (!/still exists[\s\S]{0,24}and is still populated/i.test(doc)) problems.push('the doc does not record what actually happened to the old worktree path');

  // ── control again, after every restore ──────────────────────────────────
  const final = gate();
  if (final.code !== 0) problems.push(`the control is RED after the restores:\n      ${final.out.trim().split('\n').slice(-4).join('\n      ')}`);
} catch (err) {
  problems.push(`harness error: ${String(err?.message ?? err).split('\n')[0]}`);
} finally {
  let removed = false;
  for (let i = 0; i < 6 && !removed; i += 1) {
    try { rmSync(work, { recursive: true, force: true }); removed = !existsSync(work); } catch { /* retry */ }
  }
  if (!removed) console.error(`note: left the scratch tree on disk: ${work}`);
}

console.log('Wenmei-retired gate — the escapes an independent checker proved');
console.log('  scanner   : prose `/*` cannot swallow a file; configs, html, .cjs and dot-dirs are scanned');
console.log('  shapes    : absolute, backslash-relative and split-segment paths; all dependency fields, names and values');
console.log('  pin       : a forty-zero commit and a worktree path both redden; a real ancestor passes');
console.log('  source    : absence is reported as NOT EVALUATED, and --require-source makes it fatal');

if (problems.length) {
  console.error(`\nGATE TEETH FAILED (${problems.length} problem(s)):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('\nEvery escape the checker found is now a case, and the control is green.');
