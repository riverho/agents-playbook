import { useEffect, useState, type CSSProperties } from "react";
import FlowRoom from "@/components/stage/FlowRoom";
import { LIVE_SNAPSHOT_ADAPTER, type FlowAdapter } from "@/lib/flow-adapter";
import { liveAdapter, probeEngine } from "./flow-api";

/**
 * The Flow room's host panel — the one place that decides what the room is looking at.
 *
 * It has exactly three honest states, and the third is the point:
 *
 *   probing   … asking the local server whether an engine is behind this page
 *   live      … `pb graph --json`, through the server, handed to the room's own adapter seam
 *   no engine … there is no engine reachable, so it says so instead of drawing a captured
 *               snapshot of somebody else's repo as if it were yours
 *
 * The snapshot is still reachable, but only behind an explicit button and under a banner
 * that names it — decision D7 in artifacts/app-deploy/DEPLOYMENT-PLAN.md.
 *
 * Both hosts render this: `App.tsx` (standalone, `npm start`) and the DSH client plugin
 * (`src/dsh/client.ts`, the global panel in the Harness Web UI). One implementation, so a
 * fix to the honesty of one is a fix to both.
 */
type State =
  | { status: "probing" }
  | { status: "live"; adapter: FlowAdapter; root: string; engine: string | null }
  | { status: "no-engine"; detail: string };

const PANEL: CSSProperties = {
  height: "100%",
  minHeight: "220px",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: "0.75rem",
  padding: "2rem",
  fontFamily: "Inter, system-ui, sans-serif",
  color: "var(--text-primary, #111)",
  background: "var(--surface-0, #f6f4f2)",
  textAlign: "center",
};

const CODE: CSSProperties = {
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  fontSize: "0.85rem",
  background: "var(--surface-2, #eae7e3)",
  border: "1px solid var(--surface-3, #d9d5cf)",
  borderRadius: "6px",
  padding: "0.5rem 0.75rem",
};

export interface FlowPanelProps {
  /** Where the local engine server lives. The standalone app uses same-origin (""). */
  apiBase?: string;
  /** Hide the "live · <root>" footer — a host that has its own chrome does not need it. */
  showFooter?: boolean;
}

export default function FlowPanel({ apiBase = "", showFooter = true }: FlowPanelProps) {
  const [state, setState] = useState<State>({ status: "probing" });
  const [snapshot, setSnapshot] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const probe = await probeEngine(apiBase);
      if (!alive) return;
      if (!probe.reachable) {
        setState({ status: "no-engine", detail: probe.detail });
        return;
      }
      try {
        const adapter = await liveAdapter(apiBase);
        if (alive) setState({ status: "live", adapter, root: probe.info.root, engine: probe.info.engine });
      } catch (err) {
        if (alive) {
          setState({ status: "no-engine", detail: err instanceof Error ? err.message : String(err) });
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [apiBase]);

  if (snapshot) {
    return (
      <div style={{ height: "100%", minHeight: "220px", display: "flex", flexDirection: "column" }}>
        <div
          style={{
            padding: "0.4rem 0.75rem",
            background: "#f59e0b22",
            borderBottom: "1px solid #f59e0b66",
            font: "500 12px/1.4 Inter, system-ui, sans-serif",
            color: "var(--text-primary, #111)",
          }}
        >
          Captured snapshot of the Agents-Playbook repository at extraction time —{" "}
          <strong>not your backlog</strong>. Shown because you asked for it.{" "}
          <button
            style={{ font: "inherit", textDecoration: "underline", background: "none", border: 0, cursor: "pointer" }}
            onClick={() => setSnapshot(false)}
          >
            back
          </button>
        </div>
        <div style={{ flex: "1 1 0", minHeight: 0, display: "flex", flexDirection: "column" }}>
          <FlowRoom adapter={LIVE_SNAPSHOT_ADAPTER} />
        </div>
      </div>
    );
  }

  if (state.status === "probing") {
    return <div style={PANEL}>looking for a local engine…</div>;
  }

  if (state.status === "no-engine") {
    return (
      <div style={PANEL}>
        <h1 style={{ font: "600 20px/1.2 Inter, system-ui, sans-serif", margin: 0 }}>No local engine</h1>
        <p style={{ margin: 0, maxWidth: "46ch", color: "var(--text-secondary, #5c5c5c)" }}>
          The room reads a playbook through its own server. Nothing answered at{" "}
          <code>{apiBase}/api/health</code>, so there is no graph to draw.
        </p>
        <p style={{ ...CODE, margin: 0 }}>cd apps/flow-room &amp;&amp; node server.mjs</p>
        <p style={{ margin: 0, maxWidth: "52ch", fontSize: "0.8rem", color: "var(--text-tertiary, #9a9590)" }}>
          {state.detail}
        </p>
        <button
          style={{ font: "500 13px/1 Inter, system-ui, sans-serif", padding: "0.5rem 0.9rem", cursor: "pointer" }}
          onClick={() => setSnapshot(true)}
        >
          view the captured snapshot instead
        </button>
      </div>
    );
  }

  return (
    <div style={{ height: "100%", minHeight: "220px", display: "flex", flexDirection: "column" }}>
      <FlowRoom adapter={state.adapter} />
      {showFooter && (
        <div
          style={{
            padding: "0.25rem 0.75rem",
            borderTop: "1px solid var(--surface-3, #d9d5cf)",
            font: "400 11px/1.5 'JetBrains Mono', ui-monospace, monospace",
            color: "var(--text-tertiary, #9a9590)",
            background: "var(--surface-1, #fff)",
          }}
        >
          live · {state.root}
          {state.engine ? ` · engine ${state.engine}` : ""}
        </div>
      )}
    </div>
  );
}
