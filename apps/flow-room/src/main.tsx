import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// Base stylesheet FIRST, then the room's — the room overrides React Flow's
// defaults, so the order is load-bearing. Wenmei's built bundle carries the same
// base rules (--xy-* variables, .react-flow__handle, .react-flow__edge-path), so
// importing it is parity, not a new dependency.
import "@xyflow/react/dist/style.css";
import "./room/index.css";
import App from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
