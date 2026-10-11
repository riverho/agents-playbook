// ─── v2 layer view — contract G1–G4, J1 in executable form ───

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReactFlowProvider } from "@xyflow/react";
import { LIVE_SNAPSHOT_ADAPTER, SAMPLE_LAYERED_ADAPTER } from "./flow-adapter";
import {
  BAND_MAX_ROWS,
  bandsFor,
  draftCommand,
  gatePostText,
  layoutLayers,
  nextBandId,
  sortOpen,
} from "./flow-bands";
import { buildLayerEdges } from "./flow-projection";
import { faceHeight, faceState } from "./flow-face";
import type { FlowGraph, FlowLayerInfo, FlowNode } from "./flow-types";
import { FlowTaskCard } from "../components/stage/FlowCards";

const live = LIVE_SNAPSHOT_ADAPTER.load();
const sample = SAMPLE_LAYERED_ADAPTER.load();
const t = (id: string, extra: Partial<FlowNode> = {}): FlowNode => ({ id, kind: "task", title: id, status: "todo", layer: "L1", ...extra });
const info = (id: string, extra: Partial<FlowLayerInfo> = {}): FlowLayerInfo => ({
  id, name: id.toLowerCase(), about: `about ${id}`, position: 0, source: "declared", gate: null, gate_result: { state: "no-gate" }, tasks: [], ...extra,
});
const graphOf = (nodes: FlowNode[], layers?: FlowLayerInfo[]): FlowGraph => ({
  schema: "agent-playbook.graph.v1",
  start: { loop: "l", phase: 1, goal: "g", stop: "s", mode: "coding" },
  goal: { stop: "s", conditions: [] },
  nodes, edges: [], human: { batch: [] }, layers,
});

describe("G1 — one band per layer; derived bands are marked", () => {
  it("declared layers come first, in plan order, even when empty", () => {
    const g = graphOf([t("a", { declared_layer: "L1" }), t("b", { declared_layer: null, derived_layer: 2 })],
      [info("L0"), info("L1"), info("L2")]);
    const bands = bandsFor(g);
    expect(bands.map(b => b.id)).toEqual(["L0", "L1", "L2", "D3"]);
    expect(bands.map(b => b.source)).toEqual(["declared", "declared", "declared", "derived"]);
    expect(bands[0].open).toEqual([]);
    expect(bands.map(b => b.depth)).toEqual([0, 1, 2, 3]);
  });
  it("a playbook with no declared layers gets bands by depth, all derived", () => {
    const bands = bandsFor(graphOf([t("a", { derived_layer: 0 }), t("b", { derived_layer: 1 })]));
    expect(bands.map(b => [b.id, b.source])).toEqual([["L1", "derived"], ["L2", "derived"]]);
  });
  it("every live task lands in exactly one band", () => {
    const bands = bandsFor(live);
    const ids = bands.flatMap(b => [...b.open, ...b.done].map(n => n.id));
    const tasks = live.nodes.filter(n => (n.kind ?? "task") === "task").map(n => n.id);
    expect(ids.sort()).toEqual([...tasks].sort());
  });
});

describe("G2 — every card sits inside its band; columns of at most six", () => {
  for (const [name, graph] of [["live", live], ["sample", sample]] as const) {
    it(`${name}: card rect ⊂ band rect, and no column holds more than ${BAND_MAX_ROWS}`, () => {
      const layout = layoutLayers(graph);
      const bandOf = new Map<string, string>();
      for (const b of layout.bands) {
        for (const n of [...b.band.open, ...b.band.done]) bandOf.set(n.id, b.id);
        bandOf.set(`stack:${b.band.id}`, b.id);
      }
      let checked = 0;
      for (const n of layout.nodes) {
        const bandId = bandOf.get(n.id);
        if (!bandId) continue;
        const band = layout.bands.find(b => b.id === bandId)!;
        expect(n.x >= band.x && n.y >= band.y && n.x + n.width <= band.x + band.width && n.y + n.height <= band.y + band.height,
          `${n.id} escapes ${bandId}`).toBe(true);
        checked++;
      }
      expect(checked).toBeGreaterThan(0);
      for (const b of layout.bands) {
        const inBand = layout.nodes.filter(n => bandOf.get(n.id) === b.id);
        const perColumn = new Map<number, number>();
        for (const n of inBand) perColumn.set(n.x, (perColumn.get(n.x) ?? 0) + 1);
        for (const count of perColumn.values()) expect(count).toBeLessThanOrEqual(BAND_MAX_ROWS);
      }
      for (const a of layout.bands) for (const b of layout.bands) {
        if (a === b) continue;
        expect(a.x + a.width <= b.x || b.x + b.width <= a.x, `${a.id} overlaps ${b.id}`).toBe(true);
      }
    });
  }
  it("uses each card's own height (K5)", () => {
    const layout = layoutLayers(live);
    for (const n of live.nodes.filter(x => (x.kind ?? "task") === "task" && x.status !== "done")) {
      const placed = layout.nodes.find(p => p.id === n.id);
      if (placed) expect(placed.height).toBe(faceHeight(n));
    }
  });
});

