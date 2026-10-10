// ─── Flow room — geometry: the four defects the live render exposed ───
//
// A build gate cannot see a picture. These assertions are the picture, checked
// against the PURE layout output (no DOM, no browser), so each of the Lead's four
// render findings fails a test if it comes back:
//
//   1. no two node rects overlap or sit closer than FLOW_MIN_GUTTER
//   2. no edge-label box intersects a node rect, a gate pill, another label or
//      the reserved legend — a label that fits nowhere is SUPPRESSED, not clipped
//   3. the legend's reserved rect intersects no node rect
//   4. the minimap uses the painted light-grey/accent tones, not the card's ink
//
// `scripts/check-flow-room.mjs` runs this file through vitest and fails by name
// if any of these tests stops passing.

import { describe, expect, it } from "vitest";
import { LIVE_SNAPSHOT_ADAPTER, SAMPLE_LAYERED_ADAPTER } from "@/lib/flow-adapter";
import { readFileSync } from "node:fs";
import {
  FLOW_LEGEND_METRICS,
  FLOW_MINIMAP_BG,
  FLOW_MINIMAP_TONE,
  FLOW_TONE,
  flowLegendModel,
} from "@/lib/flow-derive";
import {
  FLOW_FIT_PADDING,
  FLOW_GATE_LABEL_TOP,
  FLOW_MIN_GUTTER,
  declutterRects,
  estimateLabelWidth,
  flowFitBounds,
  layoutFlow,
  legendInsideFitBounds,
  placeEdgeLabels,
  rectsIntersect,
  type FlowLayoutNode,
  type FlowLayoutResult,
} from "@/lib/flow-layout";
import { buildEdges } from "@/lib/flow-projection";
import type { FlowGraph } from "@/lib/flow-types";

const sample = SAMPLE_LAYERED_ADAPTER.load();
const live = LIVE_SNAPSHOT_ADAPTER.load();
const both: [string, FlowGraph][] = [
  ["sample", sample],
  ["live", live],
];

/** Every pair of node rects, with the gap that separates them. */
function nodePairs(layout: FlowLayoutResult) {
  const pairs: { a: FlowLayoutNode; b: FlowLayoutNode }[] = [];
  for (let i = 0; i < layout.nodes.length; i += 1) {
    for (let j = i + 1; j < layout.nodes.length; j += 1) {
      pairs.push({ a: layout.nodes[i], b: layout.nodes[j] });
    }
  }
  return pairs;
}

describe("1 — no two cards overlap or crowd", () => {
  for (const [name, graph] of both) {
    it(`${name}: every pair of node rects keeps a >= ${FLOW_MIN_GUTTER}px gutter`, () => {
      const layout = layoutFlow(graph);
      const offenders = nodePairs(layout)
        .filter(pair => rectsIntersect(pair.a, pair.b, FLOW_MIN_GUTTER))
        .map(
          pair =>
            `${pair.a.id} ↔ ${pair.b.id} (gap < ${FLOW_MIN_GUTTER}px: ` +
            `[${pair.a.x},${pair.a.y},${pair.a.width}x${pair.a.height}] vs ` +
            `[${pair.b.x},${pair.b.y},${pair.b.width}x${pair.b.height}])`
        );
      expect(offenders).toEqual([]);
    });
  }

  it("the de-collision pass is what makes that true — it has teeth", () => {
    // Two rects forced on top of each other must be pushed apart, not accepted.
    const stacked: FlowLayoutNode[] = [
      { id: "a", kind: "task", layer: "L1", column: 1, rank: 1, band: false, gatepost: false, x: 0, y: 0, width: 236, height: 104 },
      { id: "b", kind: "task", layer: "L1", column: 1, rank: 1, band: false, gatepost: false, x: 0, y: 4, width: 236, height: 104 },
    ];
    const moved = declutterRects(stacked, FLOW_MIN_GUTTER);
    expect(moved).toBeGreaterThan(0);
    expect(rectsIntersect(stacked[0], stacked[1], FLOW_MIN_GUTTER)).toBe(false);
    // …and a clean layout is left alone.
    expect(declutterRects(stacked, FLOW_MIN_GUTTER)).toBe(0);
  });

  it("keeps every card inside the layout's own bounds", () => {
    for (const [, graph] of both) {
      const layout = layoutFlow(graph);
      for (const node of layout.nodes) {
        expect(node.x).toBeGreaterThanOrEqual(0);
        expect(node.y).toBeGreaterThanOrEqual(0);
        expect(node.x + node.width).toBeLessThanOrEqual(layout.width);
        expect(node.y + node.height).toBeLessThanOrEqual(layout.height);
      }
    }
  });
});

