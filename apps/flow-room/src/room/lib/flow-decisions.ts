import { faceTitle } from "./flow-face";
import type { FlowGraph, FlowNode } from "./flow-types";

export interface DecisionItem {
  node: FlowNode;
  kind: "Approval" | "Question";
  question: string;
  options: { id: string; label: string; effect?: string }[];
  waiting: string[];
  askedAt: string | null;
  recommended: string | null;
  recommendedBy: string | null;
}

export interface DecisionRow {
  seq: number;
  task: string;
  action: "decide";
  option: string;
  reason: string;
  agent: string;
  ts: string;
  notes: string;
}

/** H4: this is a read-only view of engine asks; no local task status changes. */
export function decisionItems(graph: FlowGraph): DecisionItem[] {
  const open = new Set(graph.nodes.filter(n => n.status !== "done").map(n => n.id));
  return graph.nodes.filter(n => (!n.kind || n.kind === "task" || n.kind === "fork") && n.status !== "done" &&
    (n.manual || n.human?.question) && !n.human?.decided).map(node => {
    const h = node.human;
    const waiting = node.manual ? [...new Set(h?.waiting_on ?? graph.edges.filter(e => e.kind === "dep" && e.from === node.id).map(e => e.to))].filter(id => open.has(id)) : [];
    const dates = (node.journal ?? []).map(r => r.ts ?? r.at).filter((ts): ts is string => !!ts && Number.isFinite(Date.parse(ts)));
    const askedAt = dates.sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null;
    return {
      node, kind: node.manual ? "Approval" as const : "Question" as const,
      question: h?.question ?? `Approve: ${faceTitle(node).text}?`,
      options: h?.options?.length ? h.options : [
        { id: "approve", label: "Approve", effect: "The agent can act on your approval and verify the result." },
        { id: "reject", label: "Reject", effect: "The agent revisits the work with your reason. No status changes automatically." },
        { id: "ask", label: "Ask for more information", effect: "The agent supplies more context before you decide." },
      ],
      waiting, askedAt, recommended: h?.recommended ?? null, recommendedBy: h?.recommended_by ?? null,
    };
  }).sort((a, b) => b.waiting.length - a.waiting.length ||
    (a.askedAt ? Date.parse(a.askedAt) : Infinity) - (b.askedAt ? Date.parse(b.askedAt) : Infinity) || a.node.id.localeCompare(b.node.id));
}
