import { defineConfig } from "vitest/config";
import path from "path";

const root = import.meta.dirname;

export default defineConfig({
  root,
  resolve: {
    alias: {
      "@": path.resolve(root, "src/room"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
