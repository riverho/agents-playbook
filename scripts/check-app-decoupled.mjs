#!/usr/bin/env node
// ============================================================================
//  check-app-decoupled.mjs — the gate that makes "no more dependence to Wenmei"
//  an exit code instead of a promise.
// ----------------------------------------------------------------------------
//  The move is only complete if the app cannot reach back. This walks every module
//  under apps/flow-room/src and proves four things:
//
//    1. every import specifier resolves — relative ones inside the app, `@/…`
//       against src/room/, and bare ones as ordinary packages;
//    2. NO relative import escapes apps/flow-room/src (no ../../Wenmei/...);
//    3. the room itself (src/room) imports no host internals — not Wenmei's app
//       store/bridge/data modules, not Tauri, not a harness package. The room takes
//       its data from an injected adapter, so any such import is a regression;
//    4. apps/flow-room/node_modules is a real directory, not a junction — a link
//       into a shared tree is what emptied the root checkout before (project rule 27).
//
//  Comments are deliberately NOT scanned: the CSS provenance header names Wenmei
//  on purpose, and a gate that fails on a citation teaches people to delete the
//  citation. Only module specifiers count.
// ============================================================================

import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP = join(ROOT, 'apps', 'flow-room');
const APP_SRC = join(APP, 'src');
const ROOM = join(APP_SRC, 'room');

// Host internals the room must never reach for. Wenmei's names, Tauri's, the
// Wenmei-only aliases, and this repo's harness plugin.
const FORBIDDEN = [
  'wenmei',
  'tauri',
  '@tauri-apps',
  'appstore',
  'app-store',
  'mock-bridge',
  'stage-data',
  'sidecar',
  'electron',
  'dsh:',
  '@deepseek-ai',
  '@contracts',
  '@assets',
];
// ...but only the ROOM is held to the host-internal rule; a future host shell may
// legitimately talk to a harness. Escapes and unresolved specifiers apply to all.
const ROOM_ONLY = true;

const SOURCE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs']);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (SOURCE_EXT.has(entry.name.slice(entry.name.lastIndexOf('.')))) out.push(p);
  }
  return out;
}

/** import/export … from "x" · import "x" · import("x") · require("x") */
function specifiersOf(source) {
  const out = [];
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
    /^\s*import\s+["']([^"']+)["']/gm,
  ];
  for (const re of patterns) for (const m of source.matchAll(re)) out.push(m[1]);
  return [...new Set(out)];
}

const problems = [];
let files = 0;
let specifiers = 0;

function resolves(base, spec) {
  const target = resolve(base, spec);
  for (const candidate of [
    target,
    `${target}.ts`,
    `${target}.tsx`,
    `${target}.js`,
    `${target}.mjs`,
    join(target, 'index.ts'),
    join(target, 'index.tsx'),
    join(target, 'index.js'),
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return true;
  }
  return false;
}

for (const file of walk(APP_SRC)) {
  files += 1;
  const source = readFileSync(file, 'utf8');
  const rel = relative(APP, file).split(sep).join('/');
  const inRoom = file.startsWith(ROOM);

  for (const spec of specifiersOf(source)) {
    specifiers += 1;
    const lower = spec.toLowerCase();

    for (const bad of FORBIDDEN) {
      if (!lower.includes(bad)) continue;
      if (!ROOM_ONLY || inRoom) {
        problems.push(`${rel} imports "${spec}" — forbidden host/internal dependency (${bad})`);
      }
    }

    if (spec.startsWith('.') || spec.startsWith('@/')) {
      const base = spec.startsWith('@/') ? ROOM : dirname(file);
      // Vite import queries (`?raw`, `?url`, `#hash`) are not part of the file path.
      const bare = (spec.startsWith('@/') ? spec.slice(2) : spec).replace(/[?#].*$/, '');
      if (!resolves(base, bare)) {
        problems.push(`${rel} imports "${spec}" which does not resolve`);
        continue;
      }
      if (spec.startsWith('.')) {
        const resolved = resolve(dirname(file), bare);
        if (resolved !== APP_SRC && !resolved.startsWith(APP_SRC + sep)) {
          problems.push(`${rel} imports "${spec}" which escapes apps/flow-room/src`);
        }
      }
    }
  }
}

// 4. no junction/symlink pretending to be this app's dependencies (rule 27)
const nodeModules = join(APP, 'node_modules');
if (existsSync(nodeModules)) {
  const stat = lstatSync(nodeModules);
  if (stat.isSymbolicLink()) {
    problems.push(
      'apps/flow-room/node_modules is a link, not a real directory — a teardown that follows it ' +
        'reaches into the target tree (project rule 27)'
    );
  }
}

console.log(`Flow room decoupling — ${files} module(s), ${specifiers} import specifier(s)`);
console.log(`  scanned           : apps/flow-room/src`);
console.log(`  room-only rules   : src/room may not import host internals`);
console.log(`  link check        : apps/flow-room/node_modules`);

if (problems.length) {
  console.error(`\nDECOUPLING FAILED (${problems.length} problem(s)):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log('\nDecoupled: no reach-back to Wenmei, no host internals in the room, no linked deps.');
