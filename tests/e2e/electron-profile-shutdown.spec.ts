// @inertia-e2e-resource isolated
import { expect, test } from "@playwright/test";
import { createAppFixture } from "./support/app-fixture";

test("keeps shutdown-blocking Chromium profile databases out of a fresh profile", async () => {
  const app = await createAppFixture({ name: "profile-shutdown-stores", initialState: "empty" });
  const child = app.electronApp.process();
  let closeRequested = false;
  try {
    const profile = await app.electronApp.evaluate(({ app: application }) => {
      const { existsSync } = process.getBuiltinModule("node:fs");
      const { join } = process.getBuiltinModule("node:path");
      const directory = application.getPath("userData");
      return {
        disabledFeatures: application.commandLine.getSwitchValue("disable-features").split(","),
        storageOpened: existsSync(join(directory, "Local Storage")),
        stores: ["DIPS", "DIPS-wal", "declarative_performance_observer.db"]
          .filter((name) => existsSync(join(directory, name))),
      };
    });
    expect(profile.storageOpened).toBe(true);
    expect(profile.stores).toEqual([]);
    expect(profile.disabledFeatures).toEqual(
      expect.arrayContaining(["DIPS", "DeclarativePerformanceObserver"]),
    );
    closeRequested = true;
    await app.close();
    expect(child.exitCode).toBe(0);
    expect(child.signalCode).toBeNull();
  } finally {
    if (!closeRequested) await app.close();
  }
});
