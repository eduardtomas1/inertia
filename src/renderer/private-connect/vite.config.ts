import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: resolve("src/renderer/private-connect"),
  plugins: [react()],
  resolve: { alias: { "@shared": resolve("src/shared") } },
  build: {
    outDir: resolve("out/private-connect"),
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    rollupOptions: { input: resolve("src/renderer/private-connect/index.html") },
  },
});