describe("2 — edge labels never clip and never sit under a card", () => {
  for (const [name, graph] of both) {
    it(`${name}: every VISIBLE label box clears all node rects, gate pills and other labels`, () => {
      const layout = layoutFlow(graph);
      const boxes = placeEdgeLabels(graph.edges, layout);
      const nodes = layout.nodes.map(node => ({ x: node.x, y: node.y, width: node.width, height: node.height }));
      const gates = layout.gateLabels.map(label => ({ x: label.x, y: label.y, width: label.width, height: label.height }));
      const visible = boxes.filter(box => box.visible);
      const problems: string[] = [];
      for (const box of visible) {
        for (const rect of [...nodes, ...gates, layout.chrome.legend]) {
          if (rectsIntersect(box, rect, 1)) {
            problems.push(`"${box.text}" at [${box.x},${box.y}] overlaps a rect at [${rect.x},${rect.y}]`);
          }
        }
      }
      for (let i = 0; i < visible.length; i += 1) {
        for (let j = i + 1; j < visible.length; j += 1) {
          if (rectsIntersect(visible[i], visible[j], 1)) {
            problems.push(`"${visible[i].text}" overlaps "${visible[j].text}"`);
          }
        }
      }
      expect(problems).toEqual([]);
    });
  }

  it("suppresses rather than clips when nothing fits", () => {
    const layout = layoutFlow(sample);
    // Squeeze the canvas: a label with no free space must come back invisible and
    // say why, never a clipped box.
    const tiny: FlowLayoutResult = {
      ...layout,
      nodes: layout.nodes.map(node => ({ ...node, y: node.y + 4 })),
    };
    const boxes = placeEdgeLabels(sample.edges, tiny);
    expect(boxes.length).toBeGreaterThan(0);
    for (const box of boxes) {
      if (!box.visible) expect(box.reason).toBeTruthy();
    }
    // The renderer drops a suppressed label entirely.
    const edges = buildEdges(sample, layout);
    for (const edge of edges) {
      if (edge.data?.labelSuppressed) expect(edge.data.label).toBeUndefined();
      if (edge.data?.label) expect(edge.data.labelBox).toBeTruthy();
    }
  });

  it("sizes a pill from its text, not from a guess about the DOM", () => {
    expect(estimateLabelWidth("spawn — discovered at runtime")).toBeGreaterThan(140);
    expect(estimateLabelWidth("a")).toBeLessThan(estimateLabelWidth("ab"));
  });
});

