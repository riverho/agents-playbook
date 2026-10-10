/**
 * Paths the dev-server watcher must not descend into.
 *
 * Why this exists: writing a file in this workspace goes through an atomic write
 * that creates `<name>.<pid>.<guid>.tmpdir/<name>.tmp` INSIDE the target folder,
 * then renames it. Vite watches the app root, tried to watch that temp file while
 * it was still locked, and chokidar killed the dev server outright:
 *
 *   Error: EBUSY: resource busy or locked,
 *   watch 'D:\...\apps\flow-room\.README.md.42428.<guid>.tmpdir\README.md.tmp'
 *     at FSWatcher.<computed> (node:internal/fs/watchers:321:19)
 *
 * So a plain README edit — or any agent's edit — took `npm start` down.
 *
 * The temp DIRECTORY clause is not redundant with the `*.tmp` clause: chokidar also
 * watches the directory itself, and `.README.md.42428.<guid>.tmpdir` does not end in
 * `.tmp`. Mutation testing proved exactly that — deleting the `.tmpdir` clause
 * reddens only the directory cases in src/vite-watch.test.ts, which is why they are
 * asserted.
 *
 * node_modules, .git and dist are excluded for the same reason chokidar's defaults
 * do it; they are restated because supplying `ignored` replaces those defaults.
 */
export const WATCH_IGNORED = (candidate: string): boolean =>
  /(^|[\\/])(node_modules|\.git|dist)([\\/]|$)/.test(candidate) ||
  /\.tmpdir([\\/]|$)/.test(candidate) ||
  /\.tmp$/.test(candidate);
