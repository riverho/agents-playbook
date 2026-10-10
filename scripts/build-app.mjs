#!/usr/bin/env node
// ============================================================================
//  build-app.mjs — build the Flow room's prebuilt dist, but only when it is stale.
// ----------------------------------------------------------------------------
//  Why this exists rather than a plain `vite build` in `prepack`: the engine declares
//  exactly ONE dependency (js-yaml), and the app needs React + React Flow + Vite. So
//  the shipped app must be BUILT OUTPUT, produced from a checkout that has the app
//  toolchain — and `npm pack` runs `prepack` in a checkout that may not.
//
//  The contract this enforces:
//    · dist is up to date  → exit 0, nothing rebuilt (packs stay fast)
//    · dist is stale/none  → rebuild, then exit 0
//    · no toolchain, stale → exit 1 with instructions, so a release FAILS LOUDLY
//      instead of shipping an empty or stale app (decision D2 in
//      artifacts/app-deploy/DEPLOYMENT-PLAN.md)
//
//  Usage: node scripts/build-app.mjs [--force]
//
//  STDOUT DISCIPLINE: `prepack` runs this during `npm pack`, and `npm pack --json`
//  reserves stdout for its result. Every human line therefore goes to stderr — a build
//  log on stdout corrupts the caller's JSON. (Same rule pack-dsh-plugin.mjs learned the
//  same way; this file learned it again the same way.)
// ============================================================================

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const log = (...parts) => console.error(...parts);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP = join(ROOT, 'apps', 'flow-room');
const DIST_INDEX = join(APP, 'dist', 'index.html');
const VITE = join(APP, 'node_modules', 'vite', 'bin', 'vite.js');
const force = process.argv.includes('--force');

/** Newest mtime among the app's own sources and build inputs. */
function newestSource() {
  let newest = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else newest = Math.max(newest, statSync(p).mtimeMs);
    }
  };
  walk(join(APP, 'src'));
  for (const f of ['index.html', 'package.json', 'vite.config.ts', 'tailwind.config.js', 'postcss.config.js']) {
    const p = join(APP, f);
    if (existsSync(p)) newest = Math.max(newest, statSync(p).mtimeMs);
  }
  return newest;
}

const built = existsSync(DIST_INDEX) ? statSync(DIST_INDEX).mtimeMs : 0;
const source = newestSource();

if (!force && built && built > source) {
  log(`app dist is up to date (built ${new Date(built).toISOString().slice(0, 19)}Z, sources older)`);
  process.exit(0);
}

if (!existsSync(VITE)) {
  console.error(
    [
      'cannot build the Flow room app: no toolchain.',
      '',
      `  looked for: ${VITE}`,
      '',
      'The app ships as BUILT output (the engine itself has one dependency, js-yaml), so a',
      'release must be built from a checkout that has the app toolchain:',
      '',
      '  cd apps/flow-room && npm install      # then re-run pack',
      '',
      'Refusing to pack a stale or empty app rather than shipping one.',
    ].join('\n')
  );
  process.exit(1);
}

log('building the Flow room app (dist older than sources)...');
// vite's own build log also goes to stderr, so `npm pack --json` keeps a clean stdout
const vite = execFileSync(process.execPath, [VITE, 'build'], { cwd: APP, encoding: 'utf8' });
if (vite.stdout) process.stderr.write(vite.stdout);
if (vite.stderr) process.stderr.write(vite.stderr);
log('app dist rebuilt');
