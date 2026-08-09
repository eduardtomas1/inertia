import { resolve } from "node:path";

import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      target: "node22",
      emptyOutDir: false,
      rollupOptions: {
        input: {
          "runtime-status-cli": resolve("src/server/runtime-status-cli.ts"),
        },
      },
    },
  },
});
