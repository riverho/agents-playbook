// ─── Flow room — the steering dock (frame 3) ───
//
// Select many cards (rubber band, ⌘-click) and the dock rises with the selection,
// a prompt and four actions: Comment · Steer direction · Fork experiments ·
// Attach document. It states exactly what it will write BEFORE it writes it —
// journal rows only, zero status changes (D5: steering is journal-native, PB
// stays the truth; PB owns truth, so the dock never claims work).
//
// The write itself goes through the adapter (`applySteering`), never to a local
// store. The fixture adapter returns `persisted: false` and the toast says so.

import { TONE_WASH, TONE_COLOR } from "@/lib/stage-tokens";
import { steeringPlan, type SteeringPlan } from "@/lib/flow-derive";
import type { FlowNode } from "@/lib/flow-types";

export interface SteeringToast {
  readonly plan: SteeringPlan;
  readonly goalEdited: boolean;
  readonly persisted: boolean;
  /** Why it did not persist, in the adapter's words (fixture, refusal, error). */
  readonly note?: string;
}

export function FlowSteeringDock({
  selection,
  prompt,
  onPrompt,
  onSteer,
  onComment,
  onFork,
  onAttach,
}: {
  selection: FlowNode[];
  prompt: string;
  onPrompt: (text: string) => void;
  onSteer: () => void;
  onComment: () => void;
  onFork: () => void;
  onAttach: () => void;
}) {
  const plan = steeringPlan(selection);
  return (
    <div className="flow-dock">
      <div className="flow-dock__top">
        <span className="flow-dock__title">{selection.length} cards selected</span>
        {selection.map(node => (
          <span
            key={node.id}
            className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium"
            style={{ background: TONE_WASH.muted, color: TONE_COLOR.muted }}
          >
            {node.id}
          </span>
        ))}
        <span className="flex-1" />
        <span className="flow-chip flow-chip--on">applies to: cards + end goal</span>
        <span className="flow-chip">fork as one experiment</span>
      </div>

      <textarea
        className="flow-dock__prompt"
        value={prompt}
        placeholder="Steer the selection… what should change, for which cards, and why?"
        onChange={event => onPrompt(event.target.value)}
      />

      <div className="flow-dock__actions">
        <button className="flow-btn flow-btn--primary" onClick={onSteer}>
          Steer direction
        </button>
        <button className="flow-btn" onClick={onComment}>
          Comment on {selection.length}
        </button>
        <button className="flow-btn" onClick={onFork}>
          Fork {selection.length} experiment{selection.length === 1 ? "" : "s"}
        </button>
        <button className="flow-btn" onClick={onAttach}>
          Attach document
        </button>
        <span className="flex-1" />
        <span className="flow-dock__plan">
          {plan.rows} · {plan.goal} · statuses {plan.statuses}
        </span>
        <span className="flow-mono">thread is append-only · pb comment --task &lt;id&gt;</span>
      </div>
    </div>
  );
}

/**
 * Frame 3's toast. It reports what HAPPENED.
 *
 * This copy used to be a confident claim with a footnote: the headline said "Steering
 * applied" and lines ① and ② asserted a journal row and a cron re-read, while only the last
 * line — in smaller text, and only when `persisted` was false — admitted that nothing was
 * written. A reader takes the headline and the numbered list as the report. Now the headline
 * and both claims branch on `persisted`: while it is false this reads as a PREVIEW, and the
 * note comes from the adapter in its own words instead of an assumed cause.
 */
export function FlowSteeringToast({ toast, onDismiss }: { toast: SteeringToast; onDismiss: () => void }) {
  const done = toast.persisted;
  return (
    <div className="flow-toast">
      <div className="flow-toast__h">
        <span
          className="inline-block w-1.5 h-1.5 rounded-full animate-pulse"
          style={{ background: done ? TONE_COLOR.ok : TONE_COLOR.risk }}
        />
        {done ? "Steering applied" : "Steering preview — nothing written yet"}
        <span className="flex-1" />
        <button
          className="flow-mono"
          onClick={onDismiss}
          title="Dismiss"
          style={{ color: "var(--text-tertiary)" }}
        >
          ✕
        </button>
      </div>
      <ul className="flow-toast__list">
        <li>
          <span>①</span>
          <span>
            {done ? "orchestrator commented on" : "would comment on"} {toast.plan.cards} card
            {toast.plan.cards === 1 ? "" : "s"} (1 journal row each)
          </span>
        </li>
        {toast.goalEdited && (
          <li>
            <span>②</span>
            <span>end goal stop condition updated on the card</span>
          </li>
        )}
        <li>
          <span>{toast.goalEdited ? "③" : "②"}</span>
          <span>
            {done
              ? "next cron tick re-reads it — no re-prompt needed"
              : "nothing to re-read yet: the playbook has not changed"}
          </span>
        </li>
        {!done && (
          <li>
            <span>ⓘ</span>
            <span>{toast.note ?? "the adapter did not confirm a write"}</span>
          </li>
        )}
      </ul>
    </div>
  );
}
