import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";

import { launchRemoteBrowser } from "./support/remote-browser-electron-fixture";

test("cleans a launched app and profile when readiness fails", async () => {
  const profilePrefix = `inertia-remote-cleanup-${randomUUID()}-`;
  const observed: { page: Page | null } = { page: null };

  await expect(launchRemoteBrowser({
    staticUrl: "data:text/html,<title>cleanup fixture</title>",
    profilePrefix,
    ready: async (launchedPage) => {
      observed.page = launchedPage;
      throw new Error("Injected readiness failure");
    },
  })).rejects.toThrow("Injected readiness failure");

  expect(observed.page?.isClosed()).toBe(true);
  expect((await readdir(tmpdir())).some((entry) =>
    entry.startsWith(profilePrefix))).toBe(false);
});
