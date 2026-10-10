#!/usr/bin/env node
// ============================================================================
//  check-dsh-bundle.mjs — the Flow room's DSH Client plugin is well-formed, and it
//  registers a global panel.
// ----------------------------------------------------------------------------
//  This is the HERMETIC half of decision D3's "real DSH integration". The other half —
//  installing the bundle into a Harness profile and seeing the panel — needs
//  `plugin_manager`, which an agent here does not have, so it is a human step and is
//  recorded as one rather than claimed.
//
//  What can be proven without a Harness, and therefore must be:
//    STATIC   · the bundle is in `window.__ModuleLoader__.load({ id, factory })` form,
//               with the id equal to this package's name
//             · react / react/jsx-runtime are reached through `require` (the browser
//               module table), and no React copy is inlined
//             · no `@deepseek-ai/dsh-client-ui-primitives` import (a UI-plugin rule)
//             · nothing appends a second application to document.body
//             · the manifest declares the client: exports["./client"], files, dsh.client
//    DYNAMIC  · the factory loads under a stub module loader, returns an `apply`, and
//               `apply(ctx)` registers into the root-scoped `main` slot with id
//               `flow-room`, plus a stylesheet the host can dispose
//
//  Usage: node scripts/check-dsh-bundle.mjs [--no-build]
// ============================================================================

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP = join(ROOT, 'apps', 'flow-room');
const BUNDLE = join(ROOT, 'dsh-plugin', 'client.js');
const MANIFEST = join(ROOT, 'dsh-plugin', 'package.json');

const problems = [];
const check = (condition, message) => { if (!condition) problems.push(message); };

// ── 0. build if needed (staleness-aware, so this is cheap when nothing changed) ──
if (!process.argv.includes('--no-build')) {
  try {
    execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-dsh-client.mjs')], { stdio: 'ignore' });
  } catch (err) {
    problems.push(`the DSH client build failed: ${String(err.message).split('\n')[0]}`);
  }
}
if (!existsSync(BUNDLE)) {
  console.error(`no bundle at ${BUNDLE} — run: node scripts/build-dsh-client.mjs`);
  process.exit(1);
}

const code = readFileSync(BUNDLE, 'utf8');
const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const pkgName = manifest.name;

// ── 1. static: the format and the rules ────────────────────────────────────────
// The generated file carries a provenance header comment; the loader call is the first
// CODE line. A comment before it changes nothing about the format, so strip comments
// rather than forbid the header.
const firstCodeLine = code.replace(/^(?:\s*\/\/[^\n]*\n|\s*\n)+/, '');
check(firstCodeLine.startsWith('window.__ModuleLoader__.load('),
  `the first code line is not window.__ModuleLoader__.load( — wrong module format (got ${JSON.stringify(firstCodeLine.slice(0, 60))})`);
check(new RegExp(`id:\\s*${JSON.stringify(pkgName)}`).test(code),
  `the bundle id is not ${JSON.stringify(pkgName)} — the loader keys factories by package name`);
check(/factory:\s*\(require\)\s*=>/.test(code),
  'the bundle has no `factory: (require) =>` — the host cannot invoke it');
check(code.includes('require("react")') || code.includes("require('react')"),
  'react is not reached through require() — the browser module table must supply it');
check(code.includes('require("react/jsx-runtime")') || code.includes("require('react/jsx-runtime')"),
  'react/jsx-runtime is not reached through require()');
check(!code.includes('__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED'),
  'a React copy looks INLINED in the bundle — React must come from the host module table');
check(!code.includes('@deepseek-ai/dsh-client-ui-primitives'),
  'the bundle imports @deepseek-ai/dsh-client-ui-primitives — UI plugins must not import Harness Client packages');
check(!/document\.body\.appendChild/.test(code),
  'the bundle appends to document.body — a plugin must not add a second application');

// ── 2. static: the manifest declares the client ────────────────────────────────
check(manifest.exports?.['./client'] === './client.js',
  `package.json exports["./client"] is ${JSON.stringify(manifest.exports?.['./client'])}`);
