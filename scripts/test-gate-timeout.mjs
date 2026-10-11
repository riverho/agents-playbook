#!/usr/bin/env node
// scripts/test-gate-timeout.mjs — plan-20261010-008
// ----------------------------------------------------------------------------
// A layer GATE had its own hard-coded 120000ms, and a gate killed by it was reported as
// a FAILING gate. Now:
//   1. a slow gate past its limit is TIMEOUT — named with its limit and where the limit
//      came from — and never listed among the FAILING gates;
//   2. it is still not a pass: the layer above stays unclaimable;
//   3. a gate that exits non-zero is still FAIL;
//   4. the limit resolves layer gate_timeout_ms → master layer_gate_timeout_ms →
//      PB_GATE_TIMEOUT_MS → default, and a bad value warns and falls back;
//   5. the recorded result a claim leaves behind says timeout, and pb graph shows it.
// ----------------------------------------------------------------------------
import { makeFixture, makeSuite, pbJson, runPb } from './test-fixture-playbook.mjs';

const t = makeSuite('test-gate-timeout');
const { ok } = t;
const SLOW = 'node -e "setTimeout(() => {}, 3000)"';
const RED = 'node -e "process.exit(1)"';
const tasks = [
  { id: 'base', title: 'L0 work', layer: 'L0' },
  { id: 'above', title: 'L1 work', layer: 'L1', dependencies: [] },
];

// 1–2: a slow gate with a tight layer limit
{
  const root = t.track(makeFixture({ layers: [{ id: 'L0', name: 'substrate', gate: SLOW, gate_timeout_ms: 800 }, { id: 'L1', name: 'surfaces' }], tasks }));
  const r = runPb(root, ['plan', '--layers', '--check-gates']);
  ok('a slow gate is TIMEOUT with its limit and source', /gate TIMEOUT \(limit 800ms from gate_timeout_ms on layer \[L0\]\)/.test(r.out), r.out);
  ok('…listed as NO VERDICT', /Gates with NO VERDICT: L0 \(timed out after \d+ms, limit 800ms/.test(r.out), r.out);
  ok('…and never among the FAILING gates', !/Gates FAILING: .*L0/.test(r.out) && !/gate FAIL\b/.test(r.out), r.out);
  const g = pbJson(root, ['plan', '--layers', '--check-gates', '--json']);
  const above = g.tasks.find((x) => x.id === 'above');
  ok('the layer above is still blocked — a timeout is not a pass', above && above.ready === false && above.gate_blocked_by.some((b) => b.layer === 'L0'), JSON.stringify(above));
  ok('the plan result carries the outcome', g.gate_results.L0?.outcome === 'timeout', JSON.stringify(g.gate_results));
  // 5: a claim records the result; pb graph shows timeout
  runPb(root, ['next', '--claim'], { agent: 'lead' });
  const graph = pbJson(root, ['graph', '--json']);
  ok('a recorded gate timeout reads as timeout in pb graph', graph.layers.find((l) => l.id === 'L0')?.gate_result?.state === 'timeout', JSON.stringify(graph.layers[0]));
}
// 3: a red gate is still FAIL
{
  const root = t.track(makeFixture({ layers: [{ id: 'L0', name: 'substrate', gate: RED }, { id: 'L1', name: 'surfaces' }], tasks }));
  const r = runPb(root, ['plan', '--layers', '--check-gates']);
  ok('a gate that exits 1 is FAIL', /gate FAIL\b/.test(r.out) && /Gates FAILING: L0/.test(r.out), r.out);
  ok('…and not called a timeout', !/TIMEOUT|NO VERDICT/.test(r.out));
}
// 4: env limit, and a bad layer value falls back with a warning
{
  const root = t.track(makeFixture({ layers: [{ id: 'L0', name: 'substrate', gate: SLOW }, { id: 'L1', name: 'surfaces' }], tasks }));
  const r = runPb(root, ['plan', '--layers', '--check-gates'], { env: { PB_GATE_TIMEOUT_MS: '700' } });
  ok('PB_GATE_TIMEOUT_MS sets the limit when the layer has none', /gate TIMEOUT \(limit 700ms from env PB_GATE_TIMEOUT_MS\)/.test(r.out), r.out);
  const bad = t.track(makeFixture({ layers: [{ id: 'L0', name: 'substrate', gate: SLOW, gate_timeout_ms: '"soon"' }, { id: 'L1', name: 'surfaces' }], tasks }));
  const rb = runPb(bad, ['plan', '--layers', '--check-gates'], { env: { PB_GATE_TIMEOUT_MS: '700' } });
  ok('a bad gate_timeout_ms warns and falls back', /gate_timeout_ms on layer \[L0\] is not a positive number/.test(rb.err) && /limit 700ms from env PB_GATE_TIMEOUT_MS/.test(rb.out), rb.combined);
}
// a fast gate still passes
{
  const root = t.track(makeFixture({ layers: [{ id: 'L0', name: 'substrate', gate: 'node -e "process.exit(0)"', gate_timeout_ms: 5000 }, { id: 'L1', name: 'surfaces' }], tasks }));
  const r = runPb(root, ['plan', '--layers', '--check-gates']);
  ok('a gate that exits 0 in time is PASS', /gate PASS/.test(r.out), r.out);
}

t.finish();
