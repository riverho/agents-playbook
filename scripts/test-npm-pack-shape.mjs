#!/usr/bin/env node
// test-npm-pack-shape — the engine package ships the engine, not someone's install tree
// (plan-20261010-024).
//
// The `files` field listed dsh-plugin/ wholesale, so the plugin's installed peer/dev tree
// (dsh-plugin/node_modules: 1171 of 1478 entries, zod and @deepseek-ai among them) and a
// stale plugin tarball (dsh-plugin/dist/*.tgz) shipped inside the engine. The plugin's
// peers are peerDependencies; its publish set is its OWN `files` list. This asks npm
// what it would pack (dry run, no lifecycle scripts) and pins the shape:
//   1. no node_modules anywhere (there is no deliberate bundled dependency);
//   2. no tarball inside the tarball;
//   3. the dsh-plugin entries are exactly the plugin's own publish set (its `files`
//      plus package.json), so the two lists cannot drift apart;
//   4. the entry count stays in the engine's range.

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.error(`  FAIL  ${name}${extra ? `\n        ${String(extra).slice(0, 1200)}` : ''}`); fail++; }
}

const MAX_ENTRIES = 400;
// one fixed command string through the shell: npm is a .cmd shim on Windows
const r = spawnSync('npm pack --dry-run --json --ignore-scripts', { encoding: 'utf8', shell: true, maxBuffer: 64 * 1024 * 1024 });
let pack = null;
try {
  const parsed = JSON.parse(r.stdout);
  pack = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
} catch { /* reported below */ }
ok('npm pack --dry-run --json answers', r.status === 0 && !!pack?.files, `exit=${r.status}\n${(r.stderr || '').slice(-600)}`);
if (!pack?.files) { console.log(`\ntest-npm-pack-shape: ${pass} pass, ${fail} fail`); process.exit(1); }

const paths = pack.files.map((f) => f.path.replace(/\\/g, '/'));
const nm = paths.filter((p) => /(^|\/)node_modules\//.test(p));
ok('no node_modules ships in the engine package', nm.length === 0, `${nm.length} entries, e.g. ${nm.slice(0, 5).join(', ')}`);
const tgz = paths.filter((p) => p.endsWith('.tgz'));
ok('no tarball ships inside the tarball', tgz.length === 0, tgz.join(', '));

const plugin = JSON.parse(readFileSync('dsh-plugin/package.json', 'utf8'));
const allowed = [...plugin.files, 'package.json'].map((f) => `dsh-plugin/${f}`);
const inAllowed = (p) => allowed.some((a) => (a.endsWith('/') ? p.startsWith(a) : p === a));
const stray = paths.filter((p) => p.startsWith('dsh-plugin/') && !inAllowed(p));
ok('every dsh-plugin entry is in the plugin\'s own publish set', stray.length === 0, stray.slice(0, 10).join(', '));
const missing = allowed.filter((a) => !paths.some((p) => (a.endsWith('/') ? p.startsWith(a) : p === a)));
ok('…and the whole plugin publish set ships (engine bundle included)', missing.length === 0,
  `${missing.join(', ')} — run npm run build:plugin first if the bundle is missing`);

ok(`the package stays under ${MAX_ENTRIES} entries`, pack.entryCount <= MAX_ENTRIES, `${pack.entryCount} entries, ${Math.round(pack.size / 1024)} KB`);
console.log(`  shape   ${pack.entryCount} entries · ${Math.round(pack.size / 1024)} KB packed · ${Math.round(pack.unpackedSize / 1024)} KB unpacked`);

console.log(`\ntest-npm-pack-shape: ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
