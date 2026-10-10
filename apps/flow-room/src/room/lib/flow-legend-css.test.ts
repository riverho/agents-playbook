// ─── Flow room — the legend's budget formula vs the CSS that draws it ───
//
// `flowLegendContentSize` sizes the legend panel so no row clips, but that
// guarantee is only as strong as `FLOW_LEGEND_METRICS` — and the metrics are only
// meaningful if the budget formula reads what the stylesheet ACTUALLY declares.
// Three holes the fifth review found in that formula:
//
//   1. line-height: `.flow-legend__row { line-height: 1.5 }` used to stay green
//      while the sample's content grew to ~126.7px against a 121px reserve, so the
//      last row clipped silently behind `overflow: hidden` (line-height: 3 → ~212px,
//      still green). The line box is what sets rowH, so it must be in the budget.
//   2. letter-spacing: `letter-spacing: 0.2em` widened every row while the width
//      budget only counted `charW`.
//   3. cascade: a later duplicate `.flow-legend__row { font-size: 20px }` appended
//      to index.css was invisible to a parser that took the FIRST match.
//
// All three are test-completeness — the shipped stylesheet declares no line-height,
// no letter-spacing and no duplicate legend rule. This file reads every matching
// rule in order (the last declaration wins, as CSS does) and folds both properties
// into the budgets, so the formula cannot go stale behind the artifact.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FLOW_LEGEND_METRICS } from "@/lib/flow-derive";

// Comments are stripped first: a declaration that follows a `/* … */` inside a
// block is still a declaration, and a parser that only looks after `;` would miss
// it (which is exactly how this test's own first version missed `overflow`).
const CSS = readFileSync(new URL("../index.css", import.meta.url), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  ""
);

/** The `line-height: normal` factor for Inter, measured conservatively. */
const DEFAULT_LINE_FACTOR = 1.3;
/** Inter's average glyph advance as a fraction of the em, measured high. */
const CHAR_FACTOR = 0.55;

