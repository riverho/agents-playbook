// ─── Flow room — the DSH Client plugin ───
//
// This is the room as a GLOBAL PANEL in the Harness Web UI (decision D3: a real harness
// integration, not a CLI shim). Per @deepseek-ai/dsh-client-ui-layout's README, "global
// panels occupy the root-scoped `main` keyed slot", and `ctx.layout.selectPanel(id)`
// selects one — so that is what this registers.
//
// The rules a UI plugin must hold, and where each is satisfied:
//   · NEVER import a Harness Client package (the loader gives us what we need through
//     `ctx`) — this file imports none; scripts/check-dsh-bundle.mjs asserts that.
//   · factories are side-effect free: nothing here runs at load beyond defining values.
//   · resources are registered in `apply` through `ctx.effect` and RETURN their cleanup —
//     see the stylesheet below.
//   · do not replace the app root or append a second application to document.body — this
//     only fills a slot the host allocated.
//
// It is compiled into `window.__ModuleLoader__.load({ id, factory })` form by
// scripts/build-dsh-client.mjs, with react and react/jsx-runtime resolved from the
// browser module table (so React is never bundled twice) and React Flow + dagre inlined.
//
// WHY AN ABSOLUTE SERVER URL: the panel lives in the Harness page, a different origin from
// the Flow room's own server, so a same-origin `/api/health` would be the Harness's route,
// not the engine's. Decision D6: the panel reads the local server directly. If it is not
// running, the panel says so — it does not pretend.

import { createElement } from "react";
import xyflowCss from "@xyflow/react/dist/style.css?raw";
import roomCss from "../room/index.css?raw";
import FlowPanel from "../FlowPanel";

export const PANEL_ID = "flow-room";
export const PANEL_SLOT = "main";
export const DEFAULT_SERVER = "http://127.0.0.1:4317";

// React Flow's base sheet first, then the room's — the room overrides the defaults, so the
// order is load-bearing (the same order main.tsx uses for the standalone build).
const CSS = `${xyflowCss}\n${roomCss}`;

function FlowRoomPanel() {
  // showFooter is off because the Harness frame already has chrome; the panel states its
  // own truth in the no-engine case instead of adding a second status strip.
  return createElement(FlowPanel, { apiBase: DEFAULT_SERVER, showFooter: false });
}

/** Cordis service injection: we only need the slot registry. No Harness *package* imports. */
export const inject = ["slots"];

interface SlotRegistry {
  inject(name: string, register: () => unknown): unknown;
  register(options: { name: string; id: string; order?: number }, component: unknown): unknown;
}

interface PluginContext {
  slots: SlotRegistry;
  effect?(fn: () => void | (() => void)): unknown;
  layout?: { selectPanel?: (id: string) => void };
}

export function apply(ctx: PluginContext): void {
  // The stylesheet is a resource: appended on mount, removed by the cleanup the host runs
  // on disposal. An unmounted panel must not leave a full stylesheet behind.
  ctx.effect?.(() => {
    const style = document.createElement("style");
    style.dataset.dshPlugin = PANEL_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
    return () => style.remove();
  });

  ctx.slots.inject(PANEL_SLOT, () =>
    ctx.slots.register({ name: PANEL_SLOT, id: PANEL_ID, order: 20 }, FlowRoomPanel)
  );

  // Selecting the panel is a different service; guarded, so a composition that has the
  // slot registry but no layout service still gets the panel registered.
  if (ctx.layout && typeof ctx.layout.selectPanel === "function") {
    ctx.effect?.(() => {
      ctx.layout?.selectPanel?.(PANEL_ID);
    });
  }
}
