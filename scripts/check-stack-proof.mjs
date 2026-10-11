import { openRoom, sleep } from './lib-room-browser.mjs';
import { makeFixture } from './test-fixture-playbook.mjs';
import { rmSync } from 'node:fs';

const ts = new Date().toISOString();
const tasks = ['unproven', 'mixed-proof', 'mixed-none', 'proven'].map((id, k) => ({ id, title: id, layer: k === 0 ? 'L0' : k === 3 ? 'L2' : 'L1' }));
const journal = tasks.map((t, k) => ({ seq: k + 1, ts, task: t.id, agent: 'test', action: 'execute', status: 'done', checks: t.id === 'proven' || t.id === 'mixed-proof' ? 'passed' : 'none', notes: t.id }));
const state = Object.fromEntries(tasks.map((t, k) => [t.id, { status: 'done', seq: k + 1, updated_at: ts }]));
const fixture = makeFixture({ tasks, journal, state, layers: ['L0', 'L1', 'L2'].map(id => ({ id, name: id })) });
let room;
const problems = [];
try {
  room = await openRoom({ playbookRoot: fixture });
  await room.navigate();
  for (const zoom of [1, 0.05]) {
    await room.evaluate(`window.__flowRoom.setViewport({ x: 0, y: 0, zoom: ${zoom} })`);
    await sleep(150);
    for (const [band, proven] of [['L0', false], ['L1', false], ['L2', true]]) {
      const placed = await room.evaluate(`window.__flowRoom.getNodes().find(n => n.type === 'flowStack' && n.data.node.stack.band === '${band}')`);
      if (!placed) { problems.push(`${band}: stack missing`); continue; }
      await room.evaluate(`window.__flowRoom.setCenter(${placed.position.x + placed.width / 2}, ${placed.position.y + placed.height / 2}, { zoom: ${zoom} })`);
      await sleep(100);
      const result = await room.evaluate(`(() => {
        const stack = [...document.querySelectorAll('.flow-face--stack')].find(n => n.closest('.react-flow__node').dataset.id === '${placed.id}');
        return stack ? { state: stack.querySelector('.flow-st')?.className, beacon: stack.dataset.beacon, label: stack.querySelector('.flow-st')?.textContent, color: getComputedStyle(stack.querySelector('.flow-beacon')).backgroundColor } : null;
      })()`);
      console.log(`${band} at ${zoom}: ${JSON.stringify(result)}`);
      if (!result) { problems.push(`${band} at ${zoom}: stack did not mount`); continue; }
      const claimsDone = result.beacon === 'done' || /flow-st--done/.test(result.state);
      if (claimsDone !== proven) problems.push(`C4 ${band} at ${zoom}: ${proven ? 'proven stack lost Done' : 'unproven or mixed stack claims Done'}`);
      if (!proven && result.color === 'rgb(35, 149, 90)') problems.push(`C4 ${band} at ${zoom}: unproven stack has a green done beacon`);
      if (!proven && !/Closed/.test(result.label)) problems.push(`C4 ${band}: unproven state needs a word as well as a color`);
    }
  }
} finally { if (room) await room.close(); rmSync(fixture, { recursive: true, force: true }); }
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log('Stack proof holds: only an entirely proven stack claims Done, at full and overview zoom.');
