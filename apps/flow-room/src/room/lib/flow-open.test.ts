// ─── v2 open card + presence — contract M1, M2, C4 and the approved order ───

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FOLD_AT, PLAIN_STEPS, brief, conversation, nextLine, presence, proofRows } from "./flow-open";
import type { FlowGraph, FlowJournalRow, FlowNode } from "./flow-types";
import { FlowInspector } from "../components/stage/FlowInspector";

const NOW = Date.now();
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const row = (action: string, extra: Partial<FlowJournalRow> = {}): FlowJournalRow => ({ action, agent: "lead", notes: `${action} note. Second sentence.`, ts: ago(1), ...extra });
const t = (extra: Partial<FlowNode> = {}): FlowNode => ({ id: "plan-x", kind: "task", title: "Kill the whole tree. It keeps running after the kill and writes files later. " + "More detail follows here, and then a lot more about the measurement. ".repeat(4), status: "todo", layer: "L1", ...extra });
const graphOf = (nodes: FlowNode[]): FlowGraph => ({ schema: "agent-playbook.graph.v1", start: { loop: "l", phase: 1, goal: "g", stop: "s", mode: "m" }, goal: { stop: "s", conditions: [] }, nodes, edges: [], human: { batch: [] } });

describe("M1 — presence from claims and the latest row", () => {
  it("lists each agent holding a card, what it is on, when it last spoke", () => {
    const g = graphOf([
      t({ id: "a", status: "in_progress", claim: { by: "lead", seq: 1 }, headline: "Kill the tree", journal: [row("claim", { ts: ago(30) }), row("implement", { ts: ago(3) })] }),
      t({ id: "b", status: "in_progress", claim: { by: "checker-1", seq: 2 }, journal: [] }),
      t({ id: "c", status: "todo", journal: [row("comment", { agent: "human" })] }),
    ]);
    const p = presence(g);
    expect(p.map(x => [x.agent, x.task])).toEqual([["lead", "a"], ["checker-1", "b"]]);
    expect(p[0]).toMatchObject({ name: "Lead agent", taskTitle: "Kill the tree", lastSpoke: ago(3), live: true });
    expect(p[1]).toMatchObject({ name: "Checker", lastSpoke: null, live: false });
  });
  it("is empty when nobody holds a card", () => expect(presence(graphOf([t()]))).toEqual([]));
});

describe("M2 — messages lead with one line; long notes are folded", () => {
  it("summarises and folds", () => {
    const long = "SPIKE RESULT: the launcher works. " + "x ".repeat(300);
    const msgs = conversation(t({ journal: [row("claim"), row("implement", { notes: long }), row("comment", { notes: "short note", intent: "steer", agent: "human" })] }));
    expect(msgs).toHaveLength(2); // the claim row is not conversation
    expect(msgs[0].summary).toBe("Spike result: the launcher works.");
    expect(msgs[0].full?.length).toBeGreaterThan(FOLD_AT);
    expect(msgs[1]).toMatchObject({ summary: "Short note", full: null, intent: "steer", author: "Human" });
  });
  it("uses the engine's summary when the row carries one", () => {
    expect(conversation(t({ journal: [row("implement", { summary: "Proved the fix." })] }))[0].summary).toBe("Proved the fix.");
  });
});

describe("the open card's sections", () => {
  it("names the steps plainly", () => expect(PLAIN_STEPS.map(s => s.plain)).toEqual(["Read plan", "Pick up", "Do work", "Run checks", "Record", "Report"]));
  it("keeps the brief short and the rest one click away", () => {
    const b = brief(t());
    expect(b.short.length).toBeLessThan(t().title.length);
    expect(b.more).toBe(true);
  });
  it("says what happens next, and a person's turn in the HIL style", () => {
    expect(nextLine(t({ manual: true })).you).toBe(true);
    expect(nextLine(t()).text).toMatch(/pb next/);
    expect(nextLine(t({ status: "done" })).text).toMatch(/not proof/);
  });
  it("C4: an unrun check says 'not run', never passed", () => {
    const rows = proofRows(t({ acceptance_checks: ["node scripts/test-x.mjs"], check_names: ["the tree dies"] }));
    expect(rows).toEqual([{ name: "the tree dies", command: "node scripts/test-x.mjs", result: "not-run", word: "not run" }]);
    const passed = proofRows(t({ acceptance_checks: ["node scripts/test-x.mjs"], journal: [row("execute", { checks: "passed", status: "done" })] }));
    expect(passed[0]).toMatchObject({ name: "test x", result: "passed" });
  });
  it("renders in the approved order with the ID folded into engine details", () => {
    const node = t({ status: "in_progress", claim: { by: "lead", seq: 1 }, headline: "Kill the tree", acceptance_checks: ["node a.mjs"], journal: [row("implement")] });
    const html = renderToStaticMarkup(createElement(FlowInspector, { node, onClose: () => {}, onSend: async () => ({ ok: true, note: "" }), readOnly: true }));
    const order = ["What this is", "Where it stands", "Proof", "Conversation", "Engine details"].map(h => html.indexOf(h));
    expect(order.every(i => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const beforeEngine = html.slice(0, html.indexOf("Engine details"));
    expect(beforeEngine.includes("plan-x")).toBe(false);
    expect(html).toMatch(/aria-pressed="true"[^>]*>Comment</);
    expect(html).not.toMatch(/role="radio"/);
    expect(html).toMatch(/>Change direction</);
    expect(html).toMatch(/>Ask the agent</);
  });
});

describe("the brief splits at sentence ends only", () => {
  it("does not split inside a version or a file name", () => {
    const b = brief(t({ title: "Publish dsh-agents-playbook@0.6.2 to npm and flip the table in pb.mjs. " + "Then more words to make it long enough to be cut. ".repeat(6) }));
    expect(b.short.startsWith("Publish dsh-agents-playbook@0.6.2 to npm")).toBe(true);
  });
});

describe("de-shouting keeps acronyms", () => {
  it("lowercases shouting, not YAML / JSON / CSRF / POSIX", () => {
    const m = conversation(t({ journal: [row("implement", { notes: "DEMONSTRATED the YAML and JSON CSRF fix on POSIX. More." })] }))[0];
    expect(m.summary).toBe("Demonstrated the YAML and JSON CSRF fix on POSIX.");
  });
});
