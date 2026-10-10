#!/usr/bin/env node
// check-approved.mjs — exits 0 only when every named decision is recorded as approved in
// artifacts/graph-flow-ui/APPROVED.md. Used as the acceptance check of manual approval tasks:
// a person approves, the Lead records the row, and the gate proves the row is there.
//
//   node scripts/check-approved.mjs D23 D24 D25
//
// A decision counts as approved only on a table row `| Dnn | ... | approved ... |`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'artifacts', 'graph-flow-ui', 'APPROVED.md');
const ids = process.argv.slice(2);
if (!ids.length || ids.some(id => !/^D\d+$/.test(id))) {
  console.error('usage: node scripts/check-approved.mjs D<n> [D<n> ...]');
  process.exit(2);
}
const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
const missing = ids.filter(id => !text.split('\n').some(line => {
  const cells = line.split('|').map(c => c.trim());
  return cells[1] === id && /^approved\b/.test(cells.at(-2) ?? '');
}));
if (missing.length) {
  console.error(`not approved in APPROVED.md: ${missing.join(', ')}`);
  process.exit(1);
}
console.log(`approved: ${ids.join(', ')}`);
