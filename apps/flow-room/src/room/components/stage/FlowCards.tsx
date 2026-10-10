// ─── Flow room — the cards ───
//
// One custom React Flow node per painted card. Geometry, radii and type sizes are
// the measured values in flow.css / DESIGN §2.1 (`236 × 104` task cards, a 3 px
// tone bar, Playfair bookends at 236 × 300, dashed fork cards, a rose HIL batch).
//
// Every field a card shows comes off the projection node (`lib/flow-types.ts`):
// the tone bar from `status`, the rail from `journal` (never hand-set), `⚠ hollow`
// from `gate_quality`, `📎 n` from `docs`, the branch/checker from `worker`, the
// counts from `metrics`. The only view state used here is selection and the live
// goal-diff the steering dock just applied — both belong to the surface.

import { Handle, Position, type NodeProps } from "@xyflow/react";
import { TONE_COLOR, TONE_WASH } from "@/lib/stage-tokens";
import { useFlowView } from "@/lib/flow-view";
import {
  type FlowBatchNode,
  type FlowBookendNode,
  type FlowCardData,
  type FlowForkNode,
  type FlowGatepostNode,
  type FlowOrchestratorNode,
  type FlowSteeringNode,
  type FlowTaskNode,
} from "@/lib/flow-projection";
import {
  FLOW_NOTE,
  FLOW_TONE,
  attachmentCount,
  checksCount,
  checksSummary,
  checksUnproven,
  flowRail,
  flowStepLabel,
  hasRedCheck,
  isHollow,
  isProvenCondition,
  needsHuman,
} from "@/lib/flow-derive";
import type { FlowNode } from "@/lib/flow-types";

// ── shared atoms (the stage layer's own idioms) ──────────────────────────

function TonePill({
  tone,
  children,
  title,
}: {
  tone: keyof typeof TONE_COLOR;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium tabular-nums whitespace-nowrap"
      style={{ background: TONE_WASH[tone], color: TONE_COLOR[tone] }}
    >
      {children}
    </span>
  );
}

/** The frame's ink pill — a `done` badge is ink, never green. */
function InkPill({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium tabular-nums whitespace-nowrap"
      style={{ background: "rgba(17,17,17,0.08)", color: "var(--text-primary)" }}
    >
      {children}
    </span>
  );
}

function LiveDot() {
  return (
    <span
      className="inline-block w-1.5 h-1.5 rounded-full shrink-0 animate-pulse"
      style={{ background: "var(--accent-teal)" }}
    />
  );
}

/**
 * The human badge: a rose pill with a breathing halo (2.2 s, opacity .55 → 0).
 * `attention` is the loud variant used on a card that is waiting; the batch card
 * and the goal card use the quiet one.
 */
function HilBadge({ children, attention }: { children: React.ReactNode; attention?: boolean }) {
  return (
    <span className={`flow-hil${attention ? "" : " flow-hil--quiet"}`}>
      <span aria-hidden>🧑</span>
      {children}
    </span>
  );
}

/** The 6-segment cycle rail, derived from this task's journal rows. */
function CycleRail({ node }: { node: FlowNode }) {
  const rail = flowRail(node);
  const label = flowStepLabel(node);
  return (
    <>
      <div className="flow-cycle" aria-label={`cycle: ${rail.step ?? "not started"}`}>
        {[0, 1, 2, 3, 4, 5].map(segment => {
          const filled = segment < rail.filled;
          const active = filled && rail.pulsing && segment === rail.current - 1;
          return (
            <i
              key={segment}
              className={active ? "flow-cycle__on flow-cycle__act" : filled ? "flow-cycle__on" : ""}
            />
          );
        })}
      </div>
      {label && (
        <div className="flow-cycle-lbl">
          <span>{label}</span>
          {node.elapsed && <span>{node.elapsed}</span>}
        </div>
      )}
    </>
  );
}

