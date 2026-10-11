import { useRef, useState } from "react";
import { Hand, X } from "lucide-react";
import { ageLabel } from "@/lib/flow-face";
import type { DecisionItem, DecisionRow } from "@/lib/flow-decisions";

interface Props {
  items: DecisionItem[];
  onClose(): void;
  onDecide?: (task: string, option: string, reason: string) => Promise<{ ok: boolean; note: string; row?: DecisionRow }>;
  onRecorded(task: string, row: DecisionRow): void;
}

export function FlowDecisions({ items, onClose, onDecide, onRecorded }: Props) {
  const [selected, setSelected] = useState(items[0]?.node.id ?? "");
  const [receipt, setReceipt] = useState<DecisionRow | null>(null);
  const item = items.find(i => i.node.id === selected) ?? items[0];
  return (
    <section className="flow-decisions" role="dialog" aria-modal="false" aria-labelledby="flow-decisions-title">
      <header className="flow-decisions__head"><Hand size={20} aria-hidden /><h2 id="flow-decisions-title">Waiting on you</h2><span>{items.length} items</span><button type="button" onClick={onClose} aria-label="Close decisions"><X size={20} /></button></header>
      <div className="flow-decisions__body">
        <nav className="flow-decisions__inbox" aria-label="Decision inbox">
          {items.length === 0 && <p>No unanswered decisions.</p>}
          {items.map(i => <button key={i.node.id} type="button" aria-current={item?.node.id === i.node.id ? "true" : undefined} onClick={() => setSelected(i.node.id)}>
            <span className="flow-decisions__kind">{i.kind}</span><strong>{i.question}</strong>
            <span>{i.kind === "Approval" ? `${i.waiting.length} task${i.waiting.length === 1 ? "" : "s"} waiting` : "Does not block work"}{i.askedAt ? ` · ${ageLabel(i.askedAt)} ago` : " · age unknown"}</span>
          </button>)}
        </nav>
        <div className="flow-decisions__detail">
          {receipt && <div role="status" className="flow-decisions__receipt"><p>Decision recorded (row {receipt.seq}). Task status unchanged.</p><p>{receipt.notes}</p><details><summary>View recorded journal row</summary><pre>{JSON.stringify(receipt, null, 2)}</pre></details></div>}
          {item ? <DecisionPanel key={item.node.id} item={item} onDecide={onDecide} onRecorded={(task, row) => { setReceipt(row); onRecorded(task, row); }} /> : <p className="flow-decisions__empty">The next request will appear here.</p>}
        </div>
      </div>
    </section>
  );
}

function DecisionPanel({ item, onDecide, onRecorded }: Pick<Props, "onDecide" | "onRecorded"> & { item: DecisionItem }) {
  const [option, setOption] = useState(item.recommended ?? item.options[0]?.id ?? "");
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; note: string; row?: DecisionRow } | null>(null);
  const inFlight = useRef(false);
  const submit = async () => {
    if (!onDecide || !reason.trim() || inFlight.current || result?.ok) return;
    inFlight.current = true;
    setPending(true);
    try {
      const r = await onDecide(item.node.id, option, reason.trim());
      setResult(r);
      if (r.ok && r.row) onRecorded(item.node.id, r.row);
    } catch (err) {
      setResult({ ok: false, note: err instanceof Error ? err.message : String(err) });
    } finally { inFlight.current = false; setPending(false); }
  };
  return <form className="flow-decisions__panel" onSubmit={e => { e.preventDefault(); void submit(); }}>
    <span className="flow-decisions__kind">{item.kind}</span><h3>{item.question}</h3>
    <h4>What waits on this</h4>
    <p>{item.kind === "Question" ? "This is a question from an agent. Other work can continue." : item.waiting.length ? `${item.waiting.length} task${item.waiting.length === 1 ? "" : "s"} waiting:` : "No dependent tasks are declared. This card still needs your decision."}</p>
    {item.waiting.length > 0 && <ul>{item.waiting.map(id => <li key={id}><code>{id}</code></li>)}</ul>}
    <fieldset disabled={pending || !!result?.ok}><legend>Your options</legend>
      {item.options.map(o => <label key={o.id} className="flow-decisions__option"><input type="radio" name="decision-option" value={o.id} checked={option === o.id} onChange={() => setOption(o.id)} /><span><b>{o.label}</b>{o.id === item.recommended && item.recommendedBy && <span className="flow-decisions__rec">{item.recommendedBy} recommends</span>}<span>{o.effect ?? "No effect stated by the engine."}</span></span></label>)}
    </fieldset>
    <label htmlFor="decision-reason">Reason (saved with your decision)</label>
    <textarea id="decision-reason" value={reason} onChange={e => setReason(e.target.value)} disabled={pending || !!result?.ok} required />
    <p>The agent acts on your answer next and verifies the result. Recording your answer does not complete the task.</p>
    {!onDecide && <p>This view is a snapshot. Open a live playbook to record decisions.</p>}
    <button type="submit" disabled={!onDecide || !reason.trim() || pending || !!result?.ok}>{pending ? "Recording…" : result?.ok ? "Decision recorded" : "Record decision"}</button>
    {result && <div role="status" className="flow-decisions__result"><p>{result.note}</p>{result.row && <pre>{JSON.stringify(result.row, null, 2)}</pre>}</div>}
  </form>;
}
