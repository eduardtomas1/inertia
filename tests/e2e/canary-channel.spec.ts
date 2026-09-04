import { copyFile, mkdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

import { expect, test } from "@playwright/test";

import { INERTIA_VERSION } from "../../src/shared/version";
import { createAppFixture, type AppFixture } from "./support/app-fixture";

let stable!: AppFixture;
let canary!: AppFixture;

test.beforeAll(async () => {
  stable = await createAppFixture({
    name: "stable-coexistence",
    initialState: "empty",
  });
  canary = await createAppFixture({
    name: "canary-coexistence",
    initialState: "empty",
    additionalEnvironment: { INERTIA_TEST_RELEASE_CHANNEL: "canary" },
  });
});

test.afterAll(async () => {
  const stableTemporaryDirectory = join(stable.testDirectory, "t");
  const canaryTemporaryDirectory = join(canary.testDirectory, "t");
  try {
    await canary.close();
    await expect(stat(canaryTemporaryDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await stat(stableTemporaryDirectory)).isDirectory()).toBe(true);
  } finally {
    await stable.close();
  }
  await expect(stat(stableTemporaryDirectory)).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("runs stable and Canary concurrently with distinct desktop boundaries", async () => {
  const [stableIdentity, canaryIdentity] = await Promise.all([
    stable.electronApp.evaluate(({ app, BrowserWindow, session }) => ({
      name: app.getName(),
      userData: app.getPath("userData"),
      temporaryDirectory: app.getPath("temp"),
      renderer: BrowserWindow.getAllWindows()[0]?.webContents.getURL(),
      title: BrowserWindow.getAllWindows()[0]?.getTitle(),
      canaryPartition: BrowserWindow.getAllWindows()[0]?.webContents.session
        === session.fromPartition("persist:inertia-canary"),
    })),
    canary.electronApp.evaluate(({ app, BrowserWindow, session }) => ({
      name: app.getName(),
      userData: app.getPath("userData"),
      temporaryDirectory: app.getPath("temp"),
      renderer: BrowserWindow.getAllWindows()[0]?.webContents.getURL(),
      title: BrowserWindow.getAllWindows()[0]?.getTitle(),
      canaryPartition: BrowserWindow.getAllWindows()[0]?.webContents.session
        === session.fromPartition("persist:inertia-canary"),
    })),
  ]);
  expect(stableIdentity).toMatchObject({
    name: "inertia",
    title: "Inertia",
    canaryPartition: false,
  });
  expect(canaryIdentity).toMatchObject({
    name: "Inertia Canary",
    title: "Inertia Canary",
    canaryPartition: true,
  });
  expect(stableIdentity.renderer).toMatch(/^inertia:\/\/bundle\//u);
  expect(canaryIdentity.renderer).toMatch(/^inertia-canary:\/\/bundle\//u);
  expect(canaryIdentity.userData).not.toBe(stableIdentity.userData);
  expect(await realpath(stableIdentity.temporaryDirectory)).toBe(
    await realpath(join(stable.testDirectory, "t")),
  );
  expect(await realpath(canaryIdentity.temporaryDirectory)).toBe(
    await realpath(join(canary.testDirectory, "t")),
  );
  expect(canaryIdentity.temporaryDirectory).not.toBe(
    stableIdentity.temporaryDirectory,
  );
  await expect(stable.page.getByRole("button", { name: "Add your first project" }))
    .toBeVisible();
  await expect(canary.page.getByRole("button", { name: "Add your first project" }))
    .toBeVisible();
});

test("renders the Canary channel, status, isolation, and rollback surface", async ({ browserName: _browserName }, testInfo) => {
  await canary.resizeWindow(1280, 860);
  await canary.page.getByRole("button", { name: "Settings", exact: true }).click();
  const updates = canary.page.getByRole("region", { name: "Application updates" });
  await expect(updates.getByText(`Inertia Canary · v${INERTIA_VERSION}`, { exact: true }))
    .toBeVisible();
  await expect(updates.getByText("Canary channel · isolated profile", { exact: true }))
    .toBeVisible();
  await expect(updates.getByText("No last-known-good Canary package is retained yet.", {
    exact: true,
  })).toBeVisible();
  await expect(updates.getByRole("button", { name: "Prepare rollback" })).toBeVisible();
  await expect(updates.getByText(/Stable Inertia data is never imported or modified\./u))
    .toBeVisible();

  const evidence = testInfo.outputPath("inertia-canary-channel-status-rollback.png");
  await updates.screenshot({ path: evidence, animations: "disabled" });
  await testInfo.attach("inertia-canary-channel-status-rollback", {
    path: evidence,
    contentType: "image/png",
  });
  const requestedPath = process.env.INERTIA_CANARY_SCREENSHOT_PATH;
  if (requestedPath) {
    if (!isAbsolute(requestedPath)) {
      throw new Error("INERTIA_CANARY_SCREENSHOT_PATH must be absolute.");
    }
    await mkdir(dirname(requestedPath), { recursive: true });
    await copyFile(evidence, requestedPath);
  }
  expect(canary.rendererErrors).toEqual([]);
});

test("reopens Canary on macOS without registering its persistent protocol twice", async () => {
  test.skip(process.platform !== "darwin", "macOS keeps running after the last window closes");
  const reopenedWindow = canary.electronApp.waitForEvent("window");
  await canary.electronApp.evaluate(async ({ app, BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) throw new Error("The Canary window is unavailable.");
    await new Promise<void>((resolve) => {
      window.once("closed", resolve);
      window.destroy();
    });
    app.emit("activate");
  });
  const reopened = await reopenedWindow;
  const rendererErrors: string[] = [];
  reopened.on("console", (message) => {
    if (message.type() === "error") rendererErrors.push(message.text());
  });
  reopened.on("pageerror", (error) => rendererErrors.push(error.message));
  await reopened.locator('.app-shell[data-connection-status="online"]').waitFor();
  await expect(reopened.getByRole("button", { name: "Add your first project" }))
    .toBeVisible();
  expect(reopened.url()).toMatch(/^inertia-canary:\/\/bundle\//u);
  expect(rendererErrors).toEqual([]);
});
