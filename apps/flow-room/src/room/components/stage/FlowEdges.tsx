// ─── Flow room — the edge vocabulary ───
//
// Five kinds, each with the dash pattern, colour and marker measured from
// flow.css (`.e-dep` … `.e-hil`), plus `idle` for a declared dependency that has
// not started. Solid means the engine proved the relation; a claim is dashed.
//
// Effects live here too (CSS + SVG/SMIL only, DESIGN §2.3 / D8): a travelling
// dot on spawn, fork and merge-back edges. When the user prefers reduced motion
// the dot is not rendered at all — the dash pattern, the label and the
// provenance chip still tell the whole story (frame 4).
//
// Marker geometry is the painted one: 8×8 viewBox, `M1,1.2 L6.4,4 L1,6.8`,
// refX 6.6, markerWidth 7, orient auto.

import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  getStraightPath,
  Position,
  type Edge,
  type EdgeProps,
} from "@xyflow/react";
import { flowEdgeStyle } from "@/lib/flow-derive";
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion";
import type { FlowEdgeEvidence, FlowEdgeKind } from "@/lib/flow-types";

export interface FlowEdgeData extends Record<string, unknown> {
  kind: FlowEdgeKind;
  /** Set only when the label's box fits free space — suppressed labels are gone. */
  label?: string;
  /** The measured label box (canvas space) when the label is visible. */
  labelBox?: { x: number; y: number; width: number; height: number };
  /** True when the layout had to suppress a label rather than clip it. */
  labelSuppressed?: boolean;
  proven?: boolean;
  evidence?: FlowEdgeEvidence;
}

export type FlowEdgeType = Edge<FlowEdgeData, "flow">;

/** The four arrow heads the frames use (dep · ink · teal · rose). */
export const FLOW_MARKERS = [
  { id: "flow-arrow-dep", stroke: "#c9c3bb" },
  { id: "flow-arrow-ink", stroke: "rgba(17, 17, 17, 0.35)" },
  { id: "flow-arrow-teal", stroke: "var(--accent-teal)" },
  { id: "flow-arrow-rose", stroke: "var(--accent-rose)" },
] as const;

const MARKER_URL: Record<string, string> = {
  dep: "url(#flow-arrow-dep)",
  ink: "url(#flow-arrow-ink)",
  teal: "url(#flow-arrow-teal)",
  rose: "url(#flow-arrow-rose)",
  none: "",
};

/** Travel-dot duration per edge kind, straight from the frame-4 storyboard. */
const TRAVEL_DURATION: Partial<Record<FlowEdgeKind, string>> = {
  spawn: "1.8s",
  fork: "2.2s",
  merge: "2.6s",
};

/** The marker `<defs>` block. Rendered once per room, inside the canvas. */
export function FlowEdgeMarkers() {
  return (
    <svg
      aria-hidden
      style={{ position: "absolute", width: 0, height: 0, overflow: "hidden" }}
    >
      <defs>
        {FLOW_MARKERS.map(marker => (
          <marker
            key={marker.id}
            id={marker.id}
            viewBox="0 0 8 8"
            refX={6.6}
            refY={4}
            markerWidth={7}
            markerHeight={7}
            orient="auto"
          >
            <path
              d="M1,1.2 L6.4,4 L1,6.8"
              fill="none"
              stroke={marker.stroke}
              strokeWidth={1.3}
            />
          </marker>
        ))}
      </defs>
    </svg>
  );
}

export function FlowEdge({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected,
}: EdgeProps<FlowEdgeType>) {
  const reduced = usePrefersReducedMotion();
  const kind: FlowEdgeKind = data?.kind ?? "dep";
  // Proof decides the dash: a SPAWN edge backed by an `action: spawn` row is
  // solid, one standing on a bare claim keeps the dashed `5 4` pattern.
  const style = flowEdgeStyle(kind, data?.proven);
  const claimed = data?.proven !== true && kind !== "idle" && kind !== "dep" && kind !== "done";

  // Same row → the painted straight line; anything that steps between the main
  // rows and the bottom band → the painted elbow (borderRadius 0).
  const aligned =
    Math.abs(sourceY - targetY) < 8 &&
    sourcePosition === Position.Right &&
    targetPosition === Position.Left;

  const [path] = aligned
    ? getStraightPath({ sourceX, sourceY, targetX, targetY })
    : getSmoothStepPath({
        sourceX,
        sourceY,
        targetX,
        targetY,
        sourcePosition,
        targetPosition,
        borderRadius: 0,
      });

  const stroke = style.stroke;
  const markerEnd = MARKER_URL[style.marker] || undefined;
  const travel = TRAVEL_DURATION[kind];
  const labelText = data?.label
    ? claimed
      ? `${data.label} · claimed`
      : data.label
    : undefined;

  return (
    <>
      <BaseEdge
        path={path}
        style={{
          stroke,
          strokeWidth: selected ? style.width + 0.75 : style.width,
          strokeDasharray: style.dash,
          fill: "none",
        }}
        markerEnd={markerEnd}
      />
      {/* merge-back is a DOUBLE edge: a 1 px ghost that runs beside the fact. */}
      {style.double && !aligned && (
        <BaseEdge
          path={getSmoothStepPath({
            sourceX,
            sourceY: sourceY + 4,
            targetX,
            targetY: targetY + 4,
            sourcePosition,
            targetPosition,
            borderRadius: 0,
          })[0]}
          style={{ stroke, strokeWidth: 1, opacity: 0.5, fill: "none" }}
        />
      )}
      {travel && !reduced && (
        <circle r={kind === "fork" ? 3 : 3.4} fill="var(--accent-teal)" opacity={0.85}>
          <animateMotion dur={travel} repeatCount="indefinite" path={path} />
        </circle>
      )}
      {labelText && (
        <EdgeLabelRenderer>
          <span
            className={`flow-edgepill ${labelTone(kind)}`}
            style={{
              // The box comes from the layout, so the pill drawn here is exactly
              // the rect the geometry test checked against every node card.
              left: data?.labelBox?.x ?? labelX(sourceX, targetX) - 40,
              top: data?.labelBox?.y ?? Math.min(sourceY, targetY) - 22,
              width: data?.labelBox?.width,
              transform: "none",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              boxSizing: "border-box",
            }}
            title={
              claimed
                ? `not proven — evidence: ${data?.evidence ?? "claim"}`
                : `proven — evidence: ${data?.evidence ?? kind}`
            }
          >
            {labelText}
          </span>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

/** Teal for the relations the orchestrator created, rose for the human gate. */
function labelTone(kind: FlowEdgeKind): string {
  if (kind === "hil") return "flow-edgepill--rose";
  if (kind === "spawn" || kind === "fork" || kind === "merge") {
    return "flow-edgepill--teal";
  }
  return "";
}

/** Painted labels sit in the middle of the horizontal run of the edge. */
function labelX(sourceX: number, targetX: number): number {
  return sourceX + (targetX - sourceX) / 2;
}