function escapeSelector(selector: string): string {
  return selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Every declaration block for a selector, in CSS order. Reading ALL of them is the
 * cascade fix: an appended override may not hide behind the first match.
 */
function blocks(selector: string): string[] {
  const found = [
    ...CSS.matchAll(new RegExp(`${escapeSelector(selector)}\\s*\\{([^}]*)\\}`, "g")),
  ].map(match => match[1]);
  if (found.length === 0) throw new Error(`index.css has no rule for ${selector}`);
  return found;
}

/** The effective value of a property across those blocks — the LAST one wins. */
function effective(selector: string, property: string): string | undefined {
  let value: string | undefined;
  for (const block of blocks(selector)) {
    const match = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`).exec(block);
    if (match) value = match[1].trim();
  }
  return value;
}

/**
 * `line-height` and `letter-spacing` are INHERITED. Reading them only from the
 * exact rule the budget names misses the equally natural spelling on an ancestor:
 * `.flow-legend { line-height: 3 }` used to stay green while the sample's content
 * grew to ~232px against a 121px reserve (four rows clipped silently). So both
 * properties are resolved down the chain, the element's own rule winning last.
 */
const ANCESTORS: Record<string, string[]> = {
  ".flow-legend": [],
  ".flow-legend__grp": [".flow-legend"],
  ".flow-legend__h": [".flow-legend", ".flow-legend__grp"],
  ".flow-legend__row": [".flow-legend", ".flow-legend__grp"],
  ".flow-legend__row i": [".flow-legend", ".flow-legend__grp", ".flow-legend__row"],
};

/** The inherited value: ancestors first (in order), the element's own rule last. */
function inherited(selector: string, property: string): string | undefined {
  const chain = [...(ANCESTORS[selector] ?? []), selector];
  let value: string | undefined;
  for (const step of chain) {
    const declared = effective(step, property);
    if (declared !== undefined) value = declared;
  }
  return value;
}

/** index.css sets no `html { font-size }`, so 1rem is the browser default. */
const ROOT_FONT_PX = 16;

/**
 * A length as px. `rem` is a UNIT (parsing `1.35rem` as the unitless 1.35 used to
 * under-budget a 21.6px line box), and an unreadable unit throws rather than
 * silently becoming a wrong number.
 */
function toPx(value: string, fontSizePx: number, property: string): number {
  const text = value.trim();
  const numeric = Number.parseFloat(text);
  if (Number.isNaN(numeric)) {
    throw new Error(`${property}: "${value}" is not a length this budget can read`);
  }
  if (text.endsWith("px")) return numeric;
  if (text.endsWith("rem")) return numeric * ROOT_FONT_PX;
  if (text.endsWith("em")) return numeric * fontSizePx;
  if (text.endsWith("%")) return (numeric / 100) * fontSizePx;
  if (/^-?[\d.]+$/.test(text)) return numeric; // unitless (line-height only)
  throw new Error(`${property}: "${value}" uses a unit this budget cannot read`);
}

function lengths(selector: string, property: string): number[] {
  const value = effective(selector, property);
  if (value === undefined) return [];
  return [...value.matchAll(/(-?[\d.]+)px/g)].map(match => Number(match[1]));
}

function fontSize(selector: string): number {
  const size = lengths(selector, "font-size")[0];
  if (!size) throw new Error(`${selector} declares no font-size in px`);
  return size;
}

/** The multiplier the RESOLVED line-height implies (unitless, px, rem, em, %). */
function lineFactor(selector: string): { factor: number; source: string } {
  const size = fontSize(selector);
  const declared = inherited(selector, "line-height");
  if (declared === undefined || declared === "normal") {
    return { factor: DEFAULT_LINE_FACTOR, source: "default (normal)" };
  }
  if (/^-?[\d.]+$/.test(declared.trim())) {
    return { factor: Number.parseFloat(declared), source: `${declared} (unitless)` };
  }
  const px = toPx(declared, size, `${selector} line-height`);
  return { factor: px / size, source: `${declared} → ${px}px` };
}

/** letter-spacing as a fraction of the em (0 when absent or `normal`). */
function letterSpacingEm(selector: string): number {
  const size = fontSize(selector);
  const declared = inherited(selector, "letter-spacing");
  if (declared === undefined || declared === "normal") return 0;
  // Same unit treatment as line-height: `rem` is 16px, not the number in front of it.
  return toPx(declared, size, `${selector} letter-spacing`) / size;
}

describe("the legend metrics agree with the CSS that draws the legend", () => {
  it("matches the panel's padding and column gap", () => {
    const padding = lengths(".flow-legend", "padding");
    expect(padding.length).toBeGreaterThanOrEqual(2);
    expect(FLOW_LEGEND_METRICS.padY, "padY vs .flow-legend padding-top").toBe(padding[0]);
    expect(FLOW_LEGEND_METRICS.padX, "padX vs .flow-legend padding-left").toBe(padding[1]);
    expect(FLOW_LEGEND_METRICS.groupGap, "groupGap vs .flow-legend gap").toBe(
      lengths(".flow-legend", "gap")[0]
    );
    // The failure mode this coupling exists for: overflow:hidden clips silently.
    expect(effective(".flow-legend", "overflow")).toBe("hidden");
  });

  it("matches the row group's gap, the swatch width and the row gap", () => {
    expect(FLOW_LEGEND_METRICS.rowGap, "rowGap vs .flow-legend__grp gap").toBe(
      lengths(".flow-legend__grp", "gap")[0]
    );
    expect(FLOW_LEGEND_METRICS.swatchGap, "swatchGap vs .flow-legend__row gap").toBe(
      lengths(".flow-legend__row", "gap")[0]
    );
    expect(FLOW_LEGEND_METRICS.swatchW, "swatchW vs .flow-legend__row i width").toBe(
      lengths(".flow-legend__row i", "width")[0]
    );
  });

  it("gives every declared font-size the line box its line-height actually needs", () => {
    for (const selector of [".flow-legend__h", ".flow-legend__row"]) {
      const size = fontSize(selector);
      const { factor, source } = lineFactor(selector);
      const budget =
        selector === ".flow-legend__h"
          ? FLOW_LEGEND_METRICS.headerH
          : FLOW_LEGEND_METRICS.rowH;
      const needed = Math.ceil(size * factor);
      expect(size).toBeGreaterThan(0);
      expect(factor, `${selector} line-height budget`).toBeGreaterThan(0);
      expect(
        budget,
        `${selector}: budget ${budget}px < ${size}px × line-height ${factor} (${source}) = ${needed}px — rows would clip`
      ).toBeGreaterThanOrEqual(needed);
    }
  });

  it("gives the row AND header text a width budget that covers its letter-spacing", () => {
    for (const selector of [".flow-legend__row", ".flow-legend__h"]) {
      const size = fontSize(selector);
      const spacing = letterSpacingEm(selector);
      const needed = size * (CHAR_FACTOR + spacing);
      expect(
        FLOW_LEGEND_METRICS.charW,
        `${selector}: charW ${FLOW_LEGEND_METRICS.charW} < ${CHAR_FACTOR}em + ${spacing}em of ${size}px = ${needed.toFixed(2)}px — labels would overrun the panel`
      ).toBeGreaterThanOrEqual(needed);
      expect(FLOW_LEGEND_METRICS.charW).toBeLessThan(size * (1 + spacing));
    }
  });

  it("resolves the cascade: a later override is the value the budget reads", () => {
    // The parser must see EVERY block for a selector, not the first: a rule
    // appended at the end of index.css is the one the browser applies.
    for (const selector of [".flow-legend", ".flow-legend__row"]) {
      expect(blocks(selector).length).toBeGreaterThanOrEqual(1);
    }
    const lastRowBlock = blocks(".flow-legend__row").at(-1) as string;
    expect(effective(".flow-legend__row", "font-size")).toBe(
      new RegExp(`font-size\\s*:\\s*([^;]+)`).exec(lastRowBlock)?.[1].trim()
    );
  });

  it("reads an inherited line-height and letter-spacing from the ancestor chain", () => {
    // Both properties are inherited, so a declaration on `.flow-legend` (or the
    // group) IS the row's value; the budget must resolve the chain, not ignore it.
    expect(ANCESTORS[".flow-legend__row"]).toContain(".flow-legend");
    expect(ANCESTORS[".flow-legend__h"]).toContain(".flow-legend");
    // Today: no line-height anywhere in the chain (either element), and the row
    // inherits no letter-spacing. The header declares its own 0.1em, which the
    // width budget above already covers.
    expect(inherited(".flow-legend__row", "line-height")).toBeUndefined();
    expect(inherited(".flow-legend__h", "line-height")).toBeUndefined();
    expect(inherited(".flow-legend__row", "letter-spacing")).toBeUndefined();
    expect(inherited(".flow-legend__h", "letter-spacing")).toBe("0.1em");
  });

  it("treats rem as a unit rather than as a unitless multiplier", () => {
    // 1.35rem is 21.6px (browser default root), not 1.35 — the old parser read it
    // as unitless and under-budgeted by ~50px.
    expect(toPx("1.35rem", 9.5, "test")).toBeCloseTo(21.6, 5);
    expect(toPx("1.35rem", 9.5, "test")).not.toBe(1.35);
    expect(toPx("13px", 9.5, "test")).toBe(13);
    expect(toPx("1.5em", 10, "test")).toBe(15);
    expect(toPx("150%", 10, "test")).toBe(15);
    expect(() => toPx("calc(1rem + 2px)", 9.5, "test")).toThrow(/not a length|cannot read/);
  });
});
