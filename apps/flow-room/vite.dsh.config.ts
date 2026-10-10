import path from "path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Build config for the DSH Client plugin — NOT the standalone app.
//
// The output is CommonJS with react / react/jsx-runtime left EXTERNAL, because the Harness
// browser module table supplies React: bundling a second copy is forbidden by the UI-plugin
// rules, and it would also break hooks across the boundary. React Flow and dagre are not in
// that table, so they are inlined here.
//
// scripts/build-dsh-client.mjs wraps the result in the `window.__ModuleLoader__.load({…})`
// shell and writes dsh-plugin/client.js — the format is the one a shipped DSH client uses,
// read out of @deepseek-ai/dsh-client-ui-layout/lib/client.js.
const root = import.meta.dirname;

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(root, "src/room"),
    },
  },
  build: {
    lib: {
      entry: path.resolve(root, "src/dsh/client.ts"),
      formats: ["cjs"],
      fileName: () => "client.cjs",
    },
    outDir: path.resolve(root, ".dsh-build"),
    emptyOutDir: true,
    minify: false, // kept readable: the bundle gate inspects it, and so do reviewers
    rollupOptions: {
      external: ["react", "react/jsx-runtime", "react-dom"],
      output: { exports: "named" },
    },
  },
});