/** The micro row: skill · checks · ⚠ hollow · 📎 n · branch. */
function MicroRow({ node, children }: { node: FlowNode; children?: React.ReactNode }) {
  const checks = checksCount(node);
  const red = hasRedCheck(node);
  const docs = attachmentCount(node);
  return (
    <div className="flow-micro">
      {node.skill && <b>{node.skill}</b>}
      {checks > 0 && (
        <span
          style={{
            color: red ? TONE_COLOR.block : undefined,
            fontWeight: red ? 600 : undefined,
          }}
          title={
            red
              ? "the last recorded run failed its checks"
              : checksUnproven(node)
                ? "no run outcome is recorded in the projection"
                : "the last recorded run passed its checks"
          }
        >
          {node.skill ? "· " : ""}
          {checksSummary(node)}
        </span>
      )}
      {isHollow(node) && (
        <TonePill tone="risk" title="pb validate: this gate cannot fail">
          ⚠ hollow
        </TonePill>
      )}
      {docs > 0 && <span title={(node.docs ?? []).join("\n")}>📎 {docs}</span>}
      {children}
    </div>
  );
}

function Shell({
  data,
  selected,
  children,
  type,
}: {
  data: FlowCardData;
  selected: boolean;
  children: React.ReactNode;
  type: "task" | "orchestrator" | "fork";
}) {
  const { node, width, height, spawned } = data;
  const { steeredIds } = useFlowView();
  const tone = FLOW_TONE[node.status];
  const mergeAllowed = node.worker?.merge_ready === true && node.checker?.verdict === "pass";
  const classes = [
    "flow-card",
    spawned ? "flow-popin" : "",
    selected ? "flow-card--selected" : "",
    type === "fork" ? "flow-card--fork" : "",
    steeredIds.includes(node.id) ? "flow-card--steered" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div
      className={classes}
      style={{ width, height, borderColor: mergeAllowed ? "var(--accent-teal)" : undefined }}
    >
      <span className="flow-card__bar" style={{ background: tone }} />
      {children}
    </div>
  );
}

// ── the task card ────────────────────────────────────────────────────────

export function FlowTaskCard({ data, selected }: NodeProps<FlowTaskNode>) {
  const { node } = data;
  const human = needsHuman(node);
  const mergeAllowed = node.worker?.merge_ready === true && node.checker?.verdict === "pass";
  return (
    <Shell data={data} selected={selected} type="task">
      <Handle type="target" position={Position.Left} className="flow-handle" />
      <div className="flow-row">
        <span className="flow-id" title={node.id}>
          {node.id}
        </span>
        <span className="flex-1" />
        {node.status === "done" && <InkPill>done</InkPill>}
        {node.status === "in_progress" && (
          <TonePill tone="ok">
            <LiveDot />
            run
          </TonePill>
        )}
        {human && <HilBadge attention>human</HilBadge>}
      </div>
      <div className="flow-title">{node.title}</div>
      <CycleRail node={node} />
      <MicroRow node={node}>
        {/* Only a card an `action: spawn` row actually created wears the chip:
            provenance alone is on every old task and would crowd this row. */}
        {data.spawned && <TonePill tone="note">spawned</TonePill>}
        {node.layer.startsWith("L") && <TonePill tone="muted">{node.layer}</TonePill>}
        {mergeAllowed && (
          <span style={{ color: TONE_COLOR.ok, fontWeight: 600 }}>✓ merge-back</span>
        )}
      </MicroRow>
      <Handle type="source" position={Position.Right} className="flow-handle" />
    </Shell>
  );
}

// ── the bookends ─────────────────────────────────────────────────────────

