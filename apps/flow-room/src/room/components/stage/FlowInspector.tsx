// ─── Flow room v2 — the open card (D15, D16; contract M2, M3, K4, C2, C4) ───
//
// One card opened without leaving the room, in the approved order:
//
//   title first (headline, owner, how long held) → what this is (the full brief one
//   click away) → where it stands (plain step names, and one sentence on what happens
//   next and who does it) → proof (each check by name, its command underneath, "not
//   run" never looking like a pass) → the conversation (one-line summaries, intent
//   tags, long notes folded) → engine details (folded) → a composer that says what it
//   means (comment, change direction, ask).
//
// Every field is the projection's (lib/flow-types.ts) or a documented fallback
// (lib/flow-open.ts). Sending writes ONE journal row through the adapter —
// `pb comment --intent …` behind the room's server — and shows the row's seq or the
// engine's refusal verbatim. The file keeps its old name: it is a pinned copy
// (PROVENANCE.json), so the history of the inspector stays one history.

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { checksOutcome, flowRail, isHollow, journalTime, railAttrs } from "@/lib/flow-derive";
import { FlowStateChip } from "./FlowCards";
import { agentDisplayName, agoLabel, faceOwner, faceState, isLive, lastMoved } from "@/lib/flow-face";
import { brief, conversation, nextLine, PLAIN_STEPS, proofRows, type MessageIntent } from "@/lib/flow-open";
import type { FlowNode } from "@/lib/flow-types";

export interface SendOutcome {
  ok: boolean;
  note: string;
}

const INTENTS: { id: MessageIntent; label: string; hint: string }[] = [
  { id: "comment", label: "Comment", hint: "A remark. The agent reads it before its next step." },
  { id: "steer", label: "Change direction", hint: "An instruction. The agent changes course." },
  { id: "question", label: "Ask the agent", hint: "A question. The agent answers in the conversation." },
];

