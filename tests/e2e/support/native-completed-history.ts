import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import { build } from "esbuild";
import { forceTerminateProcessTreeByPidAndWait } from "../../../src/server/process-lifecycle";
import { settleOperationBounded } from "./electron-app-lifecycle";

const require = createRequire(import.meta.url);

export async function checkNativeCompletedHistory(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "inertia-native-history-")));
  let child: ChildProcess | undefined;
  let exited: Promise<void> | undefined;
  let output = "";
  try {
    await build({
      entryPoints: [fileURLToPath(new URL("../../fixtures/completed-history/renderer.tsx", import.meta.url))],
      outfile: join(root, "renderer.js"), bundle: true, platform: "browser", format: "iife",
      tsconfig: "tsconfig.web.json", jsx: "automatic", conditions: ["style"],
      define: { "process.env.NODE_ENV": '"development"' },
      external: ["/inertia-logo.png"],
      loader: { ".woff": "file", ".woff2": "file", ".ttf": "file", ".svg": "file", ".png": "file" },
      plugins: [{ name: "file-url", setup(builder) {
        builder.onResolve({ filter: /\?url$/ }, (args) => ({
          path: require.resolve(args.path.slice(0, -4), { paths: [args.resolveDir] }), namespace: "file-url",
        }));
        builder.onLoad({ filter: /.*/, namespace: "file-url" }, async (args) => ({
          contents: await readFile(args.path), loader: "file",
        }));
      } }],
    });
    await build({
      entryPoints: [fileURLToPath(new URL("../../fixtures/completed-history/main.ts", import.meta.url))],
      outfile: join(root, "main.mjs"), bundle: true, platform: "node", format: "esm",
      external: ["electron"], target: "node22",
    });
    await writeFile(join(root, "index.html"),
      '<!doctype html><title>Native completed history</title><link rel="stylesheet" href="renderer.css"><div id="root"></div><script src="renderer.js"></script>');
    child = spawn(require("electron") as string, ["--no-sandbox", join(root, "main.mjs")], {
      shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, NODE_OPTIONS: undefined,
        APPIMAGE: undefined, APPDIR: undefined },
    });
    exited = new Promise<void>((resolve, reject) => {
      child!.once("error", reject);
      child!.once("close", () => resolve());
    });
    void exited.catch(() => undefined);
    for (const stream of [child.stdout, child.stderr]) {
      stream?.on("data", (chunk: Buffer) => { output = (output + chunk.toString()).slice(-65_536); });
    }
    expect((await settleOperationBounded(exited, 40_000)).status, output).toBe("fulfilled");
    expect(child.exitCode, output).toBe(0);
    expect(output).toContain('HIDDEN_HISTORY {"visibility":"hidden"');
    expect(output).toContain('SHOWN_HISTORY {"visibility":"visible"');
    return output;
  } finally {
    let stopped = !child;
    try {
      if (child && exited) {
        if (child.exitCode === null && child.signalCode === null && child.pid) {
          const completion = exited;
          stopped = await forceTerminateProcessTreeByPidAndWait(child.pid,
            async (waitMs) => (await settleOperationBounded(completion, waitMs)).status === "fulfilled",
            { waitMs: 2_000 });
        } else {
          stopped = (await settleOperationBounded(exited, 2_000)).status === "fulfilled";
        }
        expect(stopped, output).toBe(true);
      }
    } finally { if (stopped) await rm(root, { recursive: true, force: true }); }
  }
}
