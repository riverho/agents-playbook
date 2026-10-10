import FlowPanel from "./FlowPanel";

/**
 * The standalone host — the app `npm start` serves.
 *
 * Wenmei mounts the room inside a three-column stage plate; here the only thing that host
 * provided that the room itself needs is a full-height flex column, because the room's own
 * root is `.flow-room { position: relative; flex: 1 1 0; min-height: 0 }`
 * (src/room/index.css:84).
 *
 * Everything else — the data, the no-engine state, the snapshot guard — lives in
 * `FlowPanel`, which the DSH client plugin renders too. One implementation, two hosts.
 */
export default function App() {
  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <FlowPanel apiBase="" showFooter />
    </div>
  );
}
