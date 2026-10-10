# Flow room

The Agent-Playbook **Flow room**, as a standalone app. It draws `pb graph --json`:
the start card, the backlog as cards, five kinds of proven edge, the human batch,
the cycle-stop card, a per-card inspector and a multi-select steering dock.

This is the room that was built in Wenmei's `app_design` playground, moved here so
it is part of Agents-Playbook rather than a tenant of another repo.

## Run it

```bash
cd apps/flow-room
npm install        # react, @xyflow/react, @dagrejs/dagre, lucide-react + the dev toolchain
npm start          # → http://127.0.0.1:4317/
```

`npm run build` writes `dist/`; `npm run check` typechecks; `npm test` runs the
room's suites.

### Editing while `npm start` runs

`vite.config.ts` sets `server.watch.ignored` to skip this workspace's atomic-write
temp dirs (`<name>.<pid>.<guid>.tmpdir/`) and `*.tmp` files. Without it, editing any
file in this folder killed the dev server outright:

```
Error: EBUSY: resource busy or locked, watch '.../.README.md.42428.<guid>.tmpdir/README.md.tmp'
```

`node_modules`, `.git` and `dist` are excluded by the same matcher. If you change
that matcher, restart the server and re-read this note before trusting it.

### If `npm install` is refused here (`EALLOWREMOTE`)

This harness blocks fetching remote tarballs, so `npm install` in a fresh app dir can fail on
this machine even though the manifest is correct. The tree under `node_modules/` was hydrated by a
**real copy** from Wenmei's `app_design/node_modules` (the same React/Vite/Tailwind versions), and
that is the only method to use.

**Do not "fix" it with a junction or symlink** — `New-Item -ItemType Junction -Path node_modules
-Target <other>/node_modules`. A recursive delete follows a junction, and that exact workaround
emptied this repo's root `node_modules` to zero entries (project-memory rule 27). If you need a
cheaper hydration, use `NODE_PATH` or a per-app install. `node scripts/check-app-decoupled.mjs`
refuses a linked `node_modules` for this reason.

## What is where

```
src/room/                     the room, copied VERBATIM from Wenmei (see PROVENANCE.json)
  components/stage/Flow*.tsx   canvas, cards, edges, inspector, steering dock
  lib/flow-*.ts                types, projection, layout, derive, the adapter seam
  mocks/                       the captured live snapshot + the labelled 3-layer sample
  index.css                    the room's stylesheet
src/App.tsx                   the standalone shell — ~20 lines, deliberately
src/main.tsx                  entry point (React Flow base CSS, then the room's)
```

`PROVENANCE.json` pins the exact commit the room came from, and
`node scripts/check-app-source-provenance.mjs` (at the repo root) re-verifies every
copied file byte for byte.

## Two honest notes

- **The default view is a captured snapshot, not live data.** `mocks/flow-graph-live.ts`
  is a `pb graph --json` payload captured from the Agents-Playbook backlog at the
  time of the move. It is a *fixture*: on any other playbook it describes this repo,
  not yours. Wiring the room to the local `pb` is the next task; until then the chip
  in the room says which payload you are looking at, and the sample is labelled a
  sample. The app ships that fixture only so the room can be rendered and tested
  without a running engine.
- **The fonts are loaded from Google Fonts** (as in Wenmei). Offline, the room falls
  back to system families; nothing else is fetched.
