// ─── Stage Layer — staged Escape ───
//
// Esc should never throw away more than one level of context: clear the
// selection, then close the inspector, then close the stage. Rooms own their
// own selection, so they register a dismisser here and the shell asks them
// first. A dismisser returns true when it consumed the key.

import { createContext, useContext, useEffect } from "react";

export type StageDismisser = () => boolean;

export interface StageEscapeApi {
  register: (dismiss: StageDismisser) => () => void;
}

export const StageEscapeContext = createContext<StageEscapeApi>({
  register: () => () => {},
});

/**
 * Register a room-level Escape handler. Re-registers on every render so the
 * handler always closes over current state.
 */
export function useStageEscape(dismiss: StageDismisser) {
  const { register } = useContext(StageEscapeContext);
  useEffect(() => register(dismiss));
}
