// ─── Flow room — live view state ───
//
// The two things the room shows that are NOT projection facts and NOT node data:
//
//   · the goal edit a steering action just landed on the end-goal card (frame 3)
//   · which cards that action touched (the "steered" pill)
//
// They travel by context rather than being written into React Flow node data, so
// the node objects stay a pure projection of the adapter's `FlowGraph`, updating
// them can never move a card or drop a selection, and no viewer can mistake them
// for engine truth. This file is `.ts` (no components) on purpose: a module that
// exports a context and a hook must not sit next to component exports.

import { createContext, useContext } from "react";
import type { FlowGoalDiff } from "./flow-types";

export interface FlowViewState {
  goalDiff?: FlowGoalDiff;
  steeredIds: string[];
}

export const FlowViewContext = createContext<FlowViewState>({ steeredIds: [] });

export function useFlowView(): FlowViewState {
  return useContext(FlowViewContext);
}
