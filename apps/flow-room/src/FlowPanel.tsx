import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import FlowRoom from "@/components/stage/FlowRoom";
import { FlowHistory, FlowStateBar } from "@/components/stage/FlowStateBar";
import { LIVE_SNAPSHOT_ADAPTER, type FlowAdapter } from "@/lib/flow-adapter";
import type { FlowGraph, StateProjection } from "@/lib/flow-types";
import { changedCards, createPoller, readRefreshPref, writeRefreshPref, type Poller, type RefreshMinutes } from "@/lib/flow-refresh";

/** The one-word source claim, taken from the adapter's own label ("live …" / "snapshot …"). */
function sourceWord(adapter: FlowAdapter): string {
  if (adapter.kind === "sample") return "sample";
  return adapter.label.split(" ·")[0];
}
import { liveAdapter, loadHistory, loadState, probeEngine } from "./flow-api";

/** This browser's storage, or null where touching it throws (a sandboxed frame, blocked site data). */
function browserStorage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

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
  fontFamily: "var(--f-ui)",
  color: "var(--text-primary)",
  background: "var(--surface-0)",
  textAlign: "center",
};

const CODE: CSSProperties = {
  fontSize: "13px",
  background: "var(--surface-2)",
  border: "1px solid var(--surface-3)",
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
            fontFamily: "var(--f-ui)",
            fontSize: "12px",
            fontWeight: 500,
            lineHeight: 1.4,
            color: "var(--text-primary)",
          }}
        >
          Captured snapshot of the Agents-Playbook repository at extraction time —{" "}
          <strong>not your backlog</strong>. Shown because you asked for it.{" "}
          <button
            style={{ fontFamily: "inherit", fontSize: "inherit", textDecoration: "underline", background: "none", border: 0, cursor: "pointer" }}
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
        <h1 style={{ fontFamily: "var(--f-ui)", fontSize: "20px", fontWeight: 600, lineHeight: 1.2, margin: 0 }}>No local engine</h1>
        <p style={{ margin: 0, maxWidth: "46ch", color: "var(--text-secondary)" }}>
          The room reads a playbook through its own server. Nothing answered at{" "}
          <code>{apiBase}/api/health</code>, so there is no graph to draw.
        </p>
        <p className="flow-panel__cmd" style={{ ...CODE, margin: 0 }}>cd apps/flow-room &amp;&amp; node server.mjs</p>
        <p style={{ margin: 0, maxWidth: "52ch", fontSize: "12px", color: "var(--text-tertiary)" }}>
          {state.detail}
        </p>
        <button
          style={{ fontFamily: "var(--f-ui)", fontSize: "13px", fontWeight: 500, lineHeight: 1, padding: "0.5rem 0.9rem", cursor: "pointer" }}
          onClick={() => setSnapshot(true)}
        >
          view the captured snapshot instead
        </button>
      </div>
    );
  }

  return (
    <div style={{ height: "100%", minHeight: "220px", display: "flex", flexDirection: "column" }}>
      <LiveRoom apiBase={apiBase} initial={state.adapter} />
      {showFooter && (
        <div
          style={{
            padding: "0.25rem 0.75rem",
            borderTop: "1px solid var(--surface-3)",
            fontFamily: "var(--f-ui)",
            fontSize: "12px",
            lineHeight: 1.5,
            color: "var(--text-tertiary)",
            background: "var(--surface-1)",
          }}
        >
          {/* The source word comes from the ADAPTER, like the room's chip: this footer said
              "live · …" even while the captured snapshot was on screen (plan-20261010-022). */}
          {sourceWord(state.adapter)} · {state.root}
          {state.engine ? ` · engine ${state.engine}` : ""}
        </div>
      )}
    </div>
  );
}

/**
 * The live room with its state bar (D25). It owns the refresh: every 1/5/15 min or off (S2),
 * paused while the tab is hidden, asking /api/state with the last change token so an
 * unchanged journal is one 304 (S4). Only a CHANGED token re-reads the graph; the cards that
 * moved glow once. A failed refresh keeps the last good graph and says why. Every request
 * here is a GET: refresh adds no write path (S3).
 */
function LiveRoom({ apiBase, initial }: { apiBase: string; initial: FlowAdapter }) {
  const [adapter, setAdapter] = useState(initial);
  const [proj, setProj] = useState<StateProjection | null>(null);
  const [lastOkAt, setLastOkAt] = useState<number | null>(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [changed, setChanged] = useState<string[]>([]);
  const [minutes, setMinutes] = useState<RefreshMinutes>(() => readRefreshPref(browserStorage()));
  const [now, setNow] = useState(() => Date.now());
  const [showHistory, setShowHistory] = useState(false);
  // S6: null = the open version (the engine's default); a label = a version picked in History
  const [picked, setPicked] = useState<string | null>(null);
  const token = useRef<string | null>(null);
  const graphRef = useRef<FlowGraph>(initial.load());
  const pickedRef = useRef<string | null>(null);
  const busy = useRef(false);

  const reread = useCallback(async (version: string | null, glow: boolean) => {
    const next = await liveAdapter(apiBase, version);
    const after = next.load();
    setChanged(glow ? changedCards(graphRef.current, after) : []);
    graphRef.current = after;
    setAdapter(next);
  }, [apiBase]);

  const poll = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setRefreshing(true);
    try {
      const s = await loadState(apiBase, token.current);
      if (s) {
        setProj(s);
        if (s.change_token !== token.current) {
          const first = token.current === null;
          token.current = s.change_token;
          if (!first) await reread(pickedRef.current, true);
        }
      }
      setLastOkAt(Date.now());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      busy.current = false;
      setRefreshing(false);
      setNow(Date.now());
    }
  }, [apiBase, reread]);

  const poller = useRef<Poller | null>(null);
  useEffect(() => {
    void poll(); // the state bar's first read; the graph is already the one the probe loaded
    const p = createPoller(readRefreshPref(browserStorage()), {
      poll: () => void poll(),
      isHidden: () => document.visibilityState === "hidden",
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: id => window.clearTimeout(id as number),
      clock: () => Date.now(),
    });
    poller.current = p;
    const onVis = () => p.visibilityChanged();
    document.addEventListener("visibilitychange", onVis);
    const clock = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => { p.stop(); document.removeEventListener("visibilitychange", onVis); window.clearInterval(clock); poller.current = null; };
  }, [poll]);

  const changeMinutes = (m: RefreshMinutes) => {
    setMinutes(m);
    writeRefreshPref(browserStorage(), m);
    poller.current?.setMinutes(m);
  };
  const pick = async (version: string | null) => {
    setShowHistory(false);
    pickedRef.current = version;
    setPicked(version);
    try { await reread(version, false); setError(null); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };
  const shown = adapter.load().version ?? proj?.version ?? null;
  const history = useCallback(() => loadHistory(apiBase), [apiBase]);

  return (
    <>
      <FlowStateBar
        state={proj}
        shown={shown}
        lastOkAt={lastOkAt}
        now={now}
        minutes={minutes}
        onMinutes={changeMinutes}
        onRefresh={() => poller.current?.now()}
        refreshing={refreshing}
        error={error}
        onHistory={() => setShowHistory(true)}
        onBackToOpen={picked ? () => void pick(null) : undefined}
      />
      <div style={{ flex: "1 1 0", minHeight: 0, display: "flex", flexDirection: "column", position: "relative" }}>
        <FlowRoom adapter={adapter} changed={changed} />
        {showHistory && (
          <FlowHistory load={history} current={shown?.version ?? null} onPick={v => void pick(v)} onClose={() => setShowHistory(false)} />
        )}
      </div>
    </>
  );
}
