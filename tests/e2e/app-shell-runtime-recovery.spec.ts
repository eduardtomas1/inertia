// @inertia-e2e-resource isolated
import { test } from "@playwright/test";

import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { expectRuntimeCrashRecovery } from "./support/runtime-crash-safety";

// This scenario used to live in app-shell.spec.ts. Because the isolated
// project excludes @runtime-recovery tests and the recovery project selects
// them from the same files, that shared beforeAll fixture launched Electron
// once per project. Its own file keeps one launch per project.
let app!: AppFixture;

test.beforeAll(async () => {
  app = await createAppFixture({ name: "app-shell-recovery", initialState: "empty" });
});

test.afterAll(async () => {
  await app.close();
});

test("keeps the window alive and reconnects with a rotated capability after a runtime crash", {
  tag: "@runtime-recovery",
}, async () => {
  await expectRuntimeCrashRecovery(app, test.info());
});
