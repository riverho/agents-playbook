#!/usr/bin/env node
// scripts/check-fleet-mode.mjs
// ----------------------------------------------------------------------------
// Structural check for the `fleet` mode (the always-on fleet orchestrator pack).
// Asserts the mode is registered in BOTH authorities, that its file is
// well-formed, that its pack-local indices resolve to real files, that the pack
// is carry-on, that its pack.yaml inventory is honest, and that the persona
// actually teaches the v0.8 surfaces it claims to drive (the Flow room server,
// the tick, the comment rows, the person-only acts).
//
// Behavioral correctness — the pack mounting from YAML alone, and the real room
// server serving the state projection — is checked by test-fleet-mode.mjs, which
// this mode's kind:check principle runs alongside this file:
//   node scripts/check-fleet-mode.mjs && node scripts/test-fleet-mode.mjs
// ----------------------------------------------------------------------------

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

const readYaml = (rel) => yaml.load(readFileSync(resolve(root, rel), 'utf8'));
const MODE_ID = 'fleet';
const MODE_FILE = `modes/${MODE_ID}.yaml`;
const VALID_KINDS = new Set(['check', 'advice']);

// ---------------------------------------------------------------- registration
check('fleet is registered in playbook.yaml and modes/index.yaml', () => {
  const master = readYaml('playbook.yaml');
  if (!master.modes || master.modes[MODE_ID] !== MODE_FILE) {
    throw new Error(`playbook.yaml modes:${MODE_ID} must be "${MODE_FILE}" (got ${JSON.stringify(master.modes?.[MODE_ID])})`);
  }
  const catalog = readYaml('modes/index.yaml');
  const entry = (catalog.modes || []).find((m) => m && m.id === MODE_ID);
  if (!entry) throw new Error(`"${MODE_ID}" is missing from modes/index.yaml — the menu would lie`);
  if (!entry.description || !String(entry.description).trim()) throw new Error('catalog entry needs a description');
  if (!entry.abstract || !String(entry.abstract).trim()) throw new Error('catalog entry needs a non-empty abstract');
});

// ------------------------------------------------------------------ the mode file
check('modes/fleet.yaml parses and is well-formed', () => {
  if (!existsSync(resolve(root, MODE_FILE))) throw new Error(`${MODE_FILE} is missing`);
  const doc = readYaml(MODE_FILE);
  if (!doc || typeof doc !== 'object') throw new Error('empty or invalid document');
  if (doc.id !== MODE_ID) throw new Error(`id is "${doc.id}", expected "${MODE_ID}"`);
  if (!doc.description || typeof doc.description !== 'string') throw new Error('description is missing');
  // This is a PERSONA mode: the directive carries the operating manual, so unlike
  // coding.yaml an empty string here would leave the mode with no persona at all.
  if (typeof doc.directive !== 'string' || !doc.directive.trim()) {
    throw new Error('directive must be a non-empty string — the fleet persona lives there');
  }
  for (const key of ['skills_index', 'processes_index']) {
    if (!doc[key] || !existsSync(resolve(root, doc[key]))) {
      throw new Error(`${key} points at a missing file: ${JSON.stringify(doc[key])}`);
    }
  }
});

check('principles are typed, unique, and the mode is not faith-based', () => {
  const doc = readYaml(MODE_FILE);
  const prs = Array.isArray(doc.principles) ? doc.principles : [];
  if (!prs.length) throw new Error('principles must be a non-empty array');
  const seen = new Set();
  for (const pr of prs) {
    if (!pr || typeof pr !== 'object') throw new Error('a principle is not a mapping');
    if (!pr.id || typeof pr.id !== 'string') throw new Error('a principle has no id');
    if (seen.has(pr.id)) throw new Error(`duplicate principle id "${pr.id}"`);
    seen.add(pr.id);
    if (!VALID_KINDS.has(pr.kind)) throw new Error(`principle "${pr.id}" has kind "${pr.kind}" (must be check|advice)`);
    if (!pr.text || typeof pr.text !== 'string') throw new Error(`principle "${pr.id}" has no text`);
    if (pr.kind === 'check' && (!pr.check || typeof pr.check !== 'string')) {
      throw new Error(`kind:check principle "${pr.id}" must declare an executable check: command`);
    }
    if (pr.kind === 'advice' && 'check' in pr) {
      throw new Error(`kind:advice principle "${pr.id}" must not declare a check command`);
    }
  }
  const wired = prs.filter((pr) => pr.kind === 'check');
  if (!wired.length) throw new Error('no kind:check principle — the mode would be verified on prose alone');
  if (!wired.some((pr) => /check-fleet-mode\.mjs/.test(pr.check))) {
    throw new Error('no kind:check principle runs scripts/check-fleet-mode.mjs');
  }
  if (!wired.some((pr) => /test-fleet-mode\.mjs/.test(pr.check))) {
    throw new Error('no kind:check principle runs scripts/test-fleet-mode.mjs — the room server would be unverified');
  }
});

