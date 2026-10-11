import { makeFixture, makeSuite, runPb, pbJson, readJournal, BASE_ENV } from './test-fixture-playbook.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const s = makeSuite('version races');
const pause = ms => new Promise(r => setTimeout(r, ms));
const launch = (root, args, env = {}) => {
  const child = spawn(process.execPath, [join(root, 'scripts/pb.mjs'), ...args], { cwd: root, env: { ...BASE_ENV, ...env }, windowsHide: true });
  let out = '', err = '';
  child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { err += d; });
  return { done: new Promise(r => child.on('exit', code => r({ code, out, err }))), output: () => out + err };
};
const open = root => {
  const r = runPb(root, ['version', 'new', '--name', 'v1', '--goal', 'race', '--stop-check', 'node close-stop.mjs']);
  const f = join(root, 'memory/cycle.md');
  writeFileSync(f, readFileSync(f, 'utf8').replace(/\(Your host memory is the PAST[\s\S]*?memory\.\)/, 'None.'));
  return r;
};
const setup = () => {
  const root = s.track(makeFixture({ loops: 'active: null\nloops: []\n' }));
  writeFileSync(join(root, 'close-stop.mjs'), "import{writeFileSync}from'node:fs';writeFileSync('closing.marker','entered');setTimeout(()=>{},1000);");
  s.ok('fixture version opens', open(root).code === 0);
  return root;
};

const root = setup();
const closing = launch(root, ['version', 'close']);
for (let i = 0; i < 100 && !existsSync(join(root, 'closing.marker')); i++) await pause(20);
s.ok('close reached its stop check', existsSync(join(root, 'closing.marker')));
const planning = launch(root, ['plan', '--goal', 'racing feature', '--kind', 'feature', '--check', 'node -v']);
const [c, p] = await Promise.all([closing.done, planning.done]);
s.ok('close succeeds without abandoned work', c.code === 0, c.err);
s.ok('queued plan rechecks version and refuses after close', p.code !== 0 && /V2|V4/.test(p.err), p.out + p.err);
const version = pbJson(root, ['version', 'list', '--json']).versions[0];
s.ok('closed version contains no newly planned todo', version.state === 'closed' && !version.task_counts.todo && !readFileSync(join(root, 'memory/backlog.yaml'), 'utf8').includes('racing feature'));

const other = setup();
const planned = runPb(other, ['plan', '--goal', 'finished', '--kind', 'fix', '--check', 'node -v']);
const task = /Planned \[([^\]]+)\]/.exec(planned.out)?.[1];
s.ok('race fixture has a card', !!task);
s.ok('card completes before close', runPb(other, ['record', '--task', task, '--action', 'execute', '--status', 'done', '--notes', 'finished']).code === 0);
const recording = launch(other, ['record', '--task', task, '--action', 'execute', '--status', 'done', '--notes', 'queued writer'], { PB_TXN_TEST_PRELOCK_MS: '2500' });
// This stdout line is emitted after the initial guard and before the transaction, so the
// test does not guess whether the queued writer has reached the vulnerable window.
for (let i = 0; i < 100 && !/Running .*acceptance check/.test(recording.output()); i++) await pause(20);
s.ok('queued record passed its initial guard', /Running .*acceptance check/.test(recording.output()), recording.output());
const closed = await launch(other, ['version', 'close']).done;
s.ok('version closes while the writer waits', closed.code === 0, closed.err);
const recorded = await recording.done;
s.ok('queued record rechecks V7 after taking the lock', recorded.code !== 0 && /V7/.test(recorded.err), recorded.out + recorded.err);
s.ok('refused queued record appended nothing', !readJournal(other).some(r => r.notes === 'queued writer'));
s.ok('version remains closed with its original snapshot', pbJson(other, ['version', 'list', '--json']).versions[0].state === 'closed');

