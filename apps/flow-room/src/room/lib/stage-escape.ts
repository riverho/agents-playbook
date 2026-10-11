// ─── Stage Layer — staged Escape ───
//
// Esc should never throw away more than one level of context: clear the
// selection, then close the inspector, then close the stage. Rooms own their
// own selection, so they register a dismisser here and the shell asks them
// first. A dismisser returns true when it consumed the key.
//
// Standalone (no host shell providing the context — the extracted app), nobody
// would ever ask: the room then listens for Escape itself, so Esc works in both.

import { createContext, useContext, useEffect } from "react";

export type StageDismisser = () => boolean;

export interface StageEscapeApi {
  register: (dismiss: StageDismisser) => () => void;
}

const NO_HOST: StageEscapeApi = { register: () => () => {} };

export const StageEscapeContext = createContext<StageEscapeApi>(NO_HOST);

/**
 * Register a room-level Escape handler. Re-registers on every render so the
 * handler always closes over current state.
 */
export function useStageEscape(dismiss: StageDismisser) {
  const api = useContext(StageEscapeContext);
  useEffect(() => {
    if (api !== NO_HOST) return api.register(dismiss);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented && dismiss()) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
}
