import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "vite";
import { closeElectronAppBounded, settleOperationBounded } from "./support/electron-app-lifecycle";

import type { RecoveryFixture } from "./support/runtime-live-recovery-main";

let directory = "";
test.beforeAll(async () => {
  if (process.platform !== "darwin") return;
  directory = await mkdtemp(join(tmpdir(), "inertia-live-recovery-native-"));
  // Compile the actual production recovery function with an isolated main
  // fixture; no test hook or renderer bridge is added to the application.
  await build({
    configFile: false, logLevel: "error",
    build: {
      target: "node22", minify: false, outDir: join(directory, "bundle"),
      lib: {
        entry: resolve("tests/e2e/support/runtime-live-recovery-main.ts"),
        formats: ["cjs"], fileName: () => "main.cjs",
      },
      rollupOptions: { external: (id) => id === "electron" || isBuiltin(id) },
    },
  });
});
test.afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

async function snapshot(app: ElectronApplication) {
  return await app.evaluate(() => (
    Reflect.get(globalThis, "recoveryTest") as RecoveryFixture
  ).snapshot());
}

for (const { mode, decision, title, cancelId } of [
  { mode: "candidate", decision: "cancel", title: "Recover unproven macOS runtime state?", cancelId: 1 },
  { mode: "candidate", decision: "closeParent", title: "Recover unproven macOS runtime state?", cancelId: 1 },
  { mode: "malformed", decision: "cancel", title: "Runtime recovery remains safety locked", cancelId: 0 },
] as const) {
  test(`keeps live macOS ${mode} recovery responsive and locked on ${decision}`, async () => {
    test.skip(process.platform !== "darwin", "Native macOS recovery sheets");
    const app = await electron.launch({
      timeout: 30_000,
      args: [
        join(directory, "bundle", "main.cjs"),
        `--user-data-dir=${join(directory, mode, decision, "profile")}`,
        join(directory, mode, decision, "data"),
        resolve("resources/generated/runtime-process-guardian/runtime-process-guardian"),
        mode,
      ],
    });
    try {
      await app.firstWindow();
      await app.evaluate(() => (Reflect.get(globalThis, "recoveryTest") as RecoveryFixture).start());
      await expect.poll(async () => {
        // A synchronous native alert cannot be cancelled by a main-thread
        // timer. Bound the external probe so that failure still reaches cleanup.
        const probe = await settleOperationBounded(snapshot(app), 1_000);
        expect(probe.status).toBe("fulfilled");
        return probe.status === "fulfilled" && probe.value.pending && probe.value.ticks >= 2;
      }).toBe(true);
      expect(await snapshot(app)).toMatchObject({
        parented: true, pending: true, completed: false,
        authorized: false, claims: 1, authority: false,
        title, cancelId,
      });
      await app.evaluate((_electron, method) => (
        Reflect.get(globalThis, "recoveryTest") as RecoveryFixture
      )[method](), decision);
      await expect.poll(async () => (await snapshot(app)).completed).toBe(true);
      expect(await snapshot(app)).toMatchObject({
        authorized: false, claims: 1, authority: false,
      });
    } finally {
      await settleOperationBounded(app.evaluate(() => (
        Reflect.get(globalThis, "recoveryTest") as RecoveryFixture
      ).cancel()), 1_000);
      await closeElectronAppBounded(app);
    }
  });
}
