// ─── refresh and freshness — contract S2 with a fake clock ───

import { describe, expect, it } from "vitest";
import { ageText, changedCards, createPoller, DEFAULT_REFRESH, isStale, readRefreshPref, writeRefreshPref } from "./flow-refresh";
import type { FlowGraph, FlowNode } from "./flow-types";

function fakeTime() {
  let t = 0;
  let timers: { id: number; at: number; fn: () => void }[] = [];
  let next = 1;
  return {
    clock: () => t,
    setTimer: (fn: () => void, ms: number) => { const id = next++; timers.push({ id, at: t + ms, fn }); return id; },
    clearTimer: (id: unknown) => { timers = timers.filter(x => x.id !== id); },
    advance(ms: number) {
      const end = t + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const due = timers[0];
        if (!due || due.at > end) break;
        timers = timers.slice(1);
        t = due.at;
        due.fn();
      }
      t = end;
    },
  };
}

describe("S2 — the schedule", () => {
  it("polls every 5 minutes by default", () => {
    const ft = fakeTime();
    let polls = 0;
    createPoller(DEFAULT_REFRESH, { ...ft, poll: () => polls++, isHidden: () => false });
    ft.advance(4 * 60_000); expect(polls).toBe(0);
    ft.advance(60_000); expect(polls).toBe(1);
    ft.advance(10 * 60_000); expect(polls).toBe(3);
  });
  it("does not poll while hidden, and catches up on return", () => {
    const ft = fakeTime();
    let polls = 0;
    let hidden = true;
    const p = createPoller(1, { ...ft, poll: () => polls++, isHidden: () => hidden });
    ft.advance(10 * 60_000);
    expect(polls).toBe(0);
    hidden = false;
    p.visibilityChanged();
    expect(polls).toBe(1);
    ft.advance(60_000);
    expect(polls).toBe(2);
  });
  it("a poll missed while hidden is forgotten when refresh is turned off", () => {
    const ft = fakeTime();
    let polls = 0;
    let hidden = true;
    const p = createPoller(1, { ...ft, poll: () => polls++, isHidden: () => hidden });
    ft.advance(5 * 60_000);
    p.setMinutes(0);
    hidden = false;
    p.visibilityChanged();
    expect(polls).toBe(0);
  });
  it("off means never; 15 means every 15", () => {
    const ft = fakeTime();
    let polls = 0;
    const p = createPoller(0, { ...ft, poll: () => polls++, isHidden: () => false });
    ft.advance(60 * 60_000); expect(polls).toBe(0);
    p.setMinutes(15); // turning refresh on with hour-old data polls at once…
    ft.advance(0); expect(polls).toBe(1);
    ft.advance(14 * 60_000); expect(polls).toBe(1); // …then every 15
    ft.advance(60_000); expect(polls).toBe(2);
  });
  it("the Refresh button polls now and restarts the interval", () => {
    const ft = fakeTime();
    let polls = 0;
    const p = createPoller(5, { ...ft, poll: () => polls++, isHidden: () => false });
    ft.advance(3 * 60_000);
    p.now(); expect(polls).toBe(1);
    ft.advance(4 * 60_000); expect(polls).toBe(1); // 7 min in, but only 4 since the button
    ft.advance(60_000); expect(polls).toBe(2);
  });
  it("marks data stale after twice the interval, never when refresh is off", () => {
    expect(isStale(0, 10 * 60_000, 5)).toBe(false);
    expect(isStale(0, 10 * 60_000 + 1, 5)).toBe(true);
    expect(isStale(0, 99 * 60_000, 0)).toBe(false);
    expect(ageText(0, 3 * 60_000)).toBe("3 min ago");
  });
  it("keeps the interval per viewer in browser storage, defaulting on any failure", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(readRefreshPref(storage)).toBe(5);
    writeRefreshPref(storage, 15);
    expect(readRefreshPref(storage)).toBe(15);
    expect(readRefreshPref({ getItem: () => { throw new Error("blocked"); } })).toBe(5);
    store.set("flow-room:refresh-minutes", "7");
    expect(readRefreshPref(storage)).toBe(5);
  });
});

describe("cards that moved glow once", () => {
  const node = (id: string, extra: Partial<FlowNode> = {}): FlowNode => ({ id, kind: "task", title: id, status: "todo", layer: "L1", journal: [], ...extra });
  const graph = (nodes: FlowNode[]): FlowGraph => ({ schema: "agent-playbook.graph.v1", start: { loop: "l", phase: 1, goal: "g", stop: "s", mode: "m" }, goal: { stop: "s", conditions: [] }, nodes, edges: [], human: { batch: [] } });
  it("finds new and changed cards, not unchanged ones, and nothing on the first read", () => {
    const a = graph([node("x"), node("y")]);
    const b = graph([node("x"), node("y", { status: "in_progress" }), node("z")]);
    expect(changedCards(null, a)).toEqual([]);
    expect(changedCards(a, b)).toEqual(["y", "z"]);
  });
});
