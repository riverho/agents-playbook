// ─── Flow room v2 — the layer view's pieces (D21, D22; contract G1–G5, J1–J3) ───
//
// Bands (shaded, darker for lower layers, hatched when derived), the gate post between
// two bands, the stack of a band's finished cards, the draft card, and the `+` on every
// task card. Geometry comes from lib/flow-bands.ts; behaviour from lib/flow-jump.ts.

import { useState } from "react";
import { Handle, Position, useStore, type NodeProps } from "@xyflow/react";
import { Check, Circle, GitFork, MessageSquare, Plus, CornerDownRight } from "lucide-react";
import { draftCommand } from "@/lib/flow-bands";
import type { FlowBandNode, FlowDraftNode, FlowLayerGateNode, FlowStackNode } from "@/lib/flow-projection";
import { useFlowJump, type CreateOutcome } from "@/lib/flow-jump";
import type { DraftNode, StackNode } from "@/lib/flow-bands";
import type { FlowNode } from "@/lib/flow-types";

// ── a band (G1) ───────────────────────────────────────────────────────────

export function FlowBandCard({ data }: NodeProps<FlowBandNode>) {
  const { band, width, height } = data;
  const b = band.band;
  const jump = useFlowJump();
  const open = b.open.length;
  const shade = b.source === "derived" ? "x" : String(Math.min(b.depth, 2));
  // a band narrower on screen than its fixed-size label shows only its id (overview)
  const zoom = useStore(state => state.transform[2]);
  const narrow = width * zoom < 150;
  return (
    <div
      className={`flow-band${b.source === "derived" ? " flow-band--derived" : ""}`}
      data-shade={shade}
      data-band={b.id}
      style={{ width, height }}
    >
      <div className="flow-band__head">
        <div className="flow-band__name">
          {b.id}
          <span>{b.name ?? (b.source === "derived" ? "derived" : "")}</span>
        </div>
        <div className="flow-band__about">
          {[b.about, `${open} open`, `${b.done.length} done`].filter(Boolean).join(" · ")}
        </div>
      </div>
      {/* overview: a fixed-size label so the band stays named at 5% (T3, G5) */}
      <div className="flow-band__label" aria-hidden>
        <b>{b.id}{b.name && !narrow ? ` ${b.name}` : ""}</b>
        <span hidden={narrow}>
          {open} open{b.live ? ` · ${b.live} working` : ""}{b.needsYou ? ` · ${b.needsYou} need you` : ""}
        </span>
      </div>
      {/* S7: a past version takes no new cards */}
      {!jump.pastVersion && (
        <button
          type="button"
          className="flow-bandplus nodrag nopan"
          onClick={() => jump.addDraft("card", b.id)}
        >
          <Plus size={16} aria-hidden /> Add a card to {b.id}
        </button>
      )}
    </div>
  );
}

// ── the gate post between two bands (G4) ──────────────────────────────────

export function FlowLayerGateCard({ data }: NodeProps<FlowLayerGateNode>) {
  const { post, height } = data;
  return (
    <div className="flow-lgate" style={{ height }} data-state={post.state}>
      <span className="flow-lgate__pill" title={post.title} aria-label={post.text} role="img">
        <span className="flow-lgate__txt">{post.text}</span>
      </span>
    </div>
  );
}

// ── a band's finished work, stacked (G3) ──────────────────────────────────

export function FlowStackCard({ data }: NodeProps<FlowStackNode>) {
  const node = data.node as StackNode;
  const jump = useFlowJump();
  const n = node.stack.ids.length;
  const unproven = n - node.stack.proven;
  const proven = n > 0 && unproven === 0;
  const state = proven ? "done" : "closed";
  return (
    <div className="flow-face flow-face--stack" style={{ width: data.width, height: data.height }} data-beacon={state}>
      <Handle type="target" position={Position.Left} className="flow-handle" />
      <span className={`flow-beacon flow-beacon--${state}`} aria-hidden />
      <div className="flow-face__top" data-slot="state">
        <span className={`flow-st flow-st--${state}`}>{proven ? <Check size={14} aria-hidden /> : <Circle size={14} aria-hidden />}<span className="flow-st__lg">{proven ? "Done" : "Closed, proof incomplete"}</span><span className="flow-st__sh">{proven ? "Done" : "Closed"}</span></span>
        <span className="flex-1" />
        <span className="flow-face__age">{n} card{n === 1 ? "" : "s"}</span>
      </div>
      <div className="flow-face__title" data-slot="title">{node.title}</div>
      <p className="flow-face__now" data-slot="now">
        {unproven
          ? `${node.stack.proven} passed their checks · ${unproven} closed without a passing check`
          : "Each passed its checks."}
      </p>
      <div className="flow-face__foot" data-slot="foot">
        <button type="button" className="flow-linkbtn nodrag nopan" onClick={() => jump.toggleStack(node.stack.band)}>
          Show them
        </button>
      </div>
      <Handle type="source" position={Position.Right} className="flow-handle" />
    </div>
  );
}

// ── a draft: written in the room, created in the engine only on Create (J3) ──

