// pb version retitle in the room: History says what a version was called before.

import { describe, expect, it } from "vitest";
import { formerly } from "../components/stage/FlowStateBar";
import type { FlowVersionInfo } from "./flow-types";

const v = (extra: Partial<FlowVersionInfo> = {}): FlowVersionInfo => ({
  id: "loop-1", version: "v0.7", title: "Flow room, the v2 build", state: "closed", goal: "build the room", stop_checks: [], ...extra,
});

describe("formerly — the words before the first correction", () => {
  it("is null for a version never retitled", () => {
    expect(formerly(v(), "title")).toBeNull();
    expect(formerly(v({ retitles: [] }), "goal")).toBeNull();
  });
  it("names the ORIGINAL value, not the last one, after two retitles", () => {
    const x = v({ retitles: [
      { at: "2026-10-12T01:00:00Z", reason: "holds v2", was: { title: "Flow room v1" }, now: { title: "Flow room v2 build" } },
      { at: "2026-10-12T02:00:00Z", reason: "clearer", was: { title: "Flow room v2 build" }, now: { title: "Flow room, the v2 build" } },
    ] });
    expect(formerly(x, "title")).toBe("Flow room v1");
  });
  it("reports each field on its own", () => {
    const x = v({ retitles: [{ at: "2026-10-12T01:00:00Z", reason: "r", was: { goal: "old goal" }, now: { goal: "build the room" } }] });
    expect(formerly(x, "goal")).toBe("old goal");
    expect(formerly(x, "title")).toBeNull();
  });
});
