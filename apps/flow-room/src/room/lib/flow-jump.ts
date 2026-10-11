// ─── Flow room v2 — jumping in (D22; contract J1–J3) ───
//
// What the `+` on a card and the "+ Add a card" in a band can do, as context so the
// node components stay renderers. Every action here is VIEW STATE until the person
// presses Create: a draft is a card in the room, not a task in the engine (J3). Create
// is the only path that writes, and it writes through the adapter — `pb plan` or
// `pb worker create` behind the room's server — never by editing a file.
//
// `.ts` on purpose: a module exporting a context must not sit next to components.

import { createContext, useContext } from "react";
import type { BandDraft } from "./flow-bands";

export interface CreateOutcome {
  ok: boolean;
  /** The engine's own words: the new task id, or its refusal verbatim (H3 / J3). */
  note: string;
  task?: string | null;
}

export interface FlowJump {
  /** Which card's `+` menu is open (one at a time). */
  openPlus: string | null;
  setOpenPlus(id: string | null): void;
  /** J2: start a follow-up (lands one band later) or a card in a band. Writes nothing. */
  addDraft(kind: BandDraft["kind"], band: string, from?: string): void;
  updateDraft(id: string, title: string): void;
  discardDraft(id: string): void;
  /** The ONLY writes: a draft becomes a task; a card is forked into a worker. */
  createDraft(draft: BandDraft): Promise<CreateOutcome>;
  forkCard(taskId: string): Promise<CreateOutcome>;
  /** Show or stack a band's finished cards. */
  toggleStack(band: string): void;
  /** Open a card (comment / steer live in the open card). */
  openCard(id: string): void;
  /** The band a follow-up of this card lands in. */
  followUpBand(taskId: string): string;
  /** Declared bands take `--layer`; derived ones do not. */
  isDeclared(band: string): boolean;
  /** True when the room is reading a snapshot or a sample: Create would write nothing. */
  readOnly: boolean;
}

const noop = () => undefined;
export const FlowJumpContext = createContext<FlowJump>({
  openPlus: null,
  setOpenPlus: noop,
  addDraft: noop,
  updateDraft: noop,
  discardDraft: noop,
  createDraft: async () => ({ ok: false, note: "the room is not mounted" }),
  forkCard: async () => ({ ok: false, note: "the room is not mounted" }),
  toggleStack: noop,
  openCard: noop,
  followUpBand: () => "",
  isDeclared: () => false,
  readOnly: true,
});

export function useFlowJump(): FlowJump {
  return useContext(FlowJumpContext);
}
