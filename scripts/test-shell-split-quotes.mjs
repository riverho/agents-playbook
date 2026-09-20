// scripts/test-shell-split-quotes.mjs
// ----------------------------------------------------------------------------
// shellSplit is the tokenizer behind EVERY acceptance_check and every layer gate:
// a command string is split into argv and run with cwd = playbook root. Its output
// was wrong for the most ordinary shape there is — a program invoked with one
// double-quoted argument that itself contains single quotes:
//
//     node -e "process.exit(require('fs').existsSync('x')?0:1)"
//
// became argv ["node", "-e", "process.exit(require(fs).existsSync(memory/x)?0:1)"]
// — the inner quotes were DELETED, so node received `require(fs)` and died with
// `TypeError: The "id" argument must be of type string`. The check then failed for a
// reason that had nothing to do with the work, which is the worst kind of red: a gate
// that can never go green however correct the code is.
//
// The rule now: a quote character is SYNTAX only where a word begins. A quote inside
// a word is ordinary text, so the quoted argument survives intact while `cmd "a b"`,
// `cmd 'a b'`, an empty quoted argument and a quoted command path keep working.
//
// Every case below uses a command that actually CONTAINS a quote character — the
// first version of this test asserted token counts on quote-free commands and passed
// against the broken tokenizer, which is exactly the vacuous green this suite exists
// to refuse.
// ----------------------------------------------------------------------------
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.error(`  FAIL  ${name}${extra ? `\n        ${extra}` : ''}`); fail++; }
}

// shellSplit is not exported (it is an internal of the CLI), so the contract is pinned
// by extracting the shipped function source and evaluating it: the test cannot drift
// from the implementation it describes.
const source = readFileSync(resolve('scripts/pb.mjs'), 'utf8');
const start = source.indexOf('function shellSplit(cmd) {');
if (start === -1) {
  console.error('  FAIL  could not locate shellSplit in scripts/pb.mjs — the tokenizer was renamed or moved');
  process.exit(1);
}
let depth = 0;
let end = -1;
for (let i = source.indexOf('{', start); i < source.length; i++) {
  if (source[i] === '{') depth++;
  else if (source[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
}
const shellSplit = new Function(`${source.slice(start, end)}; return shellSplit;`)();
const show = (cmd) => `${JSON.stringify(cmd)} → ${JSON.stringify(shellSplit(cmd))}`;
const is = (cmd, want) => JSON.stringify(shellSplit(cmd)) === JSON.stringify(want);

// --- the shape that was broken -------------------------------------------------
{
  const cmd = `node -e "process.exit(require('fs').existsSync('memory/gate.ok')?0:1)"`;
  const want = ['node', '-e', "process.exit(require('fs').existsSync('memory/gate.ok')?0:1)"];
  ok('an unquoted argument keeps its inner single quotes intact', is(cmd, want), show(cmd));
  ok('the quoted argument is ONE token, not split at the inner quotes',
    shellSplit(cmd).length === 3, show(cmd));
}

// --- quote characters must survive wherever they are meant literally -----------
{
  ok('a double-quoted argument keeps inner double quotes',
    is('node -e "console.log(JSON.stringify(\\"hi\\"))"', ['node', '-e', 'console.log(JSON.stringify("hi"))']),
    show('node -e "console.log(JSON.stringify(\\"hi\\"))"'));
  ok('inner quotes survive in a single-quoted argument too',
    is("bash -c 'echo \"x\"'", ['bash', '-c', 'echo "x"']),
    show("bash -c 'echo \"x\"'"));
  ok('a quoted path containing an apostrophe stays one token',
    is('grep -q "player\'s guide" docs/x.md', ['grep', '-q', "player's guide", 'docs/x.md']),
    show('grep -q "player\'s guide" docs/x.md'));
  ok('an escaped quote inside a double-quoted argument is preserved literally',
    is('node -e "console.log(\\"hi\\")"', ['node', '-e', 'console.log("hi")']),
    show('node -e "console.log(\\"hi\\")"'));
}

// --- the shapes that already worked must not regress ---------------------------
{
  ok('a bare command splits on whitespace',
    is('npm test', ['npm', 'test']), show('npm test'));
  ok('a double-quoted argument with spaces stays one token',
    is('node -e "console.log(1, 2)"', ['node', '-e', 'console.log(1, 2)']),
    show('node -e "console.log(1, 2)"'));
  ok("a single-quoted argument with spaces stays one token",
    is("grep -q 'PB owns truth' docs/x.md", ['grep', '-q', 'PB owns truth', 'docs/x.md']),
    show("grep -q 'PB owns truth' docs/x.md"));
  ok('a quoted command path with spaces stays one token',
    is('"C:\\Program Files\\node\\node.exe" -v', ['C:\\Program Files\\node\\node.exe', '-v']),
    show('"C:\\Program Files\\node\\node.exe" -v'));
  ok('an empty quoted argument is preserved as an empty token',
    is('cmd ""', ['cmd', '']), show('cmd ""'));
  ok('an empty single-quoted argument is preserved as an empty token',
    is("cmd ''", ['cmd', '']), show("cmd ''"));
  ok('collapsed whitespace does not create empty tokens',
    is('  a   b  ', ['a', 'b']), show('  a   b  '));
  ok('a command that is only whitespace yields no tokens',
    shellSplit('   ').length === 0, show('   '));
}

// --- a quote inside a word is text; that boundary is deliberate ----------------
// POSIX would CONCATENATE: /usr/bin/"my tool" is one token. This tokenizer does not,
// because the same rule that preserves `require('fs')` also has to treat a quote
// inside a word as literal — and the case that matters (a program with one quoted
// argument) is unambiguous either way. Pinned so the boundary is a decision on
// record rather than a surprise: a quote that does not BEGIN a word never opens a
// quoted region.
{
  ok('a quote that begins a word opens a quoted region',
    is('"my tool" --flag', ['my tool', '--flag']), show('"my tool" --flag'));
  ok('a quote inside a word is literal and does NOT open a region',
    is('/usr/bin/"my tool" --flag', ['/usr/bin/"my', 'tool"', '--flag']),
    show('/usr/bin/"my tool" --flag'));
}

// --- a stray quote is literal text, not a silent truncation --------------------
{
  ok('a quote that does not begin a word is literal text',
    is('echo it"s', ['echo', 'it"s']), show('echo it"s'));
  ok('an unmatched quote at the end of a word is literal, not a swallowed argument',
    is('echo done"', ['echo', 'done"']), show('echo done"'));
}

console.log(`\ntest-shell-split-quotes: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
