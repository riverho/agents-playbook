// ─── Flow room — the card inspector (frame 2) ───
//
// One card opened without leaving the room: the derived cycle, the acceptance
// checks WITH their exit codes, provenance, the worktree/checker gate, the
// attached documents and the orchestrator thread. The panel is 380 px wide and
// uses the frame's section headings (①…⑥); it borrows Pill/Dot/StageAction from
// StageParts so it still reads as the stage layer, not a second design language.
//
// Nothing here is invented: every row is a field of the selected node's
// projection. The thread is the node's `journal` rows whose action is `comment`
// (D5: steering is journal-native), and the actions append rows through the
// adapter — they never write a UI database.

import { useState } from "react";
import { X } from "lucide-react";
import { TONE_COLOR, TONE_WASH } from "@/lib/stage-tokens";
import {
  checksCount,
  checksOutcome,
  checksOutcomeLabel,
  checksUnproven,
  flowRail,
  flowStepLabel,
  hasRedCheck,
  isHollow,
  journalTime,
  needsHuman,
} from "@/lib/flow-derive";
import { FLOW_CYCLE_STEPS, type FlowNode } from "@/lib/flow-types";

/** "12m ago" from an ISO timestamp — display only, never a state source. */
function relativeTime(at?: string): string {
  if (!at) return "";
  const then = Date.parse(at);
  if (Number.isNaN(then)) return "";
  const minutes = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** The document icon is chosen from the path's extension, as the frame does. */
function docIcon(path: string): string {
  if (path.endsWith(".yaml") || path.endsWith(".yml")) return "📐";
  if (path.endsWith(".png") || path.endsWith(".jpg")) return "🖼";
  return "📄";
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flow-sec">
      <div className="flow-sec__h">{title}</div>
      {children}
    </section>
  );
}

function Kv({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flow-kv">
      <b>{label}</b>
      <span>{children}</span>
    </div>
  );
}

