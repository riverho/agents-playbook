// ─── Flow room — the state bar and the History page (D25, D26; contract S1, S5, S6) ───
//
// S1: one line, always visible, that says which version you are looking at, the phase, what
// the orchestrator is doing and how old the data is. S5: a clock at the top right opens the
// versions, newest first; picking one draws that version's graph (S6). Both are renderers:
// the host (FlowPanel) owns the polling, and nothing here writes (S3) — the Refresh button
// re-reads, it never runs a check or records a row.

import { useEffect, useRef, useState } from "react";
import { History, RefreshCw, X } from "lucide-react";
import type { FlowVersionInfo, StateProjection, VersionHistory } from "@/lib/flow-types";
import { ageText, isStale, REFRESH_CHOICES, type RefreshMinutes } from "@/lib/flow-refresh";
import { ageLabel } from "@/lib/flow-face";

const ORCH_WORDS: Record<string, string> = {
  "not-scheduled": "No orchestrator scheduled",
  paused: "Orchestrator paused",
  idle: "Orchestrator idle",
  working: "Orchestrator working",
  "waiting-on-you": "Orchestrator waiting on you",
  stopped: "Orchestrator stopped",
};

export function versionLabel(v: FlowVersionInfo | null | undefined): string {
  if (!v) return "No version";
  if (v.unnamed) return v.title || "Current loop";
  return [v.version, v.title].filter(Boolean).join(" · ");
}

export interface FlowStateBarProps {
  state: StateProjection | null;
  /** The version the graph on screen belongs to (may be a past one — S6). */
  shown: FlowVersionInfo | null;
  lastOkAt: number | null;
  now: number;
  minutes: RefreshMinutes;
  onMinutes(m: RefreshMinutes): void;
  onRefresh(): void;
  refreshing: boolean;
  /** Why the last refresh failed; the graph on screen is the last good one. */
  error: string | null;
  onHistory(): void;
  /** Showing a past version: offer the way back to the open one. */
  onBackToOpen?: () => void;
}

export function FlowStateBar(p: FlowStateBarProps) {
  const s = p.state;
  const hasVersions = !!s?.version && !s.version.unnamed;
  const past = !!p.shown?.read_only;
  const stale = isStale(p.lastOkAt, p.now, p.minutes);
  const orch = s?.orchestrator;
  const orchWord = orch ? (ORCH_WORDS[orch.state] ?? `Orchestrator ${orch.state}`) : "Orchestrator unknown";
  const tickAge = orch?.last_tick?.ts ? ageLabel(orch.last_tick.ts, p.now) : null;
  return (
    <div className="flow-statebar" role="status" aria-label="Where this loop is" data-past={past ? "true" : "false"}>
      <span className="flow-statebar__ver" data-unnamed={s?.version?.unnamed ? "true" : "false"} title={p.shown?.goal ?? undefined}>
        {past ? <b>Viewing {versionLabel(p.shown)}</b> : <b>{versionLabel(p.shown ?? s?.version)}</b>}
        <span className="flow-statebar__state">{past ? "closed · read-only" : (p.shown ?? s?.version)?.state ?? ""}</span>
      </span>
      {past && p.onBackToOpen && (
        <button type="button" className="flow-statebar__btn" onClick={p.onBackToOpen}>Back to the open version</button>
      )}
      {s?.phase?.phase != null && <span className="flow-statebar__item">Phase {s.phase.phase}</span>}
      <span className={`flow-statebar__item flow-statebar__orch${orch?.state === "waiting-on-you" ? " flow-statebar__orch--needs-you" : ""}`} data-orch={orch?.state ?? "unknown"} title={orch?.reason ?? orch?.note ?? undefined}>
        {orchWord}
        {orch?.state === "stopped" && orch.reason ? `: ${orch.reason}` : ""}
        {tickAge ? <span className="flow-statebar__dim"> · last tick {tickAge} ago</span> : orch?.configured ? <span className="flow-statebar__dim"> · no tick yet</span> : null}
      </span>
      <span className="flex-1" />
      <span className="flow-statebar__item flow-statebar__age" data-stale={stale ? "true" : "false"}>
        {p.error ? <span className="flow-statebar__err" title={p.error}>Refresh failed — showing data from {ageText(p.lastOkAt, p.now)}</span>
          : stale ? <>Data may be out of date · read {ageText(p.lastOkAt, p.now)}</>
          : <>Read {ageText(p.lastOkAt, p.now)}</>}
      </span>
      <button type="button" className="flow-statebar__btn" onClick={p.onRefresh} disabled={p.refreshing} aria-label="Refresh now (reads only)">
        <RefreshCw size={14} aria-hidden className={p.refreshing ? "flow-spin" : undefined} /> Refresh
      </button>
      <label className="flow-statebar__item">
        <span className="sr-only">Refresh every</span>
        <select value={p.minutes} onChange={e => p.onMinutes(Number(e.target.value) as RefreshMinutes)} aria-label="Refresh every">
          {REFRESH_CHOICES.map(m => <option key={m} value={m}>{m ? `every ${m} min` : "refresh off"}</option>)}
        </select>
      </label>
      {/* S5: no versions → nothing to look back on, so no clock (the fallback) */}
      {hasVersions && (
        <button type="button" className="flow-statebar__btn flow-statebar__hist" onClick={p.onHistory} aria-label="History: all versions">
          <History size={16} aria-hidden /> History
        </button>
      )}
    </div>
  );
}

