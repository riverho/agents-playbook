import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { WATCH_IGNORED as ignored } from "./watch-ignore";

// ─── the dev-server watch matcher ───
//
// Regression pin for a real crash, observed: editing any file in this folder took
// `npm start` down, because this workspace writes through an atomic temp dir
// INSIDE the target folder and Vite's watcher tried to watch the temp file while
// it was still locked (EBUSY at node:internal/fs/watchers:321).
//
// This is deliberately a pure predicate table plus one static wiring assertion —
// not "start a server and see if it survives a write". The project's own lesson is
// that a timing-sensitive gate is worse than a weaker deterministic one: a flaky
// gate teaches everyone to distrust red.
//
// Teeth are proven by mutation: deleting the `.tmpdir` clause from watch-ignore.ts
// fails the three directory cases below and nothing else.

const CRASH_PATH =
  "D:\\HermesProjects\\Agents-Playbook\\apps\\flow-room\\.README.md.42428.b8e14279-5775-48f1-a4e9-23377e1d1705.tmpdir\\README.md.tmp";

describe("vite server.watch.ignored — the matcher", () => {
  it.each([
    ["the exact path from the EBUSY crash", CRASH_PATH],
    ["a temp dir, unix separators", "/app/.index.css.991.aa.tmpdir/index.css.tmp"],
    ["the temp DIRECTORY itself — no trailing separator", "/app/.README.md.42428.b8e1.tmpdir"],
    ["the temp DIRECTORY itself — trailing separator", "/app/.README.md.42428.b8e1.tmpdir/"],
    ["a file in the temp dir that is not *.tmp", "/app/.README.md.42428.b8e1.tmpdir/README.md"],
    ["any *.tmp file", "/app/notes.tmp"],
    ["node_modules", "/app/node_modules/react/index.js"],
    ["the git dir", "/app/.git/HEAD"],
    ["the build output", "/app/dist/assets/index.js"],
  ])("ignores %s", (_label, candidate) => {
    expect(ignored(candidate)).toBe(true);
  });

  it.each([
    ["the app entry", "/app/src/App.tsx"],
    ["a room module", "/app/src/room/lib/flow-adapter.ts"],
    ["the room stylesheet", "/app/src/room/index.css"],
    ["the matcher itself", "/app/src/watch-ignore.ts"],
    ["a README", "/app/README.md"],
    ["a name that merely contains tmpdir", "/app/src/tmpdir-notes.ts"],
    ["a name that merely contains tmp", "/app/src/attempt.ts"],
  ])("still watches %s", (_label, candidate) => {
    expect(ignored(candidate)).toBe(false);
  });
});

describe("vite server.watch.ignored — the wiring", () => {
  // The predicate is only useful if the config installs it, and the config cannot
  // be imported from here (that would escape src/ and the decoupling gate refuses
  // it). So the wiring is asserted statically instead of not at all.
  const config = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");

  it("vite.config.ts imports the matcher and installs it", () => {
    expect(config).toMatch(/import\s*\{\s*WATCH_IGNORED\s*\}\s*from\s*["']\.\/src\/watch-ignore["']/);
    expect(config).toMatch(/watch:\s*\{[\s\S]*?ignored:\s*WATCH_IGNORED/);
  });
});