check((manifest.files ?? []).includes('client.js'),
  'package.json files[] does not include client.js — the bundle would not be published');
check(manifest.dsh?.client?.platform === 'web',
  'package.json dsh.client.platform is not "web"');

// ── 3. dynamic: load it under a stub loader and apply it ───────────────────────
const styleEls = [];
globalThis.document = {
  head: { appendChild() {}, removeChild() {} },
  createElement(tag) {
    const el = { tagName: String(tag).toUpperCase(), dataset: {}, textContent: '', removed: false };
    el.remove = () => { el.removed = true; };
    styleEls.push(el);
    return el;
  },
  querySelector: () => null,
  addEventListener() {},
  removeEventListener() {},
};

let captured = null;
globalThis.window = { __ModuleLoader__: { load: (def) => { captured = def; } } };

try {
  // eslint-disable-next-line no-new-func
  new Function('window', code)(globalThis.window);

  check(Boolean(captured), 'the bundle registered nothing with window.__ModuleLoader__.load');
  if (captured) {
    check(captured.id === pkgName, `the loader id is ${JSON.stringify(captured.id)}, expected ${pkgName}`);
    check(typeof captured.factory === 'function', 'the loader definition has no factory function');

    const appRequire = createRequire(join(APP, 'package.json'));
    const exportsObj = captured.factory(appRequire);

    check(Array.isArray(exportsObj?.inject) && exportsObj.inject.includes('slots'),
      `the plugin does not inject the slots service (inject = ${JSON.stringify(exportsObj?.inject)})`);
    check(typeof exportsObj?.apply === 'function', 'the plugin exports no apply(ctx)');

    const registrations = [];
    const effects = [];
    let selected = null;
    const ctx = {
      slots: {
        inject(name, register) { registrations.push({ slot: name, register }); },
        register(options, component) { registrations.push({ options, component }); return component; },
      },
      effect(fn) { effects.push(fn()); },
      layout: { selectPanel(id) { selected = id; } },
    };

    exportsObj.apply(ctx);

    const injected = registrations.find((r) => r.slot);
    check(injected?.slot === 'main',
      `the plugin injects slot ${JSON.stringify(injected?.slot)} — global panels belong in the root-scoped "main" slot`);
    // the registration is lazy: run the injector the way the host would
    if (injected?.register) injected.register();
    const registered = registrations.find((r) => r.options);
    check(registered?.options?.name === 'main',
      `the panel registered into ${JSON.stringify(registered?.options?.name)}, expected "main"`);
    check(registered?.options?.id === 'flow-room',
      `the panel id is ${JSON.stringify(registered?.options?.id)}, expected "flow-room"`);
    check(typeof registered?.component === 'function',
      'the registered panel is not a component (not callable)');

    check(styleEls.length === 1 && /--surface-0|\.flow-room/.test(styleEls[0].textContent),
      'apply() did not inject the room stylesheet — the panel would render unstyled');
    check(effects.length >= 1, 'apply() registered no disposer via ctx.effect');
    const cleanups = effects.filter((fn) => typeof fn === 'function');
    check(cleanups.length >= 1,
      'no ctx.effect returned a cleanup — an unmounted panel would leave its stylesheet behind');
    for (const fn of cleanups) fn();
    check(styleEls.every((el) => el.removed),
      'the stylesheet was not removed by the cleanup');
    check(selected === 'flow-room',
      `ctx.layout.selectPanel was called with ${JSON.stringify(selected)}, expected "flow-room"`);
  }
} catch (err) {
  problems.push(`loading the bundle threw: ${String(err?.message ?? err).split('\n')[0]}`);
}

console.log('Flow room × DSH client bundle');
console.log(`  format   : window.__ModuleLoader__.load({ id, factory }) — id ${pkgName}`);
console.log(`  react    : required from the browser module table, not bundled`);
console.log(`  panel    : registers into the root-scoped "main" slot as "flow-room"`);
console.log(`  styles   : injected by apply() and removed by its cleanup`);

if (problems.length) {
  console.error(`\nDSH BUNDLE FAILED (${problems.length} problem(s)):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('\nThe bundle is well-formed and registers a disposable global panel.');
