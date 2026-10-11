# Flow room — the dependence direction, retired

**Status:** retired 2026-10-11 by `plan-20261010-016`. Gate: `scripts/check-wenmei-retired.mjs`.

## What moved

The Flow room was built in the **Wenmei playground** (`wenmei/app_design`) as a design probe
(`plan-20261009-005`), then extracted into this repo as a first-level app at **`apps/flow-room`**
(`plan-20261010-011`), pinned to Wenmei commit **`33fdcea43af6a47df6d40028e749118ca61a0dea`** and
proved file-by-file by `scripts/check-app-source-provenance.mjs`.

## The rule, and which way it runs

**One way only.** This repo owns the room:

- `apps/flow-room` is the source of truth for the room's code. It builds, renders, is served by
  `pb ui`, ships inside the engine tarball, and renders as a panel in the Harness.
- **This repo never reads the Wenmei tree** — not at build time, not at run time, not in tests.
  `scripts/check-app-decoupled.mjs` proves the module graph; `check-wenmei-retired.mjs` proves the
  resolution graph (imports, requires, package dependencies, configured paths).
- **Wenmei never feeds the room.** The playground keeps a frozen copy for its own stage so that
  project keeps working, and that copy is marked retired in
  `app_design/TOMBSTONE.md`. Room features and room fixes belong here; a fix made only in the
  playground is a divergence, not a contribution.

The extraction deliberately **copied** the room's comments that name Wenmei ("copied, not depended
on: this app has no Wenmei import and no Wenmei runtime") and the fixture that records the
historical worktree paths. Those are provenance: they are why the copy can be audited years from
now. Retiring the dependence is not the same as deleting the history, and this gate fails on
**resolution**, never on vocabulary.

## Why this is worth a gate

Three ways the direction silently reverses, each of which has already been seen somewhere in this
repo's history:

1. Someone fixes a room bug in the playground because that is where they first saw it. The copy
   diverges, and the next person cannot tell which one ships.
2. A pin is recorded against a path that stops being the checkout that was pinned — the original
   `PROVENANCE.json` named `…\Wenmei\wenmei\.worktrees\graph-room`. That directory **still exists
   and is still populated**; what happened is that its branch merged and it was removed from
   `git worktree list`, so it is no longer the durable thing the pin claims to be. (The first
   version of this record said it was "pointing at nothing", which overstated it: a worktree that
   has been de-registered is not a path that has vanished. The repoint was still necessary, and
   the gate now rejects a worktree-shaped source by name.)
3. A convenience import reaches back into the other checkout, and the app stops being portable
   without anyone noticing.

## What the gate checks

| # | Assertion |
| --- | --- |
| 1 | No file in the app **resolves** a Wenmei path: no import specifier, no path-shaped string, no dependency name or value in any dependency-bearing field. Comments and fixture data that *record* the origin are counted and reported, not ignored. The scanner is a character walk, not a regex, so a `/*` inside prose cannot swallow a file. |
| 2 | `PROVENANCE.json` pins a full commit sha that **git agrees is a real commit** in a source repo that exists, is an ancestor of that repo's `HEAD`, is not a worktree, and carries file hashes. Shape alone is not truth — a forty-zero sha fails. |
| 3 | The playground carries `app_design/TOMBSTONE.md` naming `apps/flow-room`, this repo, the pinned commit and the direction. |
| 4 | This record exists **and is tracked by git**. |

## The honest limits

- **Assertion 3 is not evaluated when no Wenmei checkout is present.** The gate says so in its
  output (`NOT EVALUATED`) and still exits 0, because it is `&&`-chained into `npm test` and the
  suite must run on a machine that has no Wenmei checkout. Pass `--require-source` (or set
  `PB_FLOW_REQUIRE_SOURCE=1`) to make its absence **fatal** — on a machine that is supposed to
  have the checkout, that flag is the honest setting.
- A path assembled at run time from parts that never appear as one segment in the source — a
  string built by concatenation from single characters, for instance — is not statically
  detectable by any rule of this shape. The gate catches whole paths, backslash and forward-slash
  escapes, bare segments, and split `join(...)` segments; it does not claim to catch arithmetic.
- Set `PB_FLOW_SOURCE=<checkout>` to point assertion 3 at a different checkout (the default is
  `D:\HermesProjects\Wenmei\wenmei`).
- Pass `--root <dir>` to run the whole gate against a copied tree; the regression test
  `scripts/test-wenmei-retired-teeth.mjs` does exactly that, and every escape an independent
  checker once used to walk through this gate is now a case in it.