const writes = setup();
const plannedWrite = runPb(writes, ['plan', '--goal', 'writer target', '--kind', 'fix', '--check', 'node -v']);
const writeTask = /Planned \[([^\]]+)\]/.exec(plannedWrite.out)?.[1];
s.ok('writer target completes', runPb(writes, ['record', '--task', writeTask, '--action', 'execute', '--status', 'done', '--notes', 'complete']).code === 0);
const closeWrites = launch(writes, ['version', 'close']);
for (let i = 0; i < 100 && !existsSync(join(writes, 'closing.marker')); i++) await pause(20);
const cycleBefore = readFileSync(join(writes, 'memory/cycle.md'), 'utf8');
const attach = launch(writes, ['attach', '--task', writeTask, '--path', 'SKILL.md']);
const cycle = launch(writes, ['cycle', '--edit', '--stop', 'racing edit']);
const [closedWrites, attached, edited] = await Promise.all([closeWrites.done, attach.done, cycle.done]);
s.ok('writer race version closes', closedWrites.code === 0, closedWrites.err);
s.ok('queued attachment refuses after close', attached.code !== 0 && /V7/.test(attached.err), attached.out + attached.err);
s.ok('queued cycle edit refuses after close', edited.code !== 0 && /V7/.test(edited.err), edited.out + edited.err);
s.ok('closed cycle and card documents unchanged', readFileSync(join(writes, 'memory/cycle.md'), 'utf8') === cycleBefore && !pbJson(writes, ['task', 'show', writeTask, '--json']).task.docs);

const worker = setup();
const workerPlan = runPb(worker, ['plan', '--goal', 'worker target', '--kind', 'fix', '--check', 'node -v']);
const workerTask = /Planned \[([^\]]+)\]/.exec(workerPlan.out)?.[1];
s.ok('worker target completes', runPb(worker, ['record', '--task', workerTask, '--action', 'execute', '--status', 'done', '--notes', 'complete']).code === 0);
const git = args => spawnSync('git', ['-C', worker, ...args], { encoding: 'utf8', env: BASE_ENV });
s.ok('worker fixture git initializes', git(['init', '-q']).status === 0);
git(['add', 'playbook.yaml', 'SKILL.md']);
s.ok('worker fixture has a base commit', git(['-c', 'user.name=Version test', '-c', 'user.email=version-test@example.invalid', 'commit', '-qm', 'fixture']).status === 0);
const closeWorker = launch(worker, ['version', 'close']);
for (let i = 0; i < 100 && !existsSync(join(worker, 'closing.marker')); i++) await pause(20);
const workerPath = join(worker, 'review-worker');
const createWorker = launch(worker, ['worker', 'create', workerTask, '--agent', 'review-worker', '--execute', '--worktree', workerPath]);
const [workerClosed, workerCreated] = await Promise.all([closeWorker.done, createWorker.done]);
s.ok('worker race version closes', workerClosed.code === 0, workerClosed.err);
s.ok('queued worker creation refuses before git changes', workerCreated.code !== 0 && /V7/.test(workerCreated.err), workerCreated.out + workerCreated.err);
s.ok('refused worker leaves no orphan worktree or branch', !existsSync(workerPath) && git(['show-ref', '--verify', '--quiet', `refs/heads/agent/${workerTask}-review-worker`]).status !== 0);
s.ok('invalid worker does not leak lifecycle lock', !existsSync(join(worker, 'memory/backlog-state.json.lock')));

const liveWorker = setup();
const livePlan = runPb(liveWorker, ['plan', '--goal', 'live worker', '--kind', 'fix', '--check', 'node -v']);
const liveTask = /Planned \[([^\]]+)\]/.exec(livePlan.out)?.[1];
const noGit = runPb(liveWorker, ['worker', 'create', liveTask, '--execute']);
s.ok('worker failure releases the lifecycle lock', noGit.code !== 0 && !existsSync(join(liveWorker, 'memory/backlog-state.json.lock')));
const reviewed = runPb(liveWorker, ['worker', 'checker', liveTask, '--verdict', 'pass', '--notes', 'fixture review']);
s.ok('versioned checker records without nested-lock deadlock', reviewed.code === 0, reviewed.combined);
s.ok('versioned worker row sequence is unique', readJournal(liveWorker).map(r => r.seq).every((seq, i, rows) => i === 0 || seq > rows[i - 1]));
s.finish();
