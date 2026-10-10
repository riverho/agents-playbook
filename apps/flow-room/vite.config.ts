import path from "path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { WATCH_IGNORED } from "./src/watch-ignore";

// `@` points at the ROOM, not at src/. That is what lets the room's 19 files be
// copied verbatim from Wenmei: their `@/lib/...` and `@/mocks/...` specifiers keep
// resolving, and the room's tests keep reading `../index.css` and
// `../components/stage/FlowRoom.tsx` relative to `src/room/lib/`.
//
// The watch matcher lives in src/watch-ignore.ts rather than here so the test that
// pins it (src/vite-watch.test.ts) can import it without a relative path that
// escapes src/ — which the decoupling gate refuses, correctly.
const __dirname = import.meta.dirname;

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 4317,
    strictPort: true,
    // `npm run dev` is HMR only; the engine API runs beside it on 4319 via
    // `npm run api` (`server.mjs --api-only`). `npm start` is the single-process path:
    // it serves the built app AND the API, which is what an installed user runs.
    proxy: {
      "/api": { target: "http://127.0.0.1:4319", changeOrigin: false },
    },
    watch: {
      ignored: WATCH_IGNORED,
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src/room"),
    },
  },
  build: {
    outDir: path.resolve(__dirname, "dist"),
    emptyOutDir: true,
  },
});