const day = (iso?: string | null) => (iso ? iso.slice(0, 10) : "—");

export interface FlowHistoryProps {
  load(): Promise<VersionHistory>;
  /** The version label on screen, marked in the table. */
  current: string | null;
  onPick(version: string): void;
  onClose(): void;
}

/** S5: every version, newest first — start goal, end goal (its stop checks), state, dates. */
export function FlowHistory({ load, current, onPick, onClose }: FlowHistoryProps) {
  const [data, setData] = useState<VersionHistory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let alive = true;
    load().then(d => { if (alive) setData(d); }, e => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [load]);
  useEffect(() => {
    box.current?.focus();
    // capture phase + preventDefault: the room's own Escape (which ignores handled keys) stays put
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  const rows = [...(data?.versions ?? [])].reverse();
  return (
    <div className="flow-history" role="dialog" aria-modal="true" aria-label="History" tabIndex={-1} ref={box}>
      <div className="flow-history__head">
        <b>History</b>
        <span className="flow-statebar__dim">Every version, newest first. Pick one to see its graph.</span>
        <span className="flex-1" />
        <button type="button" className="flow-statebar__btn" onClick={onClose} aria-label="Close history"><X size={16} aria-hidden /></button>
      </div>
      {error && <p className="flow-statebar__err">Could not read the versions: {error}</p>}
      {!data && !error && <p className="flow-statebar__dim">Reading pb version list…</p>}
      {data && (
        <div className="flow-history__scroll">
          <table className="flow-history__table">
            <thead>
              <tr><th>Version</th><th>Start goal</th><th>End goal (stop checks)</th><th>State</th><th>Opened</th><th>Closed</th></tr>
            </thead>
            <tbody>
              {rows.map(v => {
                const label = v.version ?? v.id;
                return (
                  <tr key={v.id} data-state={v.state} aria-current={label === current ? "true" : undefined}>
                    <td>
                      <button type="button" className="flow-linkbtn" onClick={() => onPick(label)}>
                        <b>{v.version}</b> {v.title}
                      </button>
                    </td>
                    <td>{v.goal ?? "—"}</td>
                    <td>
                      {v.stop_checks?.length ? v.stop_checks.map(c => <code key={c}>{c}</code>) : "—"}
                      {v.stop_result && <span className="flow-statebar__dim"> · {v.stop_result.outcome}</span>}
                    </td>
                    <td>{v.state}</td>
                    <td>{day(v.opened_at ?? v.started_at)}</td>
                    <td>{day(v.closed_at)}</td>
                  </tr>
                );
              })}
              {(data.legacy_loops ?? []).map(l => (
                <tr key={l.id} data-state="legacy">
                  <td><span className="flow-statebar__dim">before versions</span> {l.id}</td>
                  <td>{l.goal ?? l.title ?? "—"}</td>
                  <td>{l.stop ?? "—"}</td>
                  <td>{l.state}</td>
                  <td>{day(l.opened_at)}</td>
                  <td>{day(l.closed_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
