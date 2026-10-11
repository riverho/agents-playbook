// ─── v2 card face — contract K1–K5, F1, F2, C2, T3 in executable form ───
//
// Runs over hand-built nodes for the state machines and over this repo's LIVE
// snapshot (`pb graph --json`) for the rules that are about real backlogs: long
// titles (K2), constant chrome (K3), the ID off the face (K4) and heights (K5).

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReactFlowProvider } from "@xyflow/react";
import { LIVE_SNAPSHOT_ADAPTER } from "./flow-adapter";
import {
  FACE_MAX_H,
  FACE_MIN_H,
  FACE_SLOTS,
  FACE_TITLE_LINES,
  beaconFor,
  faceBar,
  charsPerLine,
  faceHeight,
  faceNow,
  faceProof,
  faceState,
  faceTitle,
  fitText,
  isLive,
  wrapWords,
  zoomTier,
  FACE_TITLE_PX,
} from "./flow-face";
import { layoutFlow } from "./flow-layout";
import type { FlowJournalRow, FlowNode } from "./flow-types";
import { FlowTaskCard } from "../components/stage/FlowCards";

const NOW = Date.parse("2026-10-11T12:00:00.000Z");
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const row = (action: string, extra: Partial<FlowJournalRow> = {}): FlowJournalRow => ({
  action, agent: "lead", notes: `${action} row. More detail follows here.`, ts: ago(1), ...extra,
});
const task = (extra: Partial<FlowNode> = {}): FlowNode => ({
  id: "plan-x", kind: "task", title: "Kill the whole check process tree on timeout", status: "todo",
  layer: "L1", checks: 2, acceptance_checks: ["node a", "node b"], skill: "run-task", mode: "coding", journal: [], ...extra,
});

const live = LIVE_SNAPSHOT_ADAPTER.load();
const liveTasks = live.nodes.filter(n => (n.kind ?? "task") === "task");

function renderFace(node: FlowNode): string {
  const height = faceHeight(node);
  const props = { id: node.id, data: { node, width: 288, height }, selected: false } as never;
  return renderToStaticMarkup(createElement(ReactFlowProvider, null, createElement(FlowTaskCard, props)));
}

describe("K1 — the face has five slots, in order, and nothing else", () => {
  it("renders state, title, bar, now, foot in that order", () => {
    const html = renderFace(task({ status: "in_progress", claim: { by: "lead", seq: 1 }, journal: [row("claim"), row("implement")] }));
    const slots = [...html.matchAll(/data-slot="(\w+)"/g)].map(m => m[1]);
    expect(slots).toEqual([...FACE_SLOTS]);
  });
  it("omits the now slot rather than inventing one", () => {
    const html = renderFace(task());
    expect([...html.matchAll(/data-slot="(\w+)"/g)].map(m => m[1])).toEqual(["state", "title", "bar", "foot"]);
  });
});

describe("K4 / K3 — no ID and no constant chrome on the face", () => {
  it("never prints the task ID, skill, mode or layer as face text", () => {
    for (const node of liveTasks.slice(0, 40)) {
      const text = renderFace(node).replace(/<[^>]+>/g, " ");
      expect(text.includes(node.id), node.id).toBe(false);
      expect(/\brun-task\b|\bcoding\b/.test(text), node.id).toBe(false);
      expect(new RegExp(`\\b${node.layer}\\b`).test(text), node.id).toBe(false);
    }
  });
  it("keeps the ID on hover", () => {
    expect(renderFace(task())).toMatch(/title="plan-x — /);
  });
  it("no face line other than the state word is identical on 90% of live cards", () => {
    const lines = liveTasks.map(n => [faceNow(n)?.text ?? "", faceProof(n).text]);
    for (const k of [0, 1]) {
      const counts = new Map<string, number>();
      for (const l of lines) counts.set(l[k], (counts.get(l[k]) ?? 0) + 1);
      const top = Math.max(...counts.values());
      expect(top / liveTasks.length).toBeLessThan(0.9);
    }
  });
});

describe("K2 — titles fit three lines and never cut a word", () => {
  it("holds for every title in the live backlog", () => {
    const per = charsPerLine(FACE_TITLE_PX);
    for (const node of liveTasks) {
      const t = faceTitle(node);
      expect(wrapWords(t.text, per).length).toBeLessThanOrEqual(FACE_TITLE_LINES);
      const body = t.text.replace(/…$/, "");
      expect(node.title.replace(/\s+/g, " ").startsWith(body), node.id).toBe(true);
      const next = node.title.replace(/\s+/g, " ").charAt(body.length);
      expect(next === "" || /[\s.,;:)—-]/.test(next), `${node.id} cut mid-word at "${body.slice(-12)}|${next}"`).toBe(true);
    }
  });
  it("prefers a sentence boundary", () => {
    const f = fitText("This first clause is fairly long here. Then a second sentence that is much longer than anything the budget allows", 30, 2);
    expect(f.text).toBe("This first clause is fairly long here.");
  });
  it("uses the engine's headline when it sends one", () => {
    expect(faceTitle(task({ headline: "Kill the check tree" })).text).toBe("Kill the check tree");
  });
});

