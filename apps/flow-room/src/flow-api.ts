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
    sendMessage: async (task, text, intent) => {
      try {
        const r = await comment(task, text, apiBase, intent);
        return { ok: r.ok, note: `Saved to the project journal${r.seq !== null ? ` (row ${r.seq})` : ""} as a ${intent === "steer" ? "change of direction" : intent}.` };
      } catch (err) {
        return { ok: false, note: err instanceof Error ? err.message : String(err) };
      }
    },
    createTask: async ({ goal, from, layer }) => {
      try {
        const r = await fork(goal, from, undefined, apiBase, layer);
        return { ok: r.ok, task: r.task, note: r.task ? `created ${r.task} — refresh to see it in its band` : "created" };
      } catch (err) {
        return { ok: false, note: err instanceof Error ? err.message : String(err) };
      }
    },
    forkTask: async (task) => {
      try {
        const r = await workerCreate(task, apiBase);
        return { ok: r.ok, note: r.output.split(String.fromCharCode(10)).map((l) => l.trim()).filter(Boolean).slice(-2).join(" · ") || `forked ${task}` };
      } catch (err) {
        return { ok: false, note: err instanceof Error ? err.message : String(err) };
      }
    },
    applySteering: async (selection: FlowNode[], prompt: string, mode: FlowSteeringMode = "steer") => {
      const tasks = selection.map((node) => node.id);
      const wrote = steeringPlan(selection);

      if (mode === "attach") {
        // The prompt box holds the document's path, playbook-root-relative — that is what
        // `pb attach --task <id> --path <path>` takes, and the engine refuses a path that is
        // absolute or missing. One card per selection, as with a comment (plan-20261010-021).
        const path = prompt.trim();
        if (!path) {
          return {
            rows: [],
            wrote,
            persisted: false,
            note: "attach needs a document path in the prompt box, relative to the playbook root",
          };
        }
        try {
          const results = await Promise.all(tasks.map((task) => attach(task, path, undefined, apiBase)));
          const failed = results.filter((r) => !r.ok);
          return {
            rows: results.map((r) => ({ task: r.task, action: "attach" as const, text: `docs: + ${path}` })),
            wrote,
            applied: results.some((r) => r.ok),
            persisted: failed.length === 0 && results.length > 0 && results.length === tasks.length,
            note:
              failed.length > 0
                ? `pb attach refused ${failed.length} of ${tasks.length} card(s)`
                : `attached ${path} to ${results.length} card(s)`,
          };
        } catch (err) {
          return { rows: [], wrote, persisted: false, note: err instanceof Error ? err.message : String(err) };
        }
      }

      try {
        const res = await steer(tasks, prompt, mode === "steer" ? prompt : undefined, apiBase);
        const ok = res.rows.filter((row) => row.ok);
        const failed = res.rows.filter((row) => !row.ok);
        // The SERVER says whether a goal was requested. Deriving it from the mode invented a
        // refusal for a whitespace goal: nothing was asked, and the room reported that the engine
        // refused the edit. A steer has two halves, and they can land independently.
        const goalRequested = res.goal_requested === true;
        const goalOk = !goalRequested || res.goal_applied === true;
        const cards = tasks.length === 1 ? "1 card" : `${tasks.length} cards`;
        const goalDiff =
          goalRequested && res.goal_applied === true
            ? {
                old: res.goal?.from ? `Stop: ${res.goal.from}` : "Stop: (not recorded in the brief's front matter)",
                new: `Stop: ${res.goal?.to ?? prompt}`,
                when: `applied just now · from steering on ${cards}`,
                from: `pb comment on ${cards} + 1 cycle-brief edit`,
              }
            : undefined;
        const note =
          failed.length > 0
            ? `pb refused ${failed.length} of ${tasks.length}: ${failed
                .map((row) => `${row.task} — ${row.detail ?? "refused"}`)
                .join("; ")}`
            : !goalOk
              ? `the journal rows were written but the GOAL half was not applied: ${res.goal_note ?? "the engine refused the edit"}`
              : goalRequested
                ? "written: the journal rows and the open brief's stop condition"
                : res.goal_note;
        return {
          rows: ok.map((row) => ({ task: row.task, action: "comment" as const, text: prompt })),
          goal_diff: goalDiff,
          wrote,
          // `persisted` = everything that was asked for landed; `applied` = something did. Folding
          // the goal half into `persisted` made a partial steer render as "nothing written yet"
          // while the journal rows were already on disk.
          applied: ok.length > 0 || (goalRequested && res.goal_applied === true),
          persisted: failed.length === 0 && ok.length === tasks.length && goalOk,
          note,
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
export const comment = (task: string, text: string, apiBase = "", intent: "comment" | "steer" | "question" = "comment") =>
  post<{ ok: boolean; task: string; wrote: string; seq: number | null }>("/api/comment", { task, text, intent }, apiBase);

/** Comment on every selected card; the goal half is reported, never faked. */
export const steer = (tasks: string[], text: string, goal?: string, apiBase = "") =>
  post<{
    ok: boolean;
    rows: { task: string; ok: boolean; detail?: string }[];
    goal_requested: boolean;
    goal_applied: boolean;
    goal_note?: string;
    /** The brief's stop condition before and after, when the goal half was applied. */
    goal?: { from: string; to: string };
  }>("/api/steer", { tasks, text, goal }, apiBase);

/** A new task, linked at birth with `pb plan --dep` so the graph shows the relation. */
export const fork = (goal: string, from?: string, check?: string, apiBase = "", layer?: string) =>
  post<{ ok: boolean; task: string | null }>("/api/fork", { goal, from, check, layer }, apiBase);

/** A worker slot for a card: `pb worker create <task> --execute` (D22 fork). */
export const workerCreate = (task: string, apiBase = "") =>
  post<{ ok: boolean; task: string; output: string }>("/api/worker", { task }, apiBase);

/**
 * Attach a document to one card: `pb attach --task <id> --path <root-relative file>`.
 * The path must be playbook-root-relative and must exist — the engine refuses otherwise, and the
 * room must pass that refusal through rather than soften it into a write.
 */
export const attach = (task: string, path: string, label?: string, apiBase = "") =>
  post<{ ok: boolean; task: string; path: string; count: number | null; wrote: string }>(
    "/api/attach",
    { task, path, label },
    apiBase
  );
