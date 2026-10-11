// ─── the steering toast has THREE states, not two (plan-20261010-021 fix round) ───
//
// The bug was a fold: `persisted` came to mean "everything asked for landed", including the goal
// half, so a steer whose journal rows HAD landed and whose goal edit was refused rendered as
// "Steering preview — nothing written yet" while saying two lines later that the journal rows were
// written. One render, contradicting itself.
//
// A partial write is now its own state, and the verb reported is the verb that ran: an attach
// writes a card's `docs:` and must never be described as "commented on".

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FlowSteeringToast, type SteeringToast } from "./FlowSteeringDock";

const plan = { cards: 2, rows: "2 journal rows", goal: "1 cycle-brief edit", statuses: "0 status changes" };
const toast = (over: Partial<SteeringToast>): SteeringToast => ({
  plan,
  goalEdited: false,
  persisted: false,
  ...over,
});
const markup = (t: SteeringToast) =>
  renderToStaticMarkup(createElement(FlowSteeringToast, { toast: t, onDismiss: () => undefined }));

describe("FlowSteeringToast", () => {
  it("says nothing was written only when nothing was", () => {
    const html = markup(toast({ applied: false, verb: "comment" }));
    expect(html).toContain("Steering preview — nothing written yet");
    expect(html).toContain("would comment on");
    expect(html).toContain("nothing to re-read yet");
  });

  it("reports a partial steer as applied in part, not as nothing", () => {
    const html = markup(
      toast({
        applied: true,
        persisted: false,
        verb: "comment",
        note: "the journal rows were written but the GOAL half was not applied: the engine refused the edit",
      })
    );
    expect(html).toContain("Steering applied in part");
    expect(html).not.toContain("nothing written yet");
    expect(html).toContain("orchestrator commented on");
    expect(html).toContain("next cron tick re-reads it");
    expect(html).toContain("the GOAL half was not applied");
  });

  it("reports a steer whose halves both landed as applied", () => {
    const html = markup(toast({ applied: true, persisted: true, goalEdited: true, verb: "comment" }));
    expect(html).toContain("Steering applied");
    expect(html).toContain("end goal stop condition updated");
    expect(html).not.toContain("nothing to re-read yet");
  });

  it("never describes an attach as a comment", () => {
    const html = markup(toast({ applied: true, persisted: true, verb: "attach" }));
    expect(html).toContain("attached a document to");
    expect(html).not.toContain("commented on");
  });
});
