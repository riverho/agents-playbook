// ─── the rail's done marker (contract C4, C5; checker finding seq 151) ───
//
// `data-done` paints every FILLED segment --s6. It once followed `status === "done"`
// alone, and the CSS painted unfilled segments too, so a done card whose checks never
// ran showed a green tail: "not run" looked like a pass. These pin the marker to the
// rail itself.

import { describe, expect, it } from "vitest";
import { flowRail, railAttrs } from "./flow-derive";
import type { FlowNode } from "./flow-types";

const base: FlowNode = {
  id: "t",
  title: "a task",
  status: "done",
  layer: "L1",
  checks: 1,
  acceptance_checks: ["node -e 0"],
  journal: [{ action: "claim", agent: "lead", notes: "claimed", checks: "none" }],
};

describe("railAttrs", () => {
  it("marks a done card done only when its checks passed and all six steps fill", () => {
    const proven: FlowNode = {
      ...base,
      journal: [...(base.journal ?? []), { action: "execute", agent: "lead", notes: "done", checks: "passed", status: "done" }],
    };
    expect(flowRail(proven).filled).toBe(6);
    expect(railAttrs(proven)).toEqual({ "data-step": 6, "data-done": "" });
  });

  it("never marks a done card whose checks did not run", () => {
    expect(flowRail(base).filled).toBeLessThan(6);
    expect(railAttrs(base)["data-done"]).toBeUndefined();
  });

  it("never marks a done card whose checks failed", () => {
    const red: FlowNode = {
      ...base,
      journal: [{ action: "execute", agent: "lead", notes: "red", checks: "failed", status: "done" }],
    };
    expect(railAttrs(red)["data-done"]).toBeUndefined();
  });

  it("leaves an unstarted card with no step at all", () => {
    expect(railAttrs({ ...base, status: "todo", journal: [] })).toEqual({ "data-step": undefined, "data-done": undefined });
  });
});
