// scripts/lib/test-temp.mjs
// ----------------------------------------------------------------------------
// Temp fixtures for the test and check scripts: made under os.tmpdir(), removed when the
// process exits (plan-20261009-008 — ~1450 pb* fixture dirs had piled up in %TEMP%).
//
// Removal NEVER follows a link. Fixtures used to symlink (on Windows: junction) the
// repo's node_modules, and a recursive delete once followed such a link and emptied the
// source. So: every link inside the tree is unlinked first — the link, never its target —
// and only then is the real directory removed. New fixtures COPY node_modules instead
// (copyModules: it is two small packages), so there is no link to follow at all.
// ----------------------------------------------------------------------------
import { cpSync, lstatSync, mkdtempSync, readdirSync, rmdirSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

const made = new Set();
let hooked = false;

/** Unlink every symlink/junction under `dir` (not following any), then remove `dir`. */
export function removeTree(dir) {
  let st;
  try { st = lstatSync(dir); } catch { return; }
  if (st.isSymbolicLink()) {
    try { unlinkSync(dir); } catch { try { rmdirSync(dir); } catch { /* left: reported by the caller's next run */ } }
    return;
  }
  if (!st.isDirectory()) { rmSync(dir, { force: true }); return; }
  const unlinkLinks = (d) => {
    let entries = [];
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isSymbolicLink()) {
        try { unlinkSync(p); } catch { try { rmdirSync(p); } catch { /* a junction rmdir refused */ } }
      } else if (e.isDirectory()) {
        unlinkLinks(p);
      }
    }
  };
  unlinkLinks(dir);
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

function cleanup() {
  for (const dir of made) {
    removeTree(dir);
    // a worker worktree is created BESIDE its repo (`<repo>-worker-<task>-<agent>`)
    try {
      const parent = dirname(dir);
      const stem = `${basename(dir)}-`;
      for (const name of readdirSync(parent)) if (name.startsWith(stem)) removeTree(join(parent, name));
    } catch { /* parent gone */ }
  }
  made.clear();
}

/** A fresh temp dir with this prefix, removed (with any `<dir>-*` sibling) at process exit. */
export function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.add(dir);
  if (!hooked) { hooked = true; process.on('exit', cleanup); }
  return dir;
}

/** Copy (never link) a node_modules tree into a fixture. */
export function copyModules(from, to) {
  cpSync(from, to, { recursive: true });
}