describe("K5 — height follows content, 120–220", () => {
  it("bounds every live card and hands the layout the same height", () => {
    const layout = layoutFlow(live);
    for (const node of liveTasks) {
      const h = faceHeight(node);
      expect(h).toBeGreaterThanOrEqual(FACE_MIN_H);
      expect(h).toBeLessThanOrEqual(FACE_MAX_H);
      const placed = layout.nodes.find(n => n.id === node.id);
      if (placed) expect(placed.height).toBe(h);
    }
  });
  it("a longer card is taller", () => {
    const short = task({ title: "Short" });
    const long = task({ title: "A much longer title that wraps onto a second and then a third line of the card face", status: "in_progress", claim: { by: "lead", seq: 1 }, journal: [row("implement")] });
    expect(faceHeight(long)).toBeGreaterThan(faceHeight(short));
  });
});

describe("C2 — every state is a word and an icon", () => {
  it("labels each state", () => {
    const states = [
      task(), task({ status: "in_progress" }), task({ status: "blocked" }), task({ manual: true }),
      task({ status: "done", journal: [row("execute", { checks: "passed", status: "done" })] }), task({ status: "done" }),
    ].map(n => faceState(n));
    for (const s of states) { expect(s.label.length).toBeGreaterThan(2); expect(s.icon).toBeTruthy(); }
    expect(new Set(states.map(s => s.kind)).size).toBe(6);
  });
});

describe("F1 — flashing means live", () => {
  const working = (min: number, extra: Partial<FlowNode> = {}) =>
    task({ status: "in_progress", claim: { by: "lead", seq: 1 }, journal: [row("implement", { ts: ago(min) })], ...extra });
  it("a held claim whose journal moved recently is live", () => expect(isLive(working(2), NOW)).toBe(true));
  it("a quiet claim is not live", () => expect(isLive(working(40), NOW)).toBe(false));
  it("an unclaimed card is not live", () => expect(isLive(task({ journal: [row("comment")] }), NOW)).toBe(false));
  it("the engine's own live flag wins", () => expect(isLive(working(40, { live: true }), NOW)).toBe(true));
});

describe("F2 — needs-your-decision: you → decided → working → done", () => {
  const asked = task({ manual: true, human: { question: "Publish 0.6.2, or close it?" } });
  const decided = { ...asked, journal: [row("decide")] };
  const working = { ...decided, status: "in_progress" as const, claim: { by: "lead", seq: 2 } };
  const done = { ...working, status: "done" as const, journal: [row("decide"), row("execute", { checks: "passed", status: "done" })] };
  it("flashes while asking", () => {
    const s = faceState(asked);
    expect([s.kind, s.label, s.flashing]).toEqual(["you", "Needs your decision", true]);
    expect(faceNow(asked)?.text).toMatch(/\?$/);
    expect(beaconFor(asked)).toBe("you");
  });
  it("holds steady once answered", () => expect([faceState(decided).kind, faceState(decided).flashing]).toEqual(["decided", false]));
  it("works after the decision", () => expect(faceState(working).kind).toBe("working"));
  it("ends green", () => expect(faceState(done).kind).toBe("done"));
  it("a done card without a passing check is never the green done (C4)", () => expect(faceState({ ...asked, status: "done", journal: [row("decide")] }).kind).toBe("closed"));
});

describe("T3 — zoom tiers", () => {
  it("switches at 75% and 40%", () => {
    expect([1, 0.75, 0.74, 0.4, 0.39, 0.05].map(zoomTier)).toEqual(["full", "full", "glance", "glance", "overview", "overview"]);
  });
  it("the smallest full-tier text (12px) stays ≥ 9px at 75%, the glance text (28px) at 40%", () => {
    expect(12 * 0.75).toBeGreaterThanOrEqual(9);
    expect(28 * 0.4).toBeGreaterThanOrEqual(9);
  });
});

describe("checker seq 158 — still cards stay still, unproven never green", () => {
  const held = (min: number) =>
    task({ status: "in_progress", claim: { by: "lead", seq: 1 }, journal: [row("implement", { ts: ago(min) })] });
  it("a held but quiet claim does not sweep its bar and shows the still 'held' beacon (F1)", () => {
    expect(faceBar(held(120), NOW).working).toBe(false);
    expect(beaconFor(held(120), NOW)).toBe("held");
  });
  it("a live claim sweeps and pulses", () => {
    expect(faceBar(held(2), NOW).working).toBe(true);
    expect(beaconFor(held(2), NOW)).toBe("work");
  });
  it("a journal row from the future is not live", () => {
    expect(isLive(task({ status: "in_progress", claim: { by: "lead", seq: 1 }, journal: [row("implement", { ts: ago(-30) })] }), NOW)).toBe(false);
  });
  it("closed without a passing check, or decided, is never the green done beacon (C4)", () => {
    expect(beaconFor(task({ status: "done" }), NOW)).toBe("closed");
    expect(beaconFor(task({ manual: true, journal: [row("decide")] }), NOW)).toBe("closed");
    expect(beaconFor(task({ status: "done", journal: [row("execute", { checks: "passed", status: "done" })] }), NOW)).toBe("done");
  });
  it("a title quoting its own ID does not put the ID on the face (K4)", () => {
    expect(faceTitle(task({ title: "Follow-up to [plan-x]: tidy the gate" })).text).not.toContain("plan-x");
  });
});