export function FlowBookendCard({ data }: NodeProps<FlowBookendNode>) {
  const { node, width, height, mergeBack, cron } = data;
  const { goalDiff, steeredIds } = useFlowView();
  const steered = steeredIds.includes(node.id);
  const isGoal = node.kind === "goal";
  return (
    <div className="flow-bookend" style={{ width, height }} data-kind={node.kind}>
      <Handle type="target" position={Position.Left} className="flow-handle" />
      <div className="flow-bookend__kicker">
        {isGoal ? "END GOAL · CYCLE STOP" : "START POINT · LOOP"}
      </div>
      {!isGoal && data.loopId && (
        <div className="flow-mono flow-bookend__loop">{data.loopId}</div>
      )}
      <div className="flow-bookend__title">{node.title}</div>
      {node.body && <div className="flow-bookend__body">{node.body}</div>}

      {!isGoal && cron && (
        <>
          <div className="flow-hr" />
          <div className="flow-cronbox">
            <div className="flow-cronrow">
              <TonePill tone="ok">
                <LiveDot />
                cron
              </TonePill>
              <b>{cron.every}</b>
            </div>
            <div className="flow-cronrow">
              {cron.next_tick} · {cron.last_run}
            </div>
            <div className="flow-cronrow flow-mono">{cron.runs}</div>
          </div>
          <div className="flow-row" style={{ marginTop: 9, gap: 4 }}>
            {data.phase !== undefined && <TonePill tone="muted">phase {data.phase}</TonePill>}
            {data.mode && <TonePill tone="muted">mode {data.mode}</TonePill>}
            {data.tasksClosed && <TonePill tone="ok">{data.tasksClosed}</TonePill>}
            {steered && <TonePill tone="ok">steering applied</TonePill>}
          </div>
          <span className="flow-ripple" aria-hidden />
        </>
      )}

      {isGoal && (
        <>
          <div className="flow-hr" />
          {goalDiff ? (
            <div className="flow-goaldiff">
              <div className="flow-goaldiff__old">{goalDiff.old}</div>
              <div className="flow-goaldiff__new">{goalDiff.new}</div>
              <div className="flow-goaldiff__when">{goalDiff.when}</div>
            </div>
          ) : (
            <ul className="flow-stoplist">
              {(node.stoplist ?? []).map(condition => (
                <li key={condition.text} className={isProvenCondition(condition) ? "" : "is-open"}>
                  <span className="flow-stoplist__mark">
                    {isProvenCondition(condition) ? "✓" : "○"}
                  </span>
                  <span>{condition.text}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="flow-hr" />
          {mergeBack && (
            <div className="flow-row">
              <TonePill tone="ok">merge-back · {mergeBack.verdict}</TonePill>
              <span className="flow-mono">{mergeBack.fork}</span>
            </div>
          )}
          <div className="flow-mono flow-bookend__note">
            {goalDiff
              ? "the goal change is written to the card, so the next tick obeys it"
              : node.north_star
                ? node.north_star
                : "north star: “done” is an exit code, not a claim"}
          </div>
        </>
      )}
      <Handle type="source" position={Position.Right} className="flow-handle" />
    </div>
  );
}

// ── the orchestrator ─────────────────────────────────────────────────────

export function FlowOrchestratorCard({ data }: NodeProps<FlowOrchestratorNode>) {
  const { node, metrics } = data;
  const m = metrics ?? {};
  return (
    <div className="flow-card" style={{ width: data.width, height: data.height }}>
      <span className="flow-card__bar" style={{ background: FLOW_NOTE }} />
      <Handle type="target" position={Position.Left} className="flow-handle" />
      <div className="flow-row">
        <span className="flow-id">orchestrator</span>
        <span className="flex-1" />
        {m.rounds !== undefined && <TonePill tone="note">round {m.rounds}</TonePill>}
      </div>
      <div className="flow-title">{node.title}</div>
      {node.body && <div className="flow-body">{node.body}</div>}
      <div className="flow-row" style={{ marginTop: 7, gap: 4, flexWrap: "wrap" }}>
        {m.spawns !== undefined && <TonePill tone="ok">spawn {m.spawns}</TonePill>}
        {m.forks !== undefined && <TonePill tone="ok">forks {m.forks}</TonePill>}
        {m.hil !== undefined && <TonePill tone="block">HIL {m.hil}</TonePill>}
      </div>
      <Handle type="source" position={Position.Right} className="flow-handle" />
    </div>
  );
}

// ── a fork experiment ────────────────────────────────────────────────────

export function FlowForkCard({ data, selected }: NodeProps<FlowForkNode>) {
  const { node } = data;
  const progress = node.progress ?? 0;
  const branch = node.worker?.branch;
  return (
    <Shell data={data} selected={selected} type="fork">
      <Handle type="target" position={Position.Left} className="flow-handle" />
      <div className="flow-row">
        <span className="flow-id">{node.id === "fork-a" ? "fork A · experiment" : "fork B · experiment"}</span>
        <span className="flex-1" />
        <TonePill tone={progress >= 40 ? "ok" : "muted"}>{progress}%</TonePill>
      </div>
      <div className="flow-title">{node.title}</div>
      <div className="flow-progress">
        <i
          style={{
            width: `${progress}%`,
            background: progress >= 40 ? "var(--accent-teal)" : "var(--text-tertiary)",
          }}
        />
      </div>
      <MicroRow node={node}>
        {branch && <b>{branch}</b>}
        {node.checker?.verdict === "none" && <span>· checker pending</span>}
        {node.checker?.verdict === "pass" && <span>· checker pass</span>}
      </MicroRow>
      <Handle type="source" position={Position.Right} className="flow-handle" />
    </Shell>
  );
}

// ── the human batch: ONE hand-off for every gate ─────────────────────────

export function FlowBatchCard({ data }: NodeProps<FlowBatchNode>) {
  const { node, batch, unevaluated } = data;
  const entries = batch ?? [];
  const declared = unevaluated ?? [];
  return (
    <div className="flow-card" style={{ width: data.width, height: data.height }}>
      <span className="flow-card__bar" style={{ background: "var(--accent-rose)" }} />
      <Handle type="target" position={Position.Left} className="flow-handle" />
      <div className="flow-row">
        <span className="flow-id">waiting on a human</span>
        <span className="flex-1" />
        <HilBadge attention>
          {entries.length} gate{entries.length === 1 ? "" : "s"}
        </HilBadge>
      </div>
      <div className="flow-title">{node.title}</div>
      <div style={{ marginTop: 6 }}>
        {entries.map(entry => (
          <div className="flow-kv" key={`${entry.task ?? entry.gate ?? entry.command}`}>
            <b>{entry.gate ?? entry.task ?? entry.kind ?? "gate"}</b>
            <span>{entry.note ?? entry.reason ?? entry.command}</span>
          </div>
        ))}
      </div>
      <div className="flow-row" style={{ marginTop: 8, gap: 6 }}>
        <span className="flow-btn flow-btn--primary">Answer once</span>
        <span className="flow-btn flow-btn--ghost">Open batch</span>
      </div>
      {node.body && <div className="flow-mono flow-batch__note">{node.body}</div>}
      {/* A declared gate whose command has not run is NOT a blocker: label it as
          unevaluated instead of counting it as work waiting on a person. */}
      {declared.length > 0 && (
        <div className="flow-mono flow-batch__note" title={declared.map(d => d.command).join("\n")}>
          + {declared.length} declared gate{declared.length === 1 ? "" : "s"} not evaluated
        </div>
      )}
    </div>
  );
}

// ── a gate post: a place between two layer columns ───────────────────────

export function FlowGatepostCard({ data }: NodeProps<FlowGatepostNode>) {
  const { node, height, gateLabel, origin } = data;
  const gate = node.gate;
  // The pill's box is measured by the layout (reserved top strip) and drawn from
  // that box, so what the geometry test asserts is literally what is rendered.
  const box = gateLabel?.box;
  return (
    <div className="flow-gatepost" style={{ height }}>
      <svg width="1" height={height} aria-hidden>
        <line
          x1="0.5"
          y1="0"
          x2="0.5"
          y2={height}
          stroke="var(--surface-3)"
          strokeWidth="1"
          strokeDasharray="1 5"
        />
      </svg>
      <span
        className="flow-gatepill"
        style={
          box && origin
            ? {
                left: box.x - origin.x,
                top: box.y - origin.y,
                width: box.width,
                height: box.height,
                transform: "none",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                boxSizing: "border-box",
                overflow: "hidden",
              }
            : undefined
        }
        title={
          gate?.evaluated === false
            ? `${gate.command}: declared, command not executed — not a live blocker`
            : gate?.command
        }
      >
        {gateLabel?.text ?? node.title}
      </span>
    </div>
  );
}

// ── "steering will write" (frame 3, view state — never a projection node) ──

export function FlowSteeringCard({ data }: NodeProps<FlowSteeringNode>) {
  const { steeredIds } = useFlowView();
  const plan = data.plan;
  const applied = data.steeringApplied ?? steeredIds.length > 0;
  return (
    <div className="flow-card" style={{ width: data.width, height: data.height }}>
      <span className="flow-card__bar" style={{ background: "var(--accent-teal)" }} />
      <div className="flow-row">
        <span className="flow-id">steering will write</span>
        <span className="flex-1" />
        <TonePill tone={applied ? "ok" : "muted"}>{applied ? "applied" : "nothing yet"}</TonePill>
      </div>
      <div style={{ marginTop: 6 }}>
        <div className="flow-kv">
          <b>cards</b>
          <span>{plan?.rows ?? "0 rows"}</span>
        </div>
        <div className="flow-kv">
          <b>end goal</b>
          <span>{plan?.goal ?? "no change"}</span>
        </div>
        <div className="flow-kv">
          <b>statuses</b>
          <span>{plan?.statuses ?? "0"}</span>
        </div>
      </div>
      <div className="flow-mono flow-batch__note">
        pressing Steer appends to the journal · PB stays the truth
      </div>
    </div>
  );
}
