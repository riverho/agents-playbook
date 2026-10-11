// ============================================================================
//  harness.mjs — CLI harness adapters for the standalone room (plan-20261010-015, P4b).
// ----------------------------------------------------------------------------
//  "Chat" needs a harness; a comment does not. So the room ALWAYS records a person's
//  question as a journal row first (`pb comment --intent question`), and only then — if a
//  harness CLI is on this machine — hands the question to it and streams the answer back.
//  With no harness the room says so ("recorded · not dispatched") instead of going dead.
//
//  One interface for every adapter:  { id, label, detect(env), argv, send(prompt, ctx) }
//    · detect() looks for the binary on PATH (with PATHEXT on Windows). It never runs it.
//    · send() runs the CLI non-interactively with the prompt on STDIN, never as an
//      argument: a person's text must not reach a shell (npm installs Windows shims as
//      .cmd files, which run through cmd.exe). No permission-bypass flag is ever passed.
//    · `stub` is a node one-liner for hermetic tests. Only it is exercised by the tests;
//      claude / codex / opencode are detected, and their non-interactive flags are the
//      documented ones, but no test here talks to a real model.
// ============================================================================
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

const WIN = process.platform === 'win32';

/** The first file on PATH that is this command, or null. Never executes anything. */
export function whichOnPath(name, env = process.env) {
  const dirs = String(env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean);
  const exts = WIN ? String(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  for (const dir of dirs) {
    for (const ext of WIN ? ['', ...exts] : exts) {
      const candidate = join(dir, name + ext.toLowerCase());
      const upper = join(dir, name + ext);
      for (const p of new Set([candidate, upper])) {
        try { if (existsSync(p) && statSync(p).isFile() && (!WIN || ext)) return p; } catch { /* unreadable */ }
      }
    }
  }
  return null;
}

/** The adapters. `argv` takes no user text: the prompt goes to stdin. */
export const ADAPTERS = [
  { id: 'claude', label: 'Claude Code', bin: 'claude', argv: ['-p'] },
  { id: 'codex', label: 'Codex', bin: 'codex', argv: ['exec', '-'] },
  { id: 'opencode', label: 'OpenCode', bin: 'opencode', argv: ['run'] },
];
const STUB = {
  id: 'stub',
  label: 'Stub (tests)',
  // reads the prompt from stdin and streams a reply in two chunks, like a real CLI would
  script: "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{process.stdout.write('stub heard: ');setTimeout(()=>{process.stdout.write(s.split(/\\r?\\n/).filter(Boolean).pop()||'');process.exit(0)},50)})",
};

/** What is on this machine. The stub is offered only when PB_UI_HARNESS_STUB=1 (tests). */
export function detectHarnesses(env = process.env) {
  const found = [];
  for (const a of ADAPTERS) {
    const path = whichOnPath(a.bin, env);
    if (path) found.push({ id: a.id, label: a.label, path });
  }
  if (env.PB_UI_HARNESS_STUB === '1') found.push({ id: STUB.id, label: STUB.label, path: process.execPath });
  return found;
}

/** The prompt a harness gets: the question, and where the truth lives. */
export function buildPrompt({ task, title, text, root }) {
  return [
    `You are helping a person with a task in an Agent-Playbook at ${root}.`,
    `Task ${task}: ${title}`,
    `Read it with: node scripts/pb.mjs task show ${task} --json   (and pb runcard show ${task} --json for its history).`,
    'Answer the question briefly and concretely. Do not change any files.',
    '',
    `The person asks: ${text}`,
  ].join('\n');
}

/**
 * Run one harness turn. onEvent({type:'text', text}) per chunk, then
 * onEvent({type:'done', code}) or onEvent({type:'error', message}). Returns stop().
 */
export function sendToHarness(id, prompt, { cwd, env = process.env, onEvent, timeoutMs = 300000 }) {
  let child;
  if (id === STUB.id) {
    child = spawn(process.execPath, ['-e', STUB.script], { cwd, env, windowsHide: true });
  } else {
    const a = ADAPTERS.find((x) => x.id === id);
    const path = a ? whichOnPath(a.bin, env) : null;
    if (!a || !path) { onEvent({ type: 'error', message: `no ${id} harness on this machine` }); return () => {}; }
    // a .cmd/.bat shim must go through cmd.exe; its arguments are fixed strings, never user text
    // a .cmd/.bat shim runs through cmd.exe; its arguments are fixed strings, never user
    // text. The path is quoted (an install under "Program Files" has a space), and with /s
    // cmd strips exactly the outer pair: cmd /d /s /c ""C:\a b\claude.cmd" -p"
    child = /\.(cmd|bat)$/i.test(path)
      ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${path}" ${a.argv.join(' ')}"`], { cwd, env, windowsHide: true, windowsVerbatimArguments: true })
      : spawn(path, a.argv, { cwd, env, windowsHide: true });
  }
  let done = false;
  const finish = (ev) => { if (done) return; done = true; clearTimeout(timer); onEvent(ev); };
  child.stdout.on('data', (d) => { if (!done) onEvent({ type: 'text', text: String(d) }); });
  let err = '';
  child.stderr.on('data', (d) => { err += String(d); });
  child.on('error', (e) => finish({ type: 'error', message: e.message }));
  child.on('close', (code) => finish(code === 0 ? { type: 'done', code } : { type: 'error', message: `exited ${code}${err.trim() ? `: ${err.trim().split(/\r?\n/).slice(-3).join(' ')}` : ''}` }));
  child.stdin.end(prompt);
  const stop = () => {
    if (done) return;
    try {
      if (WIN) execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      else child.kill('SIGKILL');
    } catch { /* already gone */ }
    finish({ type: 'error', message: 'stopped' });
  };
  const timer = setTimeout(() => { stop(); }, timeoutMs);
  return stop;
}
