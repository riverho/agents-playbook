// ─── Flow room — the cards ───
//
// One custom React Flow node per painted card. Geometry, radii and type sizes are
// the measured values in flow.css / DESIGN §2.1 (`236 × 104` task cards, a 3 px
// tone bar, Playfair bookends at 236 × 300, dashed fork cards, a fuchsia HIL batch).
//
// Every field a card shows comes off the projection node (`lib/flow-types.ts`):
// the tone bar from `status`, the rail from `journal` (never hand-set), `⚠ hollow`
// from `gate_quality`, `📎 n` from `docs`, the branch/checker from `worker`, the
// counts from `metrics`. The only view state used here is selection and the live
// goal-diff the steering dock just applied — both belong to the surface.

import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Ban, Check, Circle, Hand, MessageSquare, Minus } from "lucide-react";
import {
  ageLabel,
  beaconFor,
  faceBar,
  faceNow,
  faceNowLines,
  faceOwner,
  faceProof,
  faceState,
  faceTitle,
  isLive,
  lastMoved,
  messageRows,
  type FaceState,
} from "@/lib/flow-face";
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
  railAttrs,
  hasRedCheck,
  isHollow,
  isProvenCondition,
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
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[12px] font-medium tabular-nums whitespace-nowrap"
      style={{ background: TONE_WASH[tone], color: TONE_COLOR[tone] }}
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
 * The human badge: a fuchsia (--you) pill with a breathing halo (2.2 s, opacity .55 → 0).
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

// ── the task card (v2 face: K1–K5, F1, F2, C2) ──────────────────────────
//
// Exactly five slots, in this order, and nothing else: state + owner → title → bar →
// now / next → proof + messages. The task ID, skill, mode and layer are not on the
// face (K3, K4): the ID is on hover (the root's title) and in the open card.

function StateIcon({ icon }: { icon: FaceState["icon"] }) {
  const size = 14;
  if (icon === "led") return <span className="flow-led" aria-hidden />;
  if (icon === "hand") return <Hand size={size} aria-hidden />;
  if (icon === "check") return <Check size={size} aria-hidden />;
  if (icon === "block") return <Ban size={size} aria-hidden />;
  if (icon === "dash") return <Minus size={size} aria-hidden />;
  return <Circle size={size} aria-hidden />;
}

export function FlowStateChip({ state, live }: { state: FaceState; live: boolean }) {
  const classes = [
    "flow-st",
    `flow-st--${state.kind}`,
    state.flashing ? "flow-st--asking" : "",
    state.kind === "working" && !live ? "flow-st--quiet" : "",
  ].filter(Boolean).join(" ");
  return (
    <span className={classes} data-state={state.kind}>
      {state.kind === "working" && !live ? <Circle size={14} aria-hidden /> : <StateIcon icon={state.icon} />}
      <span className="flow-st__lg">{state.label}</span>
      <span className="flow-st__sh">{state.short}</span>
    </span>
  );
}

export function FlowFaceBar({ node }: { node: FlowNode }) {
  const bar = faceBar(node);
  return (
    <div
      className={`flow-cycle flow-face__bar${bar.working ? " flow-face__bar--working" : ""}`}
      {...railAttrs(node)}
      role="img"
      aria-label={bar.filled ? `step ${bar.current} of 6` : "not started"}
    >
      {[0, 1, 2, 3, 4, 5].map(segment => {
        const filled = segment < bar.filled;
        const current = filled && bar.working && segment === bar.current - 1;
        return <i key={segment} className={current ? "flow-cycle__on flow-cycle__cur" : filled ? "flow-cycle__on" : ""} />;
      })}
    </div>
  );
}

export function FlowTaskCard({ data, selected }: NodeProps<FlowTaskNode>) {
  const { node, width, height, spawned } = data;
  const { steeredIds } = useFlowView();
  const state = faceState(node);
  const live = isLive(node);
  const owner = faceOwner(node);
  const age = ageLabel(lastMoved(node));
  const title = faceTitle(node);
  const now = faceNow(node);
  const proof = faceProof(node);
  const messages = messageRows(node).length;
  const beacon = beaconFor(node);
  // glance tier: the title is 28px, so a short card shows fewer of its lines (T3)
  const glanceLines = Math.max(1, Math.min(3, Math.floor((height - 104) / 32)));
  const classes = [
    "flow-face",
    `flow-face--${state.kind}`,
    live ? "flow-face--live" : "",
    spawned ? "flow-popin" : "",
    selected ? "flow-face--selected" : "",
    steeredIds.includes(node.id) ? "flow-card--steered" : "",
  ].filter(Boolean).join(" ");
  return (
    <div className={classes} title={`${node.id} — ${node.title}`} data-beacon={beacon}
      data-hil={state.kind === "you" ? "asking" : undefined}
      style={{ width, height, ["--glance-lines" as string]: glanceLines }}>
      <Handle type="target" position={Position.Left} className="flow-handle" />
      <span className={`flow-beacon flow-beacon--${beacon === "you" ? "hil" : beacon}`} aria-hidden />
      <div className="flow-face__top" data-slot="state">
        <FlowStateChip state={state} live={live} />
        <span className="flex-1" />
        {owner ? (
          <span className="flow-face__who">
            <span className="flow-face__av" aria-hidden>{owner.initial}</span>
            {owner.name}
          </span>
        ) : (
          age && <span className="flow-face__age">{age}</span>
        )}
      </div>
      <div className="flow-face__title" data-slot="title">{title.text}</div>
      <div data-slot="bar">
        <FlowFaceBar node={node} />
      </div>
      {now && (
        <p className="flow-face__now" data-slot="now" style={{ ["--now-lines" as string]: faceNowLines(node) }}>
          <b>{now.label}:</b> {now.text}
        </p>
      )}
      <div className="flow-face__foot" data-slot="foot">
        <span className="flow-face__proof tabular-nums whitespace-nowrap">
          {proof.cells.length > 0 && (
            <span className="flow-meter" aria-hidden>
              {proof.cells.map((c, i) => <i key={i} className={c === "none" ? "" : `is-${c}`} />)}
            </span>
          )}
          {proof.text}
        </span>
        <span className="flex-1" />
        <span className="flow-face__msgs" title="messages on this card">
          <MessageSquare size={13} aria-hidden />
          {messages}
        </span>
      </div>
      <Handle type="source" position={Position.Right} className="flow-handle" />
    </div>
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
        <div className="flow-mono flow-code flow-bookend__loop">{data.loopId}</div>
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
              <span className="flow-mono flow-code">{mergeBack.fork}</span>
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
        <span className="flow-kicker">orchestrator</span>
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
        <span className="flow-kicker">{node.id === "fork-a" ? "fork A · experiment" : "fork B · experiment"}</span>
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
      <span className="flow-card__bar flow-batch__bar" style={{ background: "var(--you)" }} />
      <Handle type="target" position={Position.Left} className="flow-handle" />
      <div className="flow-row">
        <span className="flow-kicker">waiting on a human</span>
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
        <span className="flow-kicker">steering will write</span>
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
