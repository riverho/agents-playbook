import { describe, expect, it } from "vitest";
import { MOVE_HISTORY_LIMIT, movedSince, pushHistory, restore, snapshot } from "./flow-moves";

const n = (id: string, x: number, y: number) => ({ id, position: { x, y } });

describe("card moves are undoable view state", () => {
  it("restores the cards a snapshot knows and leaves the rest", () => {
    const before = snapshot([n("a", 0, 0), n("b", 10, 10)]);
    const after = [n("a", 99, 99), n("b", 10, 10), n("c", 5, 5)];
    expect(restore(after, before)).toEqual([n("a", 0, 0), n("b", 10, 10), n("c", 5, 5)]);
  });
  it("a click that moves nothing is not a move", () => {
    const before = snapshot([n("a", 0, 0)]);
    expect(movedSince(before, [n("a", 0, 0)])).toBe(false);
    expect(movedSince(before, [n("a", 1, 0)])).toBe(true);
  });
  it("keeps only the newest moves", () => {
    let h: ReturnType<typeof snapshot>[] = [];
    for (let i = 0; i < MOVE_HISTORY_LIMIT + 5; i++) h = pushHistory(h, { a: { x: i, y: 0 } });
    expect(h).toHaveLength(MOVE_HISTORY_LIMIT);
    expect(h[h.length - 1].a.x).toBe(MOVE_HISTORY_LIMIT + 4);
  });
});