describe("3 — the legend cannot sit on a card", () => {
  for (const [name, graph] of both) {
    it(`${name}: the reserved legend rect intersects no node rect`, () => {
      const layout = layoutFlow(graph);
      const offenders = layout.nodes
        .filter(node => rectsIntersect(node, layout.chrome.legend, FLOW_MIN_GUTTER))
        .map(node => node.id);
      expect(offenders).toEqual([]);
    });
  }

  it("reserves at least the legend's own drawn content, for both payloads", () => {
    // The required height is recomputed HERE, from the legend MODEL's row counts
    // and the documented metrics — not by calling the layout's own sizing helper
    // and not from a literal. A reserve smaller than this (or a zeroed floor, or
    // a hard-coded 104) cannot satisfy it: the sample needs ~121 px, which is why
    // the old 104 px reserve clipped the rows (the Lead saw exactly that).
    for (const [name, graph] of both) {
      const layout = layoutFlow(graph);
      const legend = layout.chrome.legend;
      const model = flowLegendModel(graph);
      const required = Math.max(
        ...model.map(
          group =>
            FLOW_LEGEND_METRICS.padY * 2 +
            FLOW_LEGEND_METRICS.headerH +
            group.rows.length * FLOW_LEGEND_METRICS.rowH +
            Math.max(0, group.rows.length - 1) * FLOW_LEGEND_METRICS.rowGap
        )
      );
      expect(required, `${name} there is nothing to draw`).toBeGreaterThan(0);
      expect(
        legend.height,
        `${name} reserve ${legend.height}px < drawn content ${required}px (rows would clip)`
      ).toBeGreaterThanOrEqual(required);
      const requiredWidth =
        FLOW_LEGEND_METRICS.padX * 2 +
        model.reduce(
          (sum, group, index) =>
            sum +
            (index > 0 ? FLOW_LEGEND_METRICS.groupGap : 0) +
            group.rows.reduce(
              (max, row) =>
                Math.max(
                  max,
                  (row.kind === "line"
                    ? FLOW_LEGEND_METRICS.swatchW + FLOW_LEGEND_METRICS.swatchGap
                    : 0) + row.text.length * FLOW_LEGEND_METRICS.charW
                ),
              0
            ),
          0
        );
      expect(legend.width, `${name} reserve narrower than a row`).toBeGreaterThanOrEqual(
        Math.ceil(requiredWidth)
      );
      // No row may fall outside the panel: the content fits by construction.
      const rows = Math.max(...model.map(group => group.rows.length));
      expect(legend.height).toBeGreaterThanOrEqual(
        FLOW_LEGEND_METRICS.padY * 2 +
          FLOW_LEGEND_METRICS.headerH +
          rows * FLOW_LEGEND_METRICS.rowH +
          Math.max(0, rows - 1) * FLOW_LEGEND_METRICS.rowGap
      );
      const contentBottom = Math.max(...layout.nodes.map(node => node.y + node.height));
      // The reserved rect is EXCLUDED from the content band: it starts below it.
      expect(legend.y, `${name} legend inside the content band`).toBeGreaterThanOrEqual(
        contentBottom
      );
      expect(layout.height).toBeGreaterThanOrEqual(legend.y + legend.height);
      // …and the DRAWN legend rect intersects neither a node nor a visible label.
      const nodeHits = layout.nodes
        .filter(node => rectsIntersect(node, legend, 0))
        .map(node => node.id);
      expect(nodeHits, `${name} legend overlaps a node`).toEqual([]);
      const labelHits = placeEdgeLabels(graph.edges, layout)
        .filter(box => box.visible && rectsIntersect(box, legend, 0))
        .map(box => box.text);
      expect(labelHits, `${name} legend overlaps a label`).toEqual([]);
    }
  });

  it("draws the legend from the model the reserve was measured from", () => {
    // One source: the component may not carry its own row list, or a new row
    // would silently overflow the panel again.
    const roomSource = readFileSync(
      new URL("../components/stage/FlowRoom.tsx", import.meta.url),
      "utf8"
    );
    const legend = roomSource.slice(roomSource.indexOf("function FlowLegend"));
    expect(legend).toContain("flowLegendModel(graph)");
    expect(legend).not.toContain("hollow gate warning");
    expect(legend).not.toContain("orient →");
  });

  it("keeps the gate pills in their own strip above the cards", () => {
    const layout = layoutFlow(sample);
    expect(layout.gateLabels).toHaveLength(2);
    for (const label of layout.gateLabels) {
      expect(label.y).toBe(FLOW_GATE_LABEL_TOP);
      for (const node of layout.nodes) {
        if (node.gatepost) continue;
        expect(rectsIntersect(label, node, 0)).toBe(false);
      }
    }
  });
});

