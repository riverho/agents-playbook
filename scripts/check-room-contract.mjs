#!/usr/bin/env node
// ============================================================================
//  check-room-contract.mjs — the Flow room meets its approved design contract.
// ----------------------------------------------------------------------------
//  The contract is artifacts/graph-flow-ui/v2/CONTRACT.md (approved 2026-10-11, D12–D22).
//  This gate enforces the rules that can be read from source, so a later edit cannot
//  quietly bring back 9px monospace labels or a grey that fails contrast (D18):
//
//    T1  two families only: --f-ui (Atkinson Hyperlegible Next) and --f-code (… Mono)
//    T2  font sizes only from the scale 12 / 13 / 14 / 16 / 20 / 28 px — nothing below 12
//    T4  the code face only on code-like selectors (commands, paths, IDs, branches)
//    T5  no uppercase and no positive letter-spacing on labels
//    C1  every text colour token reaches 4.5:1 on every surface token; no literal text colours
//    C3  the "needs you" colour (--you) only on human-in-the-loop parts; the old rose is gone
//    C5  the six-step ramp --s1…--s6 runs red → green, and the rail paints by step
//    F3  nothing flashes faster than 3 times a second (an infinite animation ≥ 333 ms)
//
//  Rules that need a browser (T3 zoom floor, F4 reduced motion, G5) or later engine
//  fields belong to the tasks that build them.
//
//  Every run first SELF-TESTS: each rule is fed a known-bad sample and must catch it. A rule
//  that stops biting turns this gate red even when the room is clean.
//
//    node scripts/check-room-contract.mjs [--app <dir>]
// ============================================================================

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argApp = process.argv.indexOf('--app');
const APP = argApp === -1 ? join(ROOT, 'apps', 'flow-room') : resolve(process.argv[argApp + 1]);
const SRC = join(APP, 'src');

const SCALE = [12, 13, 14, 16, 20, 28];
const TAILWIND_SIZES = { xs: 12, sm: 14, base: 16, lg: 18, xl: 20, '2xl': 24, '3xl': 30, '4xl': 36, '5xl': 48 };
const MIN_FLASH_MS = 1000 / 3;