// ------------------------------------------------------- pack indices and layout
check('pack-local skill/process indices resolve to real files', () => {
  const doc = readYaml(MODE_FILE);
  if (!/^modes\//.test(doc.skills_index) || !/^modes\//.test(doc.processes_index)) {
    throw new Error('fleet must be a pack (indices under modes/) — the procedure has to be a file, not prose');
  }
  const skillIds = [];
  for (const [key, listKey] of [['skills_index', 'skills'], ['processes_index', 'processes']]) {
    const idx = readYaml(doc[key]);
    const list = Array.isArray(idx?.[listKey]) ? idx[listKey] : [];
    if (!list.length) throw new Error(`${doc[key]} lists no ${listKey}`);
    for (const entry of list) {
      if (!entry?.id) throw new Error(`${doc[key]}: an entry has no id`);
      if (!entry.file || !existsSync(resolve(root, entry.file))) {
        throw new Error(`${doc[key]}: entry "${entry.id}" references a missing file: ${entry.file}`);
      }
      if (listKey === 'skills') {
        skillIds.push(entry.id);
        if (!entry.process) throw new Error(`skill "${entry.id}" has no process`);
      }
    }
  }
  if (!skillIds.includes('fleet-orchestration')) {
    throw new Error(`the pack must register fleet-orchestration (got: ${skillIds.join(', ') || 'none'})`);
  }
  const processIds = (readYaml(doc.processes_index).processes || []).map((p) => p.id);
  for (const id of skillIds) {
    if (!processIds.includes(id)) throw new Error(`skill "${id}" points at a process that is not in the process index`);
  }
});

check('fleet pack is carry-on (no package.json / node_modules)', () => {
  const walk = (dirRel) => {
    for (const ent of readdirSync(resolve(root, dirRel), { withFileTypes: true })) {
      if (ent.isDirectory()) {
        if (ent.name === 'node_modules') throw new Error(`pack is not carry-on: ${dirRel}/node_modules`);
        walk(`${dirRel}/${ent.name}`);
      } else if (ent.name === 'package.json') {
        throw new Error(`pack is not carry-on: ${dirRel}/package.json`);
      }
    }
  };
  walk(`modes/${MODE_ID}`);
});

check('pack.yaml inventory is honest (every pack file listed, none listed twice)', () => {
  const r = spawnSync(process.execPath, [resolve(root, 'scripts/check-pack-manifest.mjs'), MODE_ID], {
    cwd: root, encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`check-pack-manifest failed:\n${(r.stdout || '') + (r.stderr || '')}`);
});

// ------------------------------------------------------------- persona coverage
// The mode makes promises about surfaces it drives. A comment row nobody reads and
// a room nobody serves are the failure modes this file exists to catch, so the
// promises are asserted against the mode's OWN text (directive + process + skill).
check('the persona teaches the v0.8 surfaces it claims to drive', () => {
  const doc = readYaml(MODE_FILE);
  const parts = [doc.directive];
  for (const rel of ['modes/fleet/processes/fleet-orchestration.yaml', 'modes/fleet/skills/fleet-orchestration/SKILL.md']) {
    if (existsSync(resolve(root, rel))) parts.push(readFileSync(resolve(root, rel), 'utf8'));
  }
  const text = parts.join('\n').replace(/\s+/g, ' ');
  const required = [
    ['the Flow room server', /\bpb ui\b/],
    ['the orchestrator pass', /\bpb tick\b/],
    ['reading the comments', /\bpb comment\b/],
    ['the one-call comment sweep', /runcard list --json/],
    ['the room polling token', /\bpb state --json\b/],
    ['the graph projection', /\bpb graph --json\b/],
    ['the person-only decision', /\bpb decide\b/],
    ['worker dispatch', /\bpb worker\b/],
    ['clearing abandoned claims', /\bpb release\b/],
    ['the end goal', /stop_checks/],
    ['the deferral rule', /\bdefer/],
  ];
  const missing = required.filter(([, re]) => !re.test(text)).map(([what]) => what);
  if (missing.length) throw new Error(`the mode never mentions: ${missing.join(', ')}`);
});

check('no scaffold block by intent — and the intent is written down', () => {
  const src = readFileSync(resolve(root, MODE_FILE), 'utf8');
  const doc = yaml.load(src);
  if (!('scaffold' in doc)) {
    // Absence is deliberate (the mode is driven by `pb tick`, not by item
    // scaffolding). Keep the reason from being deleted silently.
    if (!/no `?scaffold`? block by intent/i.test(src)) {
      throw new Error('the mode has no scaffold block but does not say why — document the intent or declare one');
    }
    return;
  }
  const s = doc.scaffold;
  for (const key of ['config', 'items', 'skill', 'id_field', 'goal_template', 'check_field']) {
    if (!s[key]) throw new Error(`scaffold.block is incomplete: missing "${key}"`);
  }
  if (!existsSync(resolve(root, s.config))) throw new Error(`scaffold.config does not exist: ${s.config}`);
});

// ------------------------------------------------------------------- resolution
check('pb mode show fleet resolves the persona and its pack menu', () => {
  const r = spawnSync(process.execPath, [resolve(root, 'scripts/pb.mjs'), 'mode', 'show', MODE_ID], {
    cwd: root, encoding: 'utf8',
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.status !== 0) throw new Error(`\`pb mode show ${MODE_ID}\` exited ${r.status}\n${out.trim()}`);
  for (const [what, re] of [['the mode header', /Mode: fleet/], ['the pack skill', /fleet-orchestration/], ['the directive', /Directive:/]]) {
    if (!re.test(out)) throw new Error(`output is missing ${what}\n${out.trim()}`);
  }
});

// ------------------------------------------------------------------- run
let pass = 0;
let fail = 0;
for (const { name, fn } of checks) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    pass++;
  } catch (e) {
    console.error(`  FAIL  ${name}\n        ${e.message}`);
    fail++;
  }
}
console.log(`\ncheck-fleet-mode: ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