describe("4 — the minimap matches the painted frame", () => {
  it("uses the light grey + accent tones, never the card's ink", () => {
    expect(FLOW_MINIMAP_TONE.done).toBe("rgba(17, 17, 17, 0.22)");
    expect(FLOW_MINIMAP_TONE.todo).toBe("rgba(17, 17, 17, 0.18)");
    expect(FLOW_MINIMAP_TONE.in_progress).toBe("var(--accent-teal)");
    expect(FLOW_MINIMAP_TONE.blocked).toBe("var(--accent-rose)");
    // The card tone for `done` is ink (#2f2f2f) — on the minimap that paints a
    // heavy black block, which is exactly what the live render exposed.
    expect(FLOW_MINIMAP_TONE.done).not.toBe(FLOW_TONE.done);
    expect(FLOW_MINIMAP_BG).toBe("#fbfaf9");
  });

  it("gives every live status a tone, including the ones the payload can send", () => {
    for (const status of ["todo", "in_progress", "blocked", "done"] as const) {
      expect(FLOW_MINIMAP_TONE[status]).toBeTruthy();
    }
  });
});

describe("5 — the legend is on screen after the initial fit", () => {
  for (const [name, graph] of both) {
    it(`${name}: the legend lies inside the rect the room fits`, () => {
      const layout = layoutFlow(graph);
      const legend = layout.chrome.legend;
      const fit = flowFitBounds(layout);
      expect(
        legendInsideFitBounds(layout),
        `${name}: the legend would be off-viewport — the room fits ${JSON.stringify(fit)} but the legend is at ${JSON.stringify(legend)}`
      ).toBe(true);
      // The shipped defect was fitting the NODES' bounding box: the fit must reach
      // past the last node, or the reserved legend band ends up below the fold.
      const nodeBottom = Math.max(...layout.nodes.map(node => node.y + node.height));
      expect(fit.height, `${name}: the fit stops at the nodes`).toBeGreaterThan(nodeBottom);
      expect(fit.height).toBeGreaterThanOrEqual(legend.y + legend.height);
      expect(fit.width).toBeGreaterThanOrEqual(legend.x + legend.width);
      expect(legend.y + legend.height).toBeLessThanOrEqual(layout.height);
    });
  }

  it("maps the whole legend, not a sliver, inside the frame viewport", () => {
    const layout = layoutFlow(sample);
    const fit = flowFitBounds(layout);
    const legend = layout.chrome.legend;
    const viewWidth = 1440;
    const viewHeight = 920;
    // React Flow's fit: scale the rect to the viewport minus the padding, centred.
    const scale = Math.min(
      (viewWidth * (1 - 2 * FLOW_FIT_PADDING)) / fit.width,
      (viewHeight * (1 - 2 * FLOW_FIT_PADDING)) / fit.height
    );
    const offsetX = (viewWidth - fit.width * scale) / 2;
    const offsetY = (viewHeight - fit.height * scale) / 2;
    const screen = {
      x: offsetX + (legend.x - fit.x) * scale,
      y: offsetY + (legend.y - fit.y) * scale,
      width: legend.width * scale,
      height: legend.height * scale,
    };
    expect(screen.x).toBeGreaterThanOrEqual(0);
    expect(screen.y).toBeGreaterThanOrEqual(0);
    expect(screen.x + screen.width).toBeLessThanOrEqual(viewWidth);
    expect(screen.y + screen.height).toBeLessThanOrEqual(viewHeight);
    // "Only its top sliver shows" is the regression this pins: the drawn legend
    // must get its full budgeted height on screen, not a few pixels of it.
    expect(
      screen.height,
      `legend on screen is only ${screen.height.toFixed(1)}px of ${legend.height}px`
    ).toBeGreaterThanOrEqual(legend.height * scale * 0.99);
  });
});
