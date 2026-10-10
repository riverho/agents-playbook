// ─── Flow room — prefers-reduced-motion ───
//
// CSS animations can be switched off inside `@media (prefers-reduced-motion:
// reduce)` (index.css does that for the whole room), but SVG/SMIL travel dots
// cannot: `<animateMotion>` is not a CSS animation. So the one JS-read motion
// decision in the room is this hook, and every SMIL effect is gated on it.
//
// It is an external-store read (not an effect that sets state) so the media
// query change is the subscription, exactly as React intends.

import { useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const media = window.matchMedia(QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

function getSnapshot(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia(QUERY).matches;
}

/** True when the user prefers reduced motion — no travel dots, no scaling. */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
