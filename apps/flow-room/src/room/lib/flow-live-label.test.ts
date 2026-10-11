// ─── the chipbar's source chip says what the data IS (plan-20261010-022) ───
//
// The room printed `snapshot · pb graph --json` for every non-sample adapter — a hardcoded string
// — so the adapter that reads the RUNNING engine was labelled a snapshot, and the one field that
// distinguishes a live projection from a bundled capture was demoted to a tooltip.
//
// The chip now takes its text from the adapter. These cases pin the matrix, and they exist because
// "the label is truthful" is a property of the room's output, not of the label string alone.

import { describe, expect, it } from "vitest";
import {
  LIVE_SNAPSHOT_ADAPTER,
  SAMPLE_LAYERED_ADAPTER,
  createPbGraphAdapter,
  sourceChipText,
  type FlowAdapter,
} from "./flow-adapter";
import { FLOW_LIVE_GRAPH } from "@/mocks/flow-graph-live";

describe("the chipbar's source chip", () => {
  it("says LIVE for the adapter that reads the running engine", () => {
    const live = createPbGraphAdapter(() => FLOW_LIVE_GRAPH);
    expect(live.kind).toBe("live");
    expect(sourceChipText(live)).toBe("live · pb graph --json");
  });

  it("never calls a live adapter a snapshot", () => {
    const live = createPbGraphAdapter(() => FLOW_LIVE_GRAPH);
    expect(live.label.startsWith("live")).toBe(true);
    expect(sourceChipText(live)).not.toContain("snapshot");
  });

  it("says snapshot for the bundled capture, and the tooltip still names the repo", () => {
    expect(sourceChipText(LIVE_SNAPSHOT_ADAPTER)).toBe("snapshot · pb graph --json");
    // The parenthetical is dropped from the chip but kept for the tooltip.
    expect(LIVE_SNAPSHOT_ADAPTER.label).toContain("this repo");
    expect(LIVE_SNAPSHOT_ADAPTER.label.startsWith("snapshot")).toBe(true);
  });

  it("keeps the sample's stronger wording rather than its label", () => {
    expect(SAMPLE_LAYERED_ADAPTER.kind).toBe("sample");
    expect(sourceChipText(SAMPLE_LAYERED_ADAPTER)).toBe("sample · unprovable detail");
  });

  it("takes its text from the adapter, so a NEW adapter cannot be mislabelled by a hardcode", () => {
    const custom: FlowAdapter = { ...LIVE_SNAPSHOT_ADAPTER, id: "custom", label: "live · a source added later (with provenance)" };
    expect(sourceChipText(custom)).toBe("live · a source added later");
  });
});