function when(at?: string): string {
  const t = Date.parse(at ?? "");
  if (!Number.isFinite(t)) return "";
  return new Date(t).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function FlowInspector({
  node,
  onClose,
  onSend,
  readOnly,
}: {
  node: FlowNode;
  onClose: () => void;
  onSend: (text: string, intent: MessageIntent) => Promise<SendOutcome>;
  readOnly: boolean;
}) {
  const state = faceState(node);
  const live = isLive(node);
  const owner = faceOwner(node);
  const rail = flowRail(node);
  const b = brief(node);
  const next = nextLine(node);
  const proof = proofRows(node);
  const messages = conversation(node);
  const [intent, setIntent] = useState<MessageIntent>("comment");
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<SendOutcome | null>(null);
  // A1: opening a card moves focus into it; the title is the landing point
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => { setOutcome(null); setText(""); setIntent("comment"); titleRef.current?.focus(); }, [node.id]);

  // one send at a time, even for two clicks in the same tick (state alone lags a tick)
  const sending = useRef(false);
  const send = async () => {
    if (sending.current) return;
    sending.current = true;
    setPending(true);
    try {
      const r = await onSend(text.trim(), intent);
      setOutcome(r);
      if (r.ok) setText("");
    } finally {
      sending.current = false;
      setPending(false);
    }
  };
  const moved = agoLabel(lastMoved(node));
  const held = owner ? `${owner.name} picked this up${moved ? ` ${moved}` : ""}` : null;
  const passing = proof.filter(p => p.result === "passed").length;

  return (
    <aside className="flow-inspector flow-oc" aria-label={`Open card: ${node.headline ?? node.title}`}>
      <div className="flow-oc__head">
        <div className="flow-oc__row">
          <FlowStateChip state={state} live={live} />
          {node.priority !== undefined && <span className="flow-oc__muted">Priority {node.priority}</span>}
          <span className="flex-1" />
          <button type="button" className="flow-oc__close" onClick={onClose} aria-label="Close the card (Esc)">
            <X size={16} aria-hidden />
          </button>
        </div>
        <h2 className="flow-oc__title" ref={titleRef} tabIndex={-1}>{node.headline ?? node.title}</h2>
        <div className="flow-oc__muted">
          {[held, node.declared_layer ?? node.layer].filter(Boolean).join(" · ")}
        </div>
      </div>

      <div className="flow-oc__body">
        <section className="flow-oc__sec">
          <h3>What this is</h3>
          <p>{b.short}</p>
          {b.more && (
            <details>
              <summary>Show the full brief</summary>
              <p>{node.title}</p>
              {(node.docs ?? []).length > 0 && (
                <ul className="flow-oc__docs">
                  {(node.docs ?? []).map(d => <li key={d}><code>{d}</code></li>)}
                </ul>
              )}
            </details>
          )}
        </section>

        {node.human && state.kind === "you" && (
          <section className="flow-oc__sec flow-oc__decision" data-hil="asking">
            <h3>Needs your decision</h3>
            <p className="flow-oc__q">{node.human.question}</p>
            <ul>
              {(node.human.options ?? []).map(o => (
                <li key={o.id}>
                  <b>{o.label}</b>{node.human?.recommended === o.id ? ` · recommended by ${agentDisplayName(node.human?.recommended_by ?? "")}` : ""}
                  <span>{o.effect}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="flow-oc__sec">
          <h3>Where it stands <span className="flow-oc__muted">{rail.filled ? `step ${rail.current} of 6` : "not started"}</span></h3>
          <ol className="flow-oc__steps flow-cycle" {...railAttrs(node)}>
            {PLAIN_STEPS.map((s, i) => (
              <li key={s.engine} title={`engine step: ${s.engine}`} data-current={i === rail.current - 1 ? "" : undefined}>
                <i className={i < rail.filled ? "flow-cycle__on" : ""} />
                <span>{s.plain}</span>
              </li>
            ))}
          </ol>
          <p className={`flow-oc__next${next.you ? " flow-oc__next--hil" : ""}`}>{next.text}</p>
        </section>

        <section className="flow-oc__sec">
          <h3>Proof <span className="flow-oc__muted">{proof.length ? `${passing} of ${proof.length} passing` : "no checks declared"}</span></h3>
          <ul className="flow-oc__proof">
            {proof.map((p, i) => (
              <li key={`${i}:${p.command}`} data-result={p.result}>
                <div><b>{p.name}</b><span className="flow-oc__res">{p.word}</span></div>
                <code>{p.command}</code>
              </li>
            ))}
          </ul>
          <p className="flow-oc__muted">The engine refuses "done" until every check exits 0. An agent cannot mark it done by saying so.</p>
        </section>

        <section className="flow-oc__sec">
          <h3>Conversation <span className="flow-oc__muted">{messages.length} message{messages.length === 1 ? "" : "s"}</span></h3>
          {messages.length === 0 && <p className="flow-oc__muted">No messages yet.</p>}
          <ol className="flow-oc__msgs">
            {messages.map(m => (
              <li key={`${m.seq ?? ""}-${m.ts ?? ""}-${m.summary.slice(0, 20)}`}>
                <div className="flow-oc__mh">
                  <span className="flow-face__av" aria-hidden>{m.author.charAt(0).toUpperCase()}</span>
                  <b>{m.author}</b>
                  <span className="flow-oc__muted">{when(m.ts)}</span>
                  <span className="flex-1" />
                  <span className={`flow-oc__tag flow-oc__tag--${m.intent}`}>{m.intent}</span>
                </div>
                <p>{m.summary}</p>
                {m.full && (
                  <details>
                    <summary>Read full note</summary>
                    <p className="flow-oc__full">{m.full}</p>
                  </details>
                )}
              </li>
            ))}
          </ol>
        </section>

        <details className="flow-oc__sec flow-oc__engine">
          <summary>Engine details</summary>
          <dl>
            <dt>Task ID</dt><dd><code>{node.id}</code></dd>
            <dt>Skill · mode</dt><dd>{[node.skill, node.mode].filter(Boolean).join(" · ") || "—"}</dd>
            <dt>Layer</dt><dd>{node.declared_layer ? `${node.declared_layer}, declared` : `${node.layer}, derived from dependencies`}</dd>
            <dt>Check quality</dt><dd>{isHollow(node) ? "hollow: the check cannot fail" : "verified: the check can fail"}</dd>
            <dt>Claim</dt><dd>{node.claim?.by ? `${node.claim.by} (seq ${node.claim.seq ?? "?"})` : "none recorded"}</dd>
            <dt>Worktree</dt><dd>{node.worker?.branch ? <code>{node.worker.branch}</code> : "none"} · checker verdict: {node.checker?.verdict ?? "none"}</dd>
            <dt>Last check run</dt><dd>{checksOutcome(node) ?? "not run"}</dd>
            <dt>Journal</dt><dd>{(node.journal ?? []).length} rows{node.claim?.loop_id ? ` · ${node.claim.loop_id}` : ""}{(node.journal ?? []).length ? ` · last ${journalTime((node.journal ?? [])[(node.journal ?? []).length - 1]) ?? ""}` : ""}</dd>
            {(node.merge_reasons ?? []).length > 0 && (<><dt>Merge</dt><dd>{(node.merge_reasons ?? []).join("; ")}</dd></>)}
          </dl>
        </details>
      </div>

      <form className="flow-oc__composer" onSubmit={e => { e.preventDefault(); if (text.trim() && !pending && !readOnly) void send(); }}>
        <div className="flow-oc__intents" role="group" aria-label="What kind of message">
          {INTENTS.map(i => (
            <button key={i.id} type="button" aria-pressed={intent === i.id} className="flow-oc__intent" onClick={() => setIntent(i.id)}>
              {i.label}
            </button>
          ))}
        </div>
        <label className="flow-oc__muted" htmlFor="flow-oc-text">{INTENTS.find(i => i.id === intent)?.hint}</label>
        <textarea id="flow-oc-text" rows={3} value={text} onChange={e => setText(e.target.value)} placeholder={intent === "question" ? "What do you want to ask?" : "Write to the agent"} />
        <div className="flow-oc__row">
          <span className={`flow-oc__muted${outcome && !outcome.ok ? " is-refused" : ""}`} role="status">
            {readOnly ? "Snapshot: nothing will be written." : outcome ? outcome.note : "Sending writes one row to the project journal."}
          </span>
          <span className="flex-1" />
          <button type="submit" className="flow-btn flow-btn--primary" disabled={!text.trim() || pending || readOnly}>
            {pending ? "Sending…" : "Send"}
          </button>
        </div>
      </form>
    </aside>
  );
}