describe("G3 — in-band order: needs you, working, blocked, ready, then a stack of done", () => {
  it("sorts by what a person must see first", () => {
    const nodes = [
      t("ready"), t("blocked", { status: "blocked" }), t("working", { status: "in_progress" }), t("asks", { manual: true }),
    ];
    expect(sortOpen(nodes).map(n => faceState(n).kind)).toEqual(["you", "working", "blocked", "ready"]);
  });
  it("stacks done cards and re-points their edges to the stack", () => {
    const g = graphOf([t("d1", { status: "done" }), t("d2", { status: "done" }), t("o", { derived_layer: 1 })]);
    g.edges = [{ from: "d1", to: "o", kind: "dep" }, { from: "d2", to: "o", kind: "dep" }];
    const layout = layoutLayers(g);
    expect(layout.extraNodes.map(n => n.id)).toEqual(["stack:L1"]);
    expect(layout.nodes.some(n => n.id === "d1")).toBe(false);
    const edges = buildLayerEdges(g, layout);
    expect(edges.map(e => `${e.source}->${e.target}`)).toEqual(["stack:L1->o"]);
  });
  it("an expanded band shows its done cards after the open ones", () => {
    const g = graphOf([t("d1", { status: "done" }), t("o")]);
    const layout = layoutLayers(g, { expanded: ["L1"] });
    const ys = ["o", "d1"].map(id => layout.nodes.find(n => n.id === id)!.y);
    expect(ys[0]).toBeLessThan(ys[1]);
    expect(layout.extraNodes).toEqual([]);
  });
  it("a stack counts what passed and what closed without a passing check", () => {
    const proven = t("p", { status: "done", journal: [{ action: "execute", agent: "a", notes: "", checks: "passed", status: "done" }] });
    const layout = layoutLayers(graphOf([proven, t("u", { status: "done" })]));
    const stack = layout.extraNodes[0] as { stack: { proven: number; ids: string[] } };
    expect(stack.stack).toEqual({ band: "L1", ids: ["p", "u"], proven: 1 });
  });
});

describe("G4 — a gate post says the last real result, or not run", () => {
  const band = (gate: string | null, gate_result: FlowLayerInfo["gate_result"]) =>
    bandsFor(graphOf([t("a", { declared_layer: "L0" })], [info("L0", { gate, gate_result })]))[0];
  it("pass and fail come from a recorded run, with its time", () => {
    expect(gatePostText(band("node g", { state: "pass", at: "2026-10-11T10:00:00Z" })).text).toBe("L0 gate: pass");
    expect(gatePostText(band("node g", { state: "fail", at: "2026-10-11T10:00:00Z", output: "x" }))).toMatchObject({ text: "L0 gate: fail", state: "fail" });
  });
  it("a gate past its limit says timed out — never pass, never fail", () => {
    const g = gatePostText(band("node g", { state: "timeout", at: "2026-10-11T10:00:00Z", limit_ms: 800 }));
    expect([g.text, g.state]).toEqual(["L0 gate: timed out", "timeout"]);
    expect(g.title).toMatch(/800ms/);
  });
  it("no recorded run is 'not run' — never a guess", () => {
    expect(gatePostText(band("node g", { state: "not-run" })).text).toBe("L0 gate: not run");
    // an older engine sends no gate_result at all: still not run, not pass
    const g = graphOf([t("a", { declared_layer: "L0" })], [{ ...info("L0", { gate: "node g" }), gate_result: undefined as never }]);
    expect(gatePostText(bandsFor(g)[0]).state).toBe("not-run");
  });
  it("a layer without a gate has no post", () => {
    const layout = layoutLayers(graphOf([t("a", { declared_layer: "L0" })], [info("L0")]));
    expect(layout.gateposts).toEqual([]);
  });
});

describe("J1–J3 — jumping in", () => {
  it("every task card has exactly one keyboard-reachable +", () => {
    const node = live.nodes.find(n => (n.kind ?? "task") === "task")!;
    const html = renderToStaticMarkup(createElement(ReactFlowProvider, null,
      createElement(FlowTaskCard, { id: node.id, data: { node, width: 288, height: faceHeight(node) }, selected: false } as never)));
    const pluses = html.match(/class="flow-plus[^"]*"/g) ?? [];
    expect(pluses.length).toBe(1);
    expect(html).toMatch(/<button type="button" class="flow-plus[^"]*" aria-label="Jump in on: /);
  });
  it("a follow-up lands one band later; past the last band it opens a new derived band", () => {
    const bands = bandsFor(graphOf([t("a", { declared_layer: "L0" }), t("b", { declared_layer: "L1" })], [info("L0"), info("L1")]));
    expect(nextBandId(bands, "L0")).toBe("L1");
    expect(nextBandId(bands, "L1")).toBe("D1");
  });
  it("a draft is a card in its band and says the exact command Create will run", () => {
    const g = graphOf([t("a", { declared_layer: "L0" })], [info("L0"), info("L1")]);
    const draft = { id: "d", band: "L1", title: "tidy the gate", kind: "follow-up" as const, from: "a" };
    const layout = layoutLayers(g, { drafts: [draft] });
    expect(layout.extraNodes.map(n => n.id)).toContain("draft:d");
    expect(draftCommand(draft, true)).toBe('pb plan --goal "tidy the gate" --dep a --layer L1');
    expect(draftCommand({ ...draft, kind: "card", band: "D1" }, false)).toBe('pb plan --goal "tidy the gate"');
  });
});
