// ─── card moves: view state, undoable ───
//
// Dragging a card moves it on THIS screen only — the engine never hears of it. So a move
// is undone here too: before a drag the room keeps where every card stood, Undo puts the
// last one back, and Reorganize returns every card to the layer layout.

export type Positions = Record<string, { x: number; y: number }>;

/** How many moves Undo can walk back. */
export const MOVE_HISTORY_LIMIT = 50;

export function snapshot(nodes: { id: string; position: { x: number; y: number } }[]): Positions {
  const out: Positions = {};
  for (const n of nodes) out[n.id] = { x: n.position.x, y: n.position.y };
  return out;
}

/** True when any card stands somewhere other than in `before` — a click is not a move. */
export function movedSince(before: Positions, nodes: { id: string; position: { x: number; y: number } }[]): boolean {
  return nodes.some(n => {
    const b = before[n.id];
    return !!b && (b.x !== n.position.x || b.y !== n.position.y);
  });
}

/** Put every card that `snap` knows back where it stood; cards it does not know stay. */
export function restore<N extends { id: string; position: { x: number; y: number } }>(nodes: N[], snap: Positions): N[] {
  return nodes.map(n => (snap[n.id] ? { ...n, position: { ...snap[n.id] } } : n));
}

/** Append a snapshot, keeping the newest MOVE_HISTORY_LIMIT. */
export function pushHistory(history: Positions[], snap: Positions): Positions[] {
  const next = [...history, snap];
  return next.length > MOVE_HISTORY_LIMIT ? next.slice(next.length - MOVE_HISTORY_LIMIT) : next;
}