// ── tiny CSS reader: rules with selectors, declarations, and the @media they sit in ──
function stripComments(css) { return css.replace(/\/\*[\s\S]*?\*\//g, ''); }
function parseCss(css) {
  const rules = [];
  const text = stripComments(css);
  const walk = (body, media) => {
    let i = 0;
    while (i < body.length) {
      const open = body.indexOf('{', i);
      if (open === -1) break;
      const head = body.slice(i, open).trim();
      let depth = 1, j = open + 1;
      while (j < body.length && depth) { if (body[j] === '{') depth += 1; else if (body[j] === '}') depth -= 1; j += 1; }
      const inner = body.slice(open + 1, j - 1);
      if (head.startsWith('@media') || head.startsWith('@supports')) walk(inner, head);
      else if (head.startsWith('@keyframes') || head.startsWith('@font-face') || head.startsWith('@tailwind')) { /* not a styled rule */ }
      else if (head) {
        const decls = inner.split(';').map((d) => d.trim()).filter(Boolean).map((d) => {
          const k = d.indexOf(':');
          return k === -1 ? null : { prop: d.slice(0, k).trim().toLowerCase(), value: d.slice(k + 1).trim() };
        }).filter(Boolean);
        rules.push({ selector: head.replace(/\s+/g, ' '), decls, media });
      }
      i = j;
    }
  };
  walk(text.replace(/@tailwind[^;]*;/g, ''), null);
  return rules;
}

// ── colour maths (WCAG 2.x relative luminance) ──
function hexToRgb(hex) {
  let h = hex.replace('#', '').trim();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  return [0, 2, 4].map((k) => parseInt(h.slice(k, k + 2), 16));
}
function luminance([r, g, b]) {
  const f = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}
function hue([r, g, b]) {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B), min = Math.min(R, G, B), d = max - min;
  if (!d) return 0;
  let h;
  if (max === R) h = ((G - B) / d) % 6; else if (max === G) h = (B - R) / d + 2; else h = (R - G) / d + 4;
  return (h * 60 + 360) % 360;
}

// ── the rules: each takes the parsed sources and returns a list of problems ──
function tokensFrom(rules, pick) {
  const out = {};
  for (const r of rules) if (pick(r)) for (const d of r.decls) if (d.prop.startsWith('--')) out[d.prop] = d.value;
  return out;
}
const lightRoot = (r) => r.selector === ':root' && !r.media;
const darkRoot = (r) => /prefers-color-scheme:\s*dark/.test(r.media || '') || /\[data-theme="dark"\]/.test(r.selector);

function ruleT1({ rules, ts, html }) {
  const p = [];
  const root = tokensFrom(rules, lightRoot);
  if (!/^["']?Atkinson Hyperlegible Next["']?\s*,/.test(root['--f-ui'] || '') || !/(sans-serif|system-ui)\s*$/.test(root['--f-ui'] || '')) {
    p.push(`--f-ui must be "Atkinson Hyperlegible Next", …, a generic sans fallback (is: ${root['--f-ui'] ?? 'undefined'})`);
  }
  if (!/^["']?Atkinson Hyperlegible Mono["']?\s*,/.test(root['--f-code'] || '') || !/monospace\s*$/.test(root['--f-code'] || '')) {
    p.push(`--f-code must be "Atkinson Hyperlegible Mono", …, monospace (is: ${root['--f-code'] ?? 'undefined'})`);
  }
  for (const r of rules) for (const d of r.decls) {
    if (d.prop === 'font-family' && !/^(var\(--f-(ui|code)\)|inherit)$/.test(d.value)) p.push(`${r.selector}: font-family ${d.value} — use var(--f-ui) or var(--f-code)`);
    if (d.prop === 'font') p.push(`${r.selector}: the font shorthand hides a family and a size — set them separately`);
  }
  if (!rules.some((r) => /(^|,\s*)(body|html|\.flow-room)\b/.test(r.selector) && r.decls.some((d) => d.prop === 'font-family' && d.value === 'var(--f-ui)'))) {
    p.push('no base rule (body / html / .flow-room) sets font-family: var(--f-ui)');
  }
  for (const f of ts) for (const m of f.text.matchAll(/fontFamily\s*:\s*(["'`])([^"'`]*)\1/g)) {
    if (!/^(var\(--f-(ui|code)\)|inherit)$/.test(m[2])) p.push(`${f.rel}: inline fontFamily "${m[2]}"`);
  }
  for (const f of ts) for (const m of f.text.matchAll(/\bfont-(sans|serif|mono)\b/g)) p.push(`${f.rel}: Tailwind ${m[0]} bypasses the tokens`);
  for (const f of ts) for (const m of f.text.matchAll(/\bfont-\[[^\]]+\]/g)) p.push(`${f.rel}: Tailwind ${m[0]} bypasses the tokens`);
  // the inline shorthand hides a family AND a size from every other check
  for (const f of ts) for (const m of f.text.matchAll(/(?<![\w-])font\s*:\s*["'`]/g)) p.push(`${f.rel}: inline font shorthand — set fontFamily and fontSize separately`);
  for (const m of html.matchAll(/fonts\.googleapis\.com\/(?!css2\?)[^"'\s>]*/g)) p.push(`index.html loads fonts outside the css2 API (${m[0]}) — its families are not checked`);
  const families = [...html.matchAll(/fonts\.googleapis\.com\/css2\?([^"']+)/g)].flatMap((m) => [...m[1].matchAll(/family=([^:&"']+)/g)].map((x) => decodeURIComponent(x[1].replace(/\+/g, ' '))));
  for (const fam of families) if (!/^Atkinson Hyperlegible (Next|Mono)$/.test(fam)) p.push(`index.html loads the font "${fam}"`);
  if (!families.includes('Atkinson Hyperlegible Next')) p.push('index.html does not load Atkinson Hyperlegible Next');
  return p;
}

function sizeOk(raw) {
  const v = raw.trim();
  if (v === 'inherit') return true;
  let m = v.match(/^var\(--t-(\d+)\)$/);
  if (m) return SCALE.includes(Number(m[1]));
  m = v.match(/^([\d.]+)px$/);
  if (m) return SCALE.includes(Number(m[1]));
  m = v.match(/^([\d.]+)rem$/);
  if (m) return SCALE.includes(Number(m[1]) * 16);
  return false;
}
function ruleT2({ rules, ts }) {
  const p = [];
  const root = tokensFrom(rules, lightRoot);
  for (const n of SCALE) if (root[`--t-${n}`] !== `${n}px`) p.push(`--t-${n} must be ${n}px (is: ${root[`--t-${n}`] ?? 'undefined'})`);
  for (const r of rules) for (const d of r.decls) if (d.prop === 'font-size' && !sizeOk(d.value)) p.push(`${r.selector}: font-size ${d.value} is off the scale ${SCALE.join('/')}`);
  for (const f of ts) {
    // Every inline fontSize must be a LITERAL the gate can read: a number or "Npx" / "Nrem" on
    // the scale, or "var(--t-N)". A variable, an em or a calc is a size nobody checked.
    for (const m of f.text.matchAll(/fontSize\s*[:=]\s*\{?\s*([^,}\n]+)/g)) {
      const v = m[1].trim().replace(/^["'`]|["'`]$/g, '');
      if (v === 'inherit') continue;
      let n = null;
      let k = v.match(/^([\d.]+)(px)?$/); if (k) n = Number(k[1]);
      k = v.match(/^([\d.]+)rem$/); if (k) n = Number(k[1]) * 16;
      k = v.match(/^var\(--t-(\d+)\)$/); if (k) n = Number(k[1]);
      if (n === null || !SCALE.includes(n)) p.push(`${f.rel}: fontSize ${v} is not a literal size on the scale`);
    }
    for (const m of f.text.matchAll(/\btext-\[([\d.][^\]]*)\]/g)) {
      const k = m[1].match(/^([\d.]+)(px|rem)$/);
      const n = !k ? null : k[2] === 'rem' ? Number(k[1]) * 16 : Number(k[1]);
      if (n === null || !SCALE.includes(n)) p.push(`${f.rel}: ${m[0]} is off the scale`);
    }
    for (const m of f.text.matchAll(/\btext-(xs|sm|base|lg|xl|[2-5]xl)\b/g)) {
      if (!SCALE.includes(TAILWIND_SIZES[m[1]])) p.push(`${f.rel}: ${m[0]} (${TAILWIND_SIZES[m[1]]}px) is off the scale`);
    }
  }
  return p;
}

const CODE_SELECTOR = /(^|[\s>+~(])(code|kbd|pre|samp)\b|\.flow-(code|id|cmd|path|branch|hash)\b|__(code|cmd|path|id|branch|hash)\b/;
function ruleT4({ rules, ts }) {
  const p = [];
  for (const r of rules) {
    if (!r.decls.some((d) => d.prop === 'font-family' && d.value === 'var(--f-code)')) continue;
    for (const sel of r.selector.split(',')) if (!CODE_SELECTOR.test(sel.trim())) p.push(`${sel.trim()}: the code face on a selector that is not a command, path, ID or branch`);
  }
  for (const f of ts) if (/fontFamily\s*:\s*["'`]var\(--f-code\)/.test(f.text)) p.push(`${f.rel}: inline code face — use a code-like class instead`);
  return p;
}

function ruleT5({ rules, ts }) {
  const p = [];
  for (const r of rules) for (const d of r.decls) {
    if (d.prop === 'text-transform' && d.value !== 'none') p.push(`${r.selector}: text-transform ${d.value}`);
    if (d.prop === 'letter-spacing' && !/^(normal|0|0(\.0+)?(em|px)?|-[\d.]+(em|px))$/.test(d.value)) p.push(`${r.selector}: letter-spacing ${d.value}`);
  }
  for (const f of ts) {
    for (const m of f.text.matchAll(/\b(uppercase|tracking-(wide|wider|widest))\b/g)) p.push(`${f.rel}: Tailwind ${m[0]}`);
    for (const m of f.text.matchAll(/textTransform\s*:\s*["'`](\w+)/g)) if (m[1] !== 'none') p.push(`${f.rel}: inline textTransform ${m[1]}`);
    for (const m of f.text.matchAll(/letterSpacing\s*:\s*([^,}\n]+)/g)) {
      const v = m[1].trim().replace(/^["'`]|["'`]$/g, '');
      if (!/^(normal|0|0(\.0+)?(em|px)?|-[\d.]+(em|px)?)$/.test(v)) p.push(`${f.rel}: inline letterSpacing ${v}`);
    }
    for (const m of f.text.matchAll(/\btracking-\[(?!-)[^\]]+\]/g)) p.push(`${f.rel}: Tailwind ${m[0]}`);
  }
  return p;
}

const TEXT_TOKEN = /^--(text-|ink|tone-|on-|you$|accent(-(?!tint|wash)[a-z]+)?$)/;
const SURFACE_TOKEN = /^--(surface-[0-9]|surface|bg)$/;
function ruleC1({ rules, ts }) {
  const p = [];
  const themes = [['light', tokensFrom(rules, lightRoot)]];
  const dark = tokensFrom(rules, darkRoot);
  if (Object.keys(dark).length) themes.push(['dark', { ...themes[0][1], ...dark }]);
  // A surface counts only if something is PAINTED with it: a token named --surface-3 that is
  // only ever a border colour is not a background text sits on.
  const painted = new Set();
  for (const r of rules) for (const d of r.decls) if (/^background(-color)?$/.test(d.prop)) for (const m of d.value.matchAll(/var\((--[\w-]+)/g)) painted.add(m[1]);
  for (const f of ts) for (const m of f.text.matchAll(/background(?:Color)?\s*:\s*["'`]var\((--[\w-]+)/g)) painted.add(m[1]);
  for (const [name, tok] of themes) {
    const surfaces = Object.entries(tok).filter(([k, v]) => SURFACE_TOKEN.test(k) && painted.has(k) && hexToRgb(v));
    if (!surfaces.length) { p.push(`${name}: no solid surface tokens to measure against`); continue; }
    for (const [k, v] of Object.entries(tok)) {
      if (!TEXT_TOKEN.test(k) || k.startsWith('--on-')) continue;
      const rgb = hexToRgb(v);
      if (!rgb) { p.push(`${name}: text token ${k} is not a solid hex colour (${v})`); continue; }
      for (const [sk, sv] of surfaces) {
        const c = contrast(rgb, hexToRgb(sv));
        if (c < 4.5) p.push(`${name}: ${k} ${v} on ${sk} ${sv} is ${c.toFixed(2)}:1 (needs 4.5)`);
      }
    }
    for (const [k, v] of Object.entries(tok)) {
      const m = k.match(/^--on-(.+)$/);
      if (!m) continue;
      const under = tok[`--${m[1]}`];
      if (!under || !hexToRgb(under) || !hexToRgb(v)) { p.push(`${name}: ${k} has no solid --${m[1]} to sit on`); continue; }
      const c = contrast(hexToRgb(v), hexToRgb(under));
      if (c < 4.5) p.push(`${name}: ${k} ${v} on --${m[1]} ${under} is ${c.toFixed(2)}:1 (needs 4.5)`);
    }
  }
  for (const r of rules) for (const d of r.decls) {
    if (d.prop === 'color' && !/^(var\(--[\w-]+\)|inherit|currentColor|transparent)$/i.test(d.value)) p.push(`${r.selector}: literal text colour ${d.value} — use a measured token`);
  }
  // Inline text colours in components: a token, never a literal (and never a literal fallback,
  // which is the colour a missing token silently falls back to).
  for (const f of ts) {
    // every quoted value in the expression counts, so a literal inside a ternary is caught too
    // (a comma inside a quoted string does not end the expression: var(--x, #fff) is one value)
    for (const m of f.text.matchAll(/(?<![\w-])color\s*:\s*((?:[^,}\n"'`]|"[^"\n]*"|'[^'\n]*'|`[^`\n]*`)+)/g)) {
      for (const q of m[1].matchAll(/["'`]([^"'`]+)["'`]/g)) {
        if (/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i.test(q[1])) p.push(`${f.rel}: literal text colour ${q[1]} — use a measured token`);
      }
    }
  }
  // A rule that paints its own background under a text token is measured on THAT background.
  const lightTok = themes[0][1];
  const solid = (v) => { const m = /^var\((--[\w-]+)\)$/.exec(v || ''); return hexToRgb(m ? (lightTok[m[1]] || '') : (v || '')); };
  for (const r of rules) {
    if (r.selector === ':root' || r.media) continue;
    const col = r.decls.filter((d) => d.prop === 'color').pop();
    const bg = r.decls.filter((d) => /^background(-color)?$/.test(d.prop)).pop();
    if (!col || !bg) continue;
    const a = solid(col.value), b = solid(bg.value);
    if (!a || !b) continue;
    const c = contrast(a, b);
    if (c < 4.5) p.push(`${r.selector}: text ${col.value} on its own background ${bg.value} is ${c.toFixed(2)}:1 (needs 4.5)`);
  }
  for (const f of ts.filter((x) => /stage-tokens\.ts$/.test(x.rel))) {
    const block = (f.text.match(/TONE_COLOR[^=]*=\s*\{([\s\S]*?)\}/) || [])[1] ?? '';
    for (const m of block.matchAll(/(\w+)\s*:\s*["'`]([^"'`]+)["'`]/g)) {
      if (!/^var\(--tone-[\w-]+\)$/.test(m[2])) p.push(`${f.rel}: TONE_COLOR.${m[1]} is ${m[2]} — text tones must be measured --tone-* tokens`);
    }
  }
  return p;
}

const HIL = /hil|human|batch|decision|needs-?you|asking/i;
const withoutYouToken = (line) => line.replace(/--you[\w-]*/g, '');
function ruleC3({ rules, ts }) {
  const p = [];
  const root = tokensFrom(rules, lightRoot);
  if (!hexToRgb(root['--you'] || '')) p.push('--you is not defined as a solid colour');
  for (const r of rules) {
    if (r.selector === ':root' || darkRoot(r)) continue;
    if (!r.decls.some((d) => /var\(--you[\w-]*\)/.test(d.value))) continue;
    for (const sel of r.selector.split(',')) if (!HIL.test(sel)) p.push(`${sel.trim()}: uses --you outside a human-in-the-loop part`);
  }
  for (const f of ts) {
    f.text.split('\n').forEach((line, i) => {
      if (/--you\b|--you-/.test(line) && !HIL.test(withoutYouToken(line))) p.push(`${f.rel}:${i + 1}: uses --you outside a human-in-the-loop part`);
    });
  }
  const css = rules.flatMap((r) => r.decls.map((d) => `${d.prop}:${d.value}`)).join('\n');
  if (/accent-rose/.test(css) || ts.some((f) => /accent-rose/.test(f.text))) p.push('the old --accent-rose is still referenced — human states use --you, failures use --tone-bad');
  return p;
}

function ruleC5({ rules, ts }) {
  const p = [];
  const root = tokensFrom(rules, lightRoot);
  const ramp = [1, 2, 3, 4, 5, 6].map((n) => hexToRgb(root[`--s${n}`] || ''));
  if (ramp.some((x) => !x)) { p.push('the stage ramp --s1…--s6 is not fully defined as solid colours'); return p; }
  const hues = ramp.map(hue).map((h) => (h > 300 ? h - 360 : h));
  if (!(hues[0] <= 25)) p.push(`--s1 must be red (hue ${hues[0].toFixed(0)}°)`);
  if (!(hues[5] >= 90 && hues[5] <= 170)) p.push(`--s6 must be green (hue ${hues[5].toFixed(0)}°)`);
  for (let k = 1; k < 6; k += 1) if (hues[k] < hues[k - 1]) p.push(`the ramp turns back between --s${k} and --s${k + 1} (${hues[k - 1].toFixed(0)}° → ${hues[k].toFixed(0)}°)`);
  for (let n = 1; n <= 6; n += 1) {
    const stepRules = rules.filter((r) => r.selector.includes(`[data-step="${n}"]`));
    const ok = stepRules.some((r) => r.decls.some((d) => d.value.includes(`var(--s${n})`)));
    if (!ok) p.push(`no rule paints step ${n} with var(--s${n}) (selector [data-step="${n}"])`);
    for (const r of stepRules) for (const d of r.decls) for (const m of d.value.matchAll(/var\(--s(\d)\)/g)) {
      if (Number(m[1]) !== n) p.push(`${r.selector}: step ${n} also paints var(--s${m[1]})`);
    }
  }
  const doneRules = rules.filter((r) => /\[data-done/.test(r.selector) && r.decls.some((d) => d.value.includes('var(--s6)')));
  if (!doneRules.length) p.push('no rule paints a done rail all --s6 (selector [data-done])');
  // An unproven done card stops at verify: the done colour may reach FILLED segments only,
  // or its empty segments paint green and "not run" looks like a pass (C4).
  for (const r of doneRules) for (const sel of r.selector.split(',')) if (!/__on\b/.test(sel)) p.push(`${sel.trim()}: the done colour reaches unfilled segments — target the filled ones (…__on)`);
  for (const f of ts.filter((x) => /(FlowCards|FlowInspector)\.tsx$/.test(x.rel))) {
    if (/data-done=/.test(f.text)) p.push(`${f.rel}: sets data-done by hand — use railAttrs(node), which marks done only when all six steps are filled`);
  }
  const cards = ts.find((f) => /FlowCards\.tsx$/.test(f.rel));
  if (!cards || !/railAttrs\(/.test(cards.text)) p.push('FlowCards.tsx does not set the rail attributes through railAttrs(node)');
  const insp = ts.find((f) => /FlowInspector\.tsx$/.test(f.rel));
  if (insp && /flow-cycle/.test(insp.text) && !/railAttrs\(/.test(insp.text)) p.push('FlowInspector.tsx draws a rail without railAttrs(node)');
  return p;
}

function durationsMs(value) {
  return [...value.matchAll(/(?<![\w-])([\d.]+)(ms|s)\b/g)].map((m) => Number(m[1]) * (m[2] === 's' ? 1000 : 1));
}
function ruleF3({ rules }) {
  const p = [];
  for (const r of rules) {
    if (/prefers-reduced-motion/.test(r.media || '')) continue;
    for (const d of r.decls) {
      if (d.prop === 'animation' && /\binfinite\b/.test(d.value)) {
        const ms = durationsMs(d.value)[0];
        if (ms === undefined || ms < MIN_FLASH_MS) p.push(`${r.selector}: infinite animation of ${ms ?? '?'}ms flashes faster than 3 times a second`);
      }
      if (d.prop === 'animation-duration' && r.decls.some((x) => x.prop === 'animation-iteration-count' && x.value === 'infinite')) {
        const ms = durationsMs(d.value)[0];
        if (ms === undefined || ms < MIN_FLASH_MS) p.push(`${r.selector}: infinite animation of ${ms ?? '?'}ms flashes faster than 3 times a second`);
      }
    }
  }
  return p;
}

const RULES = [
  ['T1', 'two families only, from the tokens', ruleT1],
  ['T2', `font sizes only from the scale ${SCALE.join('/')}px`, ruleT2],
  ['T4', 'the code face only on code-like selectors', ruleT4],
  ['T5', 'no uppercase or letter-spaced labels', ruleT5],
  ['C1', 'text colours reach 4.5:1; no literal text colours', ruleC1],
  ['C3', '--you only on human-in-the-loop parts', ruleC3],
  ['C5', 'the stage ramp runs red → green and paints by step', ruleC5],
  ['F3', 'nothing flashes faster than 3 times a second', ruleF3],
];

// ── self-test: every rule must catch its known-bad sample ──
const GOOD_ROOT = `:root { --f-ui: "Atkinson Hyperlegible Next", system-ui, sans-serif; --f-code: "Atkinson Hyperlegible Mono", ui-monospace, monospace;
  --t-12: 12px; --t-13: 13px; --t-14: 14px; --t-16: 16px; --t-20: 20px; --t-28: 28px; --surface-0: #ffffff; --text-primary: #111111;
  --you: #b4167f;
  --you: #b4167f; --s1: #d64541; --s2: #e06a2e; --s3: #d9921c; --s4: #a9a21c; --s5: #5fa03f; --s6: #23955a; }
  body { font-family: var(--f-ui); background: var(--surface-0); }
  .flow-rail[data-step="1"] i { background: var(--s1); } .flow-rail[data-step="2"] i { background: var(--s2); } .flow-rail[data-step="3"] i { background: var(--s3); }
  .flow-rail[data-step="4"] i { background: var(--s4); } .flow-rail[data-step="5"] i { background: var(--s5); } .flow-rail[data-step="6"] i { background: var(--s6); }
  .flow-rail[data-done] i.flow-rail__on { background: var(--s6); }`;
const GOOD = () => ({
  rules: parseCss(GOOD_ROOT),
  ts: [{ rel: 'FlowCards.tsx', text: '<div {...railAttrs(node)} />' }],
  html: '<link href="https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible+Next:wght@400&family=Atkinson+Hyperlegible+Mono&display=swap">',
});
// more than one known-bad sample per rule: each closes a blind spot an independent checker found
const BAD_EXTRA = {
  T1: [(s) => ({ ...s, ts: [...s.ts, { rel: 'X.tsx', text: 'style={{ font: "9px Arial" }}' }] }),
       (s) => ({ ...s, html: s.html + '<link href="https://fonts.googleapis.com/css?family=Roboto">' }),
       (s) => ({ ...s, ts: [...s.ts, { rel: 'X.tsx', text: 'className="font-[Arial]"' }] })],
  T2: [(s) => ({ ...s, ts: [...s.ts, { rel: 'X.tsx', text: 'style={{ fontSize: "0.7em" }}' }] }),
       (s) => ({ ...s, ts: [...s.ts, { rel: 'X.tsx', text: 'style={{ fontSize: sz }}' }] })],
  T5: [(s) => ({ ...s, ts: [...s.ts, { rel: 'X.tsx', text: 'style={{ letterSpacing: "0.2em" }}' }] }),
       (s) => ({ ...s, ts: [...s.ts, { rel: 'X.tsx', text: 'className="tracking-[0.2em]"' }] })],
  C1: [(s) => ({ ...s, ts: [...s.ts, { rel: 'X.tsx', text: 'style={{ color: "#bbbbbb" }}' }] }),
       (s) => ({ ...s, ts: [...s.ts, { rel: 'X.tsx', text: 'style={{ color: "var(--text-tertiary, #9a9590)" }}' }] }),
       (s) => ({ ...s, rules: parseCss(`${GOOD_ROOT} :root { --accent-teal: #43b3a0; }`) }),
       (s) => ({ ...s, ts: [...s.ts, { rel: 'X.tsx', text: 'style={{ color: ok ? "#bbbbbb" : "var(--text-primary)" }}' }] })],
  C3: [(s) => ({ ...s, ts: [...s.ts, { rel: 'X.tsx', text: '<span style={{ color: "var(--you)" }}/>' }] }),
       (s) => ({ ...s, rules: parseCss(`${GOOD_ROOT} .flow-card__title, .flow-hil { color: var(--you); }`) })],
  C5: [(s) => ({ ...s, rules: parseCss(`${GOOD_ROOT} .flow-rail[data-done] i { background: var(--s6); }`) }),
       (s) => ({ ...s, rules: parseCss(`${GOOD_ROOT} .flow-rail[data-step="3"] i { background: var(--s3); background: var(--s5); }`) }),
       (s) => ({ ...s, ts: [{ rel: 'FlowCards.tsx', text: '<div {...railAttrs(node)} data-done={node.status === "done" ? "" : undefined} />' }] })],
};
const BAD = {
  T1: (s) => ({ ...s, rules: parseCss(`${GOOD_ROOT} .x { font-family: "Geist Mono", monospace; }`) }),
  T2: (s) => ({ ...s, rules: parseCss(`${GOOD_ROOT} .x { font-size: 9px; }`) }),
  T4: (s) => ({ ...s, rules: parseCss(`${GOOD_ROOT} .flow-title { font-family: var(--f-code); }`) }),
  T5: (s) => ({ ...s, rules: parseCss(`${GOOD_ROOT} .x { text-transform: uppercase; letter-spacing: 0.1em; }`) }),
  C1: (s) => ({ ...s, rules: parseCss(`${GOOD_ROOT} :root { --text-tertiary: #9a9590; }`) }),
  C3: (s) => ({ ...s, rules: parseCss(`${GOOD_ROOT} .flow-card__bar { background: var(--you); }`) }),
  C5: (s) => ({ ...s, rules: parseCss(GOOD_ROOT.replace('--s6: #23955a', '--s6: #d64541')) }),
  F3: (s) => ({ ...s, rules: parseCss(`${GOOD_ROOT} .x { animation: blink 0.2s steps(1) infinite; }`) }),
};
function selfTest() {
  const failures = [];
  for (const [id, , fn] of RULES) {
    const clean = fn(GOOD());
    if (clean.length) failures.push(`${id} flags the clean sample: ${clean[0]}`);
    if (!fn(BAD[id](GOOD())).length) failures.push(`${id} does not catch its known-bad sample — the rule has no teeth`);
    (BAD_EXTRA[id] || []).forEach((bad, k) => { if (!fn(bad(GOOD())).length) failures.push(`${id} does not catch known-bad sample #${k + 2} — a blind spot is back`); });
  }
  return failures;
}

// ── the room's sources ──
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) { if (name !== 'node_modules' && name !== 'mocks') walk(full, out); }
    else out.push(full);
  }
  return out;
}
function load() {
  if (!existsSync(SRC)) throw new Error(`no room sources at ${SRC}`);
  const files = walk(SRC);
  const css = files.filter((f) => f.endsWith('.css')).map((f) => readFileSync(f, 'utf8')).join('\n');
  const ts = files.filter((f) => /\.(tsx?|jsx?)$/.test(f) && !/\.test\.(tsx?|jsx?)$/.test(f))
    .map((f) => ({ rel: relative(APP, f).replace(/\\/g, '/'), text: readFileSync(f, 'utf8') }));
  const html = existsSync(join(APP, 'index.html')) ? readFileSync(join(APP, 'index.html'), 'utf8') : '';
  return { rules: parseCss(css), ts, html };
}

// ── run ──
let failed = 0;
const st = selfTest();
if (st.length) {
  console.log('✗ self-test — a rule lost its teeth:');
  for (const s of st) console.log(`    ${s}`);
  failed += 1;
} else console.log(`✓ self-test — all ${RULES.length} rules catch their known-bad sample`);

const sources = load();
for (const [id, name, fn] of RULES) {
  const problems = fn(sources);
  if (!problems.length) { console.log(`✓ ${id} ${name}`); continue; }
  failed += 1;
  console.log(`✗ ${id} ${name} — ${problems.length} problem(s)`);
  for (const pr of problems.slice(0, 12)) console.log(`    ${pr}`);
  if (problems.length > 12) console.log(`    … and ${problems.length - 12} more`);
}

console.log(`\nContract: artifacts/graph-flow-ui/v2/CONTRACT.md · room: ${relative(ROOT, APP).replace(/\\/g, '/') || '.'}`);
if (failed) {
  console.error(`ROOM CONTRACT FAILED (${failed} rule(s))`);
  process.exit(1);
}
console.log('The room meets the source-checkable rules of its design contract.');