export function FlowDraftCard({ data }: NodeProps<FlowDraftNode>) {
  const node = data.node as DraftNode;
  const d = node.draft;
  const jump = useFlowJump();
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<CreateOutcome | null>(null);
  const declared = jump.isDeclared(d.band);
  const create = async () => {
    setPending(true);
    const r = await jump.createDraft(d);
    setPending(false);
    setOutcome(r);
  };
  return (
    <div className="flow-face flow-face--draft" style={{ width: data.width, height: data.height }}>
      <div className="flow-face__top">
        <span className="flow-st flow-st--ready">
          {d.kind === "follow-up" ? <CornerDownRight size={14} aria-hidden /> : <Plus size={14} aria-hidden />}
          <span className="flow-st__lg">{d.kind === "follow-up" ? "Draft follow-up" : "Draft card"}</span>
          <span className="flow-st__sh">Draft</span>
        </span>
      </div>
      <textarea
        className="flow-draft__goal nodrag nopan"
        aria-label="What should this task do?"
        placeholder="What should this task do?"
        value={d.title}
        onChange={e => jump.updateDraft(d.id, e.target.value)}
        rows={2}
      />
      <code className="flow-draft__cmd" title="what Create runs">{draftCommand(d, declared)}</code>
      {outcome ? (
        <p className={`flow-draft__note${outcome.ok ? "" : " is-refused"}`} role="status">{outcome.note}</p>
      ) : (
        <div className="flow-face__foot">
          <button type="button" className="flow-btn flow-btn--primary nodrag nopan" disabled={pending || !d.title.trim()} onClick={create}>
            {pending ? "Creating…" : "Create"}
          </button>
          <button type="button" className="flow-btn flow-btn--ghost nodrag nopan" onClick={() => jump.discardDraft(d.id)}>
            Discard
          </button>
          <span className="flex-1" />
          <span>{jump.readOnly ? "snapshot: nothing will be written" : "nothing is written until Create"}</span>
        </div>
      )}
    </div>
  );
}

// ── the `+` on every task card (J1, J2) ───────────────────────────────────

export function FlowPlus({ node }: { node: FlowNode }) {
  const jump = useFlowJump();
  const open = jump.openPlus === node.id;
  const [confirmFork, setConfirmFork] = useState(false);
  const [outcome, setOutcome] = useState<CreateOutcome | null>(null);
  const next = jump.followUpBand(node.id);
  const close = () => { jump.setOpenPlus(null); setConfirmFork(false); setOutcome(null); };
  return (
    <>
      <button
        type="button"
        className="flow-plus nodrag nopan"
        aria-label={`Jump in on: ${node.title}`}
        aria-expanded={open}
        onClick={e => { e.stopPropagation(); open ? close() : jump.setOpenPlus(node.id); }}
      >
        <Plus size={18} aria-hidden />
      </button>
      {open && (
        <div className="flow-pop nodrag nopan nowheel" role="menu" onClick={e => e.stopPropagation()}>
          {outcome ? (
            <>
              <p className={`flow-draft__note${outcome.ok ? "" : " is-refused"}`} role="status">{outcome.note}</p>
              <button type="button" role="menuitem" onClick={close}><b>Close</b></button>
            </>
          ) : jump.pastVersion ? (
            <>
              {/* S7: history is read-only — the only way forward is a new card in the open version */}
              <div className="flow-pop__h">{jump.pastVersion} is closed</div>
              <button type="button" role="menuitem" className="flow-pop__go"
                onClick={async () => setOutcome(await jump.forkIntoOpen(node.id))}>
                <b><GitFork size={14} aria-hidden /> Fork into the open version</b>
                <span>A new experiment card that follows this one · this card stays as it was</span>
              </button>
              <button type="button" role="menuitem" onClick={() => { jump.openCard(node.id); close(); }}>
                <b><MessageSquare size={14} aria-hidden /> Comment</b>
                <span>Opens the card; your comment goes in its journal</span>
              </button>
            </>
          ) : confirmFork ? (
            <>
              <div className="flow-pop__h">Fork into a worker</div>
              <code className="flow-draft__cmd">pb worker create {node.id} --execute</code>
              <p className="flow-pop__p">An isolated worktree and branch; the card stays where it is.</p>
              <button type="button" role="menuitem" className="flow-pop__go" disabled={jump.readOnly}
                onClick={async () => setOutcome(await jump.forkCard(node.id))}>
                <b>{jump.readOnly ? "Snapshot: nothing will be written" : "Create fork"}</b>
              </button>
              <button type="button" role="menuitem" onClick={() => setConfirmFork(false)}><b>Back</b></button>
            </>
          ) : (
            <>
              <div className="flow-pop__h">Jump in</div>
              <button type="button" role="menuitem" onClick={() => { jump.addDraft("follow-up", next, node.id); close(); }}>
                <b><CornerDownRight size={14} aria-hidden /> Follow-up task</b>
                <span>Lands in {next}, after this card · a draft until Create</span>
              </button>
              <button type="button" role="menuitem" onClick={() => setConfirmFork(true)}>
                <b><GitFork size={14} aria-hidden /> Fork into a worker</b>
                <span>Work on it in parallel in its own worktree</span>
              </button>
              <button type="button" role="menuitem" onClick={() => { jump.openCard(node.id); close(); }}>
                <b><MessageSquare size={14} aria-hidden /> Comment or steer</b>
                <span>Opens the card; your message goes in its journal</span>
              </button>
            </>
          )}
        </div>
      )}
    </>
  );
}
