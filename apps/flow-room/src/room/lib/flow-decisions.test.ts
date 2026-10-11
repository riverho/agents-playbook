import { describe, expect, it } from "vitest";
import { decisionItems } from "./flow-decisions";
import type { FlowGraph, FlowNode } from "./flow-types";

const node = (id: string, extra: Partial<FlowNode> = {}): FlowNode => ({
  id, kind: "task", title: id, status: "todo", layer: "L1", ...extra,
});
const graph = (nodes: FlowNode[]): FlowGraph => ({
  schema: "agent-playbook.graph.v1", nodes, edges: [],
  start: { loop: "test", goal: "test", stop: "test", phase: 1, mode: "coding" },
  goal: { stop: "test", conditions: [] }, human: { batch: [] },
});
const ask = { question: "Which path?", options: [{ id: "a", label: "Path A", effect: "Do A" }, { id: "b", label: "Path B", effect: "Do B" }] };

describe("decision inbox (H1-H4)", () => {
  it("includes approvals and explicit questions, excluding done, answered and ordinary tasks", () => {
    const items = decisionItems(graph([
      node("approval", { manual: true }), node("question", { human: ask }), node("ordinary"),
      node("done", { manual: true, status: "done" }),
      node("answered", { manual: true, human: { ...ask, decided: { option: "a", reason: "yes", by: "you", ts: "2026-10-11T00:00:00Z", seq: 1 } } }),
    ]));
    expect(items.map(i => [i.node.id, i.kind])).toEqual([["approval", "Approval"], ["question", "Question"]]);
  });
  it("sorts by unfinished tasks waiting, then oldest first, then id", () => {
    const stamped = (id: string, ts: string, waiting_on: string[]) => node(id, {
      manual: true, human: { ...ask, waiting_on }, journal: [{ ts, agent: "lead", action: "plan", notes: "Asked" }],
    });
    const items = decisionItems(graph([
      stamped("new", "2026-10-11T00:00:00Z", []), stamped("old", "2026-10-09T00:00:00Z", []),
      stamped("urgent", "2026-10-11T00:00:00Z", ["child", "child", "finished"]),
      node("child"), node("finished", { status: "done" }),
    ]));
    expect(items.map(i => i.node.id)).toEqual(["urgent", "old", "new"]);
    expect(items[0].waiting).toEqual(["child"]);
  });
  it("derives dependency waiters for manual tasks, while questions do not assert a blocking gate", () => {
    const g = graph([node("approval", { manual: true }), node("question", { human: ask }), node("child")]);
    g.edges = [{ from: "approval", to: "child", kind: "dep", proven: true }];
    const [approval, question] = decisionItems(g);
    expect(approval.waiting).toEqual(["child"]);
    expect(question.waiting).toEqual([]);
    expect(approval.question.endsWith("?")).toBe(true);
    expect(approval.options.length).toBeGreaterThanOrEqual(2);
    expect(approval.options.every(o => o.effect)).toBe(true);
  });
  it("keeps supplied question, effects and named recommendation", () => {
    const [item] = decisionItems(graph([node("ask", { human: { ...ask, recommended: "b", recommended_by: "Lead" } })]));
    expect(item.question).toBe("Which path?");
    expect(item.options).toEqual(ask.options);
    expect(item.recommendedBy).toBe("Lead");
    expect(item.recommended).toBe("b");
  });
});