export function FlowInspector({
  node,
  onClose,
  onComment,
  onSteer,
  onFork,
}: {
  node: FlowNode;
  onClose: () => void;
  onComment: (text: string) => void;
  onSteer: () => void;
  onFork: () => void;
}) {
  const [draft, setDraft] = useState("");
  const rail = flowRail(node);
  const stepLabel = flowStepLabel(node);
  const comments = (node.journal ?? []).filter(row => row.action === "comment");
  const human = needsHuman(node);

  return (
    <aside className="flow-inspector">
      {/* ① the card, opened */}
      <div className="flow-insp__head">
        <div className="flow-row">
          <span className="flow-mono" style={{ fontSize: 9 }}>
            {node.id}
          </span>
          <span className="flex-1" />
          <span
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium"
            style={{
              background: TONE_WASH[human ? "block" : node.status === "done" ? "muted" : "ok"],
              color: TONE_COLOR[human ? "block" : node.status === "done" ? "muted" : "ok"],
            }}
          >
            {node.status === "in_progress" && (
              <span
                className="inline-block w-1.5 h-1.5 rounded-full animate-pulse"
                style={{ background: TONE_COLOR.ok }}
              />
            )}
            {human ? "needs a human" : node.status.replace("_", " ")}
          </span>
          <button
            onClick={onClose}
            className="shrink-0 flex items-center justify-center w-[18px] h-[18px] rounded"
            style={{ color: "var(--text-tertiary)" }}
            title="Close inspector (Esc)"
          >
            <X size={12} />
          </button>
        </div>
        <div className="flow-insp__title">{node.title}</div>
        <div className="flow-micro" style={{ marginTop: 5 }}>
          {node.skill && <b>{node.skill}</b>}
          {node.layer.startsWith("L") && <span>· {node.layer}</span>}
          {node.provenance?.spawned_by && (
            <span
              className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium"
              style={{ background: TONE_WASH.note, color: TONE_COLOR.note }}
            >
              spawned
            </span>
          )}
          {isHollow(node) && (
            <span
              className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium"
              style={{ background: TONE_WASH.risk, color: TONE_COLOR.risk }}
            >
              ⚠ hollow
            </span>
          )}
        </div>
      </div>

      <div className="flow-insp__body">
        <Section title="① CYCLE · PB LOOP STEPS">
          <div className="flow-cycle flow-cycle--big">
            {[0, 1, 2, 3, 4, 5].map(segment => {
              const filled = segment < rail.filled;
              const active = filled && rail.pulsing && segment === rail.current - 1;
              return (
                <i
                  key={segment}
                  className={
                    active ? "flow-cycle__on flow-cycle__act" : filled ? "flow-cycle__on" : ""
                  }
                />
              );
            })}
          </div>
          <div className="flow-steplist">
            {FLOW_CYCLE_STEPS.map((step, index) => (
              <span
                key={step}
                style={
                  index === rail.current - 1
                    ? { color: TONE_COLOR.ok, fontWeight: 600 }
                    : undefined
                }
              >
                {step}
              </span>
            ))}
          </div>
          <div style={{ marginTop: 6 }}>
            <Kv label="elapsed">
              {node.elapsed ?? "—"} {stepLabel ? `· ${stepLabel}` : ""}
              {node.claim ? ` · claim held by ${node.claim.by}` : ""}
            </Kv>
            <Kv label="derived from">
              {rail.derived
                ? `journal rows (seq ${node.claim?.seq ?? "—"}), never hand-set`
                : "the projection's cycle hint (this node has no journal rows)"}
            </Kv>
          </div>
        </Section>

        <Section title="② ACCEPTANCE CHECKS — pb record --status done RUNS THESE">
          {/* The engine sends the declared commands plus ONE aggregate outcome, so
              that is what this renders. Per-check exit codes appear only when a
              payload can prove each one (`checks_detail`); the live projection
              cannot, and inventing them would be a lie. */}
          {(node.acceptance_checks ??
            node.checks_detail?.map(check => check.command) ??
            []
          ).map(command => {
            const detail = node.checks_detail?.find(check => check.command === command);
            const outcome = checksOutcome(node);
            const tone = detail
              ? detail.passed
                ? TONE_COLOR.ok
                : TONE_COLOR.block
              : outcome === "passed"
                ? TONE_COLOR.ok
                : outcome === "failed"
                  ? TONE_COLOR.block
                  : TONE_COLOR.muted;
            return (
              <div className="flow-checkrow" key={command}>
                <span className="flow-checkrow__code">{command}</span>
                <span
                  className="flow-checkrow__verdict"
                  style={{ color: tone }}
                  title={
                    detail
                      ? "per-check exit code, from a payload that proves it"
                      : "the projection reports one aggregate outcome; it carries no per-check exit codes"
                  }
                >
                  {detail
                    ? detail.passed
                      ? "✓ exit 0"
                      : `✗ exit ${detail.exit_code} · RED`
                    : outcome === "passed"
                      ? "✓ passed"
                      : outcome === "failed"
                        ? "✗ failed"
                        : "— not run"}
                </span>
              </div>
            );
          })}
          {checksCount(node) === 0 && (
            <div className="flow-mono">this card declares no executable check</div>
          )}
          <div style={{ marginTop: 5 }}>
            <Kv label="aggregate">
              <span
                style={{
                  color: hasRedCheck(node)
                    ? TONE_COLOR.block
                    : checksUnproven(node)
                      ? TONE_COLOR.muted
                      : TONE_COLOR.ok,
                }}
              >
                {checksOutcomeLabel(node)}
              </span>
            </Kv>
            <Kv label="declared">{checksCount(node)} acceptance checks</Kv>
          </div>
          <div className="flow-mono flow-note">
            a card may look red and still be honest — “done” is refused until every
            check exits 0, and an unrecorded run is not a pass
          </div>
        </Section>

        <Section title="③ PROVENANCE · WHY THIS CARD EXISTS">
          {node.provenance ? (
            <>
              {node.provenance.spawned_by && (
                <Kv label="spawned by">{node.provenance.spawned_by}</Kv>
              )}
              {node.provenance.origin && <Kv label="origin">{node.provenance.origin}</Kv>}
              {node.provenance.correction && (
                <Kv label="correction">{node.provenance.correction}</Kv>
              )}
              {node.provenance.recorded_by && (
                <Kv label="recorded by">{node.provenance.recorded_by}</Kv>
              )}
            </>
          ) : (
            <div className="flow-mono flow-note">
              no provenance rows — this task was scaffolded directly into the backlog
            </div>
          )}
        </Section>

        <Section title="④ WORKTREE · CHECKER GATE">
          <Kv label="branch">
            <span className="flow-mono" style={{ fontSize: 9.5 }}>
              {node.worker?.branch ?? "no worktree"}
              {node.worker?.status ? ` · ${node.worker.status}` : ""}
              {node.worker?.ahead !== undefined ? ` · ahead ${node.worker.ahead}` : ""}
              {node.worker?.uncommitted !== undefined
                ? ` · uncommitted ${node.worker.uncommitted}`
                : ""}
            </span>
          </Kv>
          <Kv label="merge-ready">
            <span
              className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium"
              style={{
                background: TONE_WASH[
                  node.worker?.merge_ready || node.merge_ready ? "ok" : "block"
                ],
                color: TONE_COLOR[node.worker?.merge_ready || node.merge_ready ? "ok" : "block"],
              }}
            >
              {node.worker?.merge_ready || node.merge_ready
                ? "✓ checker: pass"
                : `✗ checker: ${node.checker?.verdict ?? "none"}`}
            </span>
          </Kv>
          {(node.merge_reasons ?? []).map(reason => (
            <div className="flow-mono flow-note" key={reason}>
              merge_reason: {reason}
            </div>
          ))}
          {(node.merge_warnings ?? []).length > 0 && (
            <div className="flow-note" style={{ color: TONE_COLOR.risk }}>
              {node.merge_warnings?.map(warning => (
                <div key={warning} className="flow-mono" style={{ color: TONE_COLOR.risk }}>
                  ⚠ {warning}
                </div>
              ))}
            </div>
          )}
          <div className="flow-row" style={{ marginTop: 6, gap: 6 }}>
            <span className="flow-btn">Record verdict</span>
            <span className="flow-btn flow-btn--ghost">Merge-back…</span>
          </div>
        </Section>

        <Section title="⑤ DOCUMENTS · ATTACHED TO THIS CARD">
          {(node.docs ?? []).map(path => (
            <div className="flow-doc" key={path}>
              <span aria-hidden>{docIcon(path)}</span>
              <span className="flow-doc__path">{path}</span>
              <span className="flow-mono">vault</span>
            </div>
          ))}
          {(node.docs ?? []).length === 0 && (
            <div className="flow-mono flow-note">no documents attached</div>
          )}
          <div className="flow-row" style={{ marginTop: 6, gap: 6 }}>
            <span className="flow-btn flow-btn--ghost">+ attach from vault</span>
            <span className="flow-mono">paths travel with the playbook</span>
          </div>
        </Section>

        <Section title="⑥ ORCHESTRATOR THREAD · STEERING">
          <div className="flow-thread">
            {comments.map(row => (
              <div className="flow-msg" key={`${row.seq ?? row.ts ?? row.notes.slice(0, 12)}`}>
                <div className="flow-msg__who">
                  <span
                    className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium"
                    style={{
                      background: TONE_WASH[row.agent === "you" ? "muted" : "note"],
                      color: TONE_COLOR[row.agent === "you" ? "muted" : "note"],
                    }}
                  >
                    {row.agent}
                  </span>
                  {relativeTime(journalTime(row))}
                  {row.action === "steer" ? " · steer" : ""}
                </div>
                <div className="flow-msg__text">{row.notes}</div>
              </div>
            ))}
            {comments.length === 0 && (
              <div className="flow-mono flow-note">
                no steering rows yet — this thread is append-only
              </div>
            )}
          </div>
        </Section>
      </div>

      <div className="flow-insp__foot">
        <div className="flow-composer">
          <input
            className="flow-input"
            value={draft}
            placeholder="Ask the orchestrator…"
            onChange={event => setDraft(event.target.value)}
            onKeyDown={event => {
              if (event.key === "Enter" && draft.trim()) {
                onComment(draft.trim());
                setDraft("");
              }
            }}
          />
          <button
            className="flow-btn flow-btn--primary"
            onClick={() => {
              if (!draft.trim()) return;
              onComment(draft.trim());
              setDraft("");
            }}
          >
            Comment
          </button>
        </div>
        <div className="flow-row" style={{ marginTop: 7, gap: 6 }}>
          <button className="flow-btn" onClick={onSteer}>
            Steer direction
          </button>
          <button className="flow-btn" onClick={onFork}>
            Fork to experiment
          </button>
          <span className="flex-1" />
          <span className="flow-mono">append-only · pb comment</span>
        </div>
      </div>
    </aside>
  );
}
