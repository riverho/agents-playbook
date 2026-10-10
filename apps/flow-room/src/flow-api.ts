// ─── Flow room — the client seam to a local engine ───
//
// The room takes a `FlowAdapter` and never learns where its data came from. This module
// is the only place that knows it came from a server, and it is deliberately thin: it
// fetches, and it hands the payload to the SAME `createPbGraphAdapter` seam the room
// already had, so a live payload is validated and projected by exactly the code path the
// fixture goes through.
//
// Two things it must not do:
//   · it must not pretend. If there is no engine, the caller has to be able to say so out
//     loud — a captured snapshot of *this* repo rendered confidently on someone else's
//     machine is a lie, and the room's own chipbar would label it "snapshot".
//   · it must not write anything except through the server's pb-backed routes. The browser
//     never touches backlog.yaml or the journal.
//
// WHY `apiBase` EXISTS: the standalone app is served BY the engine server, so its API is
// same-origin (""). The DSH client plugin is a panel inside the Harness Web UI, which is a
// different origin — so it passes the local server's absolute address instead. Same code,
// two hosts; decision D6 in artifacts/app-deploy/DEPLOYMENT-PLAN.md.

import { createPbGraphAdapter, type FlowAdapter, type FlowSteeringMode } from "@/lib/flow-adapter";
import { steeringPlan } from "@/lib/flow-derive";
import type { FlowGraph, FlowNode } from "@/lib/flow-types";

const CSRF_HEADER = { "x-pb-ui": "1", "content-type": "application/json" } as const;

export interface EngineInfo {
  root: string;
  engine: string | null;
}

export type Probe = { reachable: true; info: EngineInfo } | { reachable: false; detail: string };

/** Is there a local engine behind this page? Never throws. */
export async function probeEngine(apiBase = ""): Promise<Probe> {
  try {
    const res = await fetch(`${apiBase}/api/health`, { headers: { accept: "application/json" } });
    const body = (await res.json()) as { ok?: boolean; root?: string; engine?: string | null; detail?: string };
    if (!res.ok || !body.ok) {
      return { reachable: false, detail: body.detail ?? `engine said ${res.status}` };
    }
    return { reachable: true, info: { root: body.root ?? "(unknown)", engine: body.engine ?? null } };
  } catch (err) {
    return { reachable: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** `pb graph --json`, through the server. Throws with the engine's own words on refusal. */
export async function loadGraph(apiBase = ""): Promise<FlowGraph> {
  const res = await fetch(`${apiBase}/api/graph`, { headers: { accept: "application/json" } });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string; detail?: string } | null;
    throw new Error(body?.detail ?? body?.error ?? `pb graph failed (${res.status})`);
  }
  return (await res.json()) as FlowGraph;
}

/**
 * The live adapter. `createPbGraphAdapter` wants a SYNCHRONOUS read, so the payload is
 * fetched once and closed over — the room stays synchronous for reading, and a refresh is a
 * reload.
 *
 * It also supplies the WRITE half, which is the half that was missing: `createPbGraphAdapter`
 * ships the fixture's `applySteering`, so Comment and Steer updated the UI and wrote nothing.
 * Here each selected card becomes one `pb comment` through the server — a real journal row,
 * or a refusal reported in the adapter's own words.
 */
export async function liveAdapter(apiBase = ""): Promise<FlowAdapter> {
  const graph = await loadGraph(apiBase);
  const base = createPbGraphAdapter(() => graph);
  return {
    ...base,
    applySteering: async (selection: FlowNode[], prompt: string, mode: FlowSteeringMode = "steer") => {
      const tasks = selection.map((node) => node.id);
      const wrote = steeringPlan(selection);

      if (mode === "attach") {
        // No pb command writes a task's `docs:` yet, and the room will not edit
        // memory/backlog.yaml itself. Say so rather than pretend (plan-20261010-021).
        return {
          rows: [],
          wrote,
          persisted: false,
          note: "attach is not implemented: no `pb` command writes a task's docs: field yet",
        };
      }

      try {
        const res = await steer(tasks, prompt, mode === "steer" ? prompt : undefined, apiBase);
        const ok = res.rows.filter((row) => row.ok);
        const failed = res.rows.filter((row) => !row.ok);
        return {
          rows: ok.map((row) => ({ task: row.task, action: "comment" as const, text: prompt })),
          wrote,
          persisted: failed.length === 0 && ok.length === tasks.length,
          note:
            failed.length > 0
              ? `pb refused ${failed.length} of ${tasks.length}: ${failed
                  .map((row) => `${row.task} — ${row.detail ?? "refused"}`)
                  .join("; ")}`
              : res.goal_note,
        };
      } catch (err) {
        return {
          rows: [],
          wrote,
          persisted: false,
          note: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}

async function post<T>(route: string, payload: unknown, apiBase = ""): Promise<T> {
  const res = await fetch(`${apiBase}${route}`, {
    method: "POST",
    headers: CSRF_HEADER,
    body: JSON.stringify(payload),
  });
  const body = (await res.json().catch(() => null)) as (T & { error?: string; detail?: string }) | null;
  if (!res.ok) {
    throw new Error(body?.detail ?? body?.error ?? `${route} failed (${res.status})`);
  }
  return body as T;
}

/** One journal row, written by `pb comment --task … --text …`. */
export const comment = (task: string, text: string, apiBase = "") =>
  post<{ ok: boolean; task: string; wrote: string }>("/api/comment", { task, text }, apiBase);

/** Comment on every selected card; the goal half is reported, never faked. */
export const steer = (tasks: string[], text: string, goal?: string, apiBase = "") =>
  post<{
    ok: boolean;
    rows: { task: string; ok: boolean; detail?: string }[];
    goal_applied: boolean;
    goal_note?: string;
  }>("/api/steer", { tasks, text, goal }, apiBase);

/** A new task, linked at birth with `pb plan --dep` so the graph shows the relation. */
export const fork = (goal: string, from?: string, check?: string, apiBase = "") =>
  post<{ ok: boolean; task: string | null }>("/api/fork", { goal, from, check }, apiBase);
