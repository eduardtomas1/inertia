// @inertia-e2e-resource isolated
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page, type TestInfo } from "@playwright/test";

import { createAppFixture, type AppFixture } from "./support/app-fixture";

const codexAppServerSource = `
if (process.argv[2] === "--help") {
  process.stdout.write("Usage: codex app-server [OPTIONS] - Run the app server\\n");
  process.exit(0);
}
const readline = require("node:readline");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: { userAgent: "provider-update-command" } });
  else if (message.method === "model/list") send({ id: message.id, result: { data: [], nextCursor: null } });
  else if (message.method === "account/rateLimits/read") send({ id: message.id, result: { rateLimits: null, rateLimitsByLimitId: null } });
});
`;

const fakeClaude = `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("0.0.1 (Claude Code)\\n");
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "status") {
  process.stdout.write(JSON.stringify({ loggedIn: false }) + "\\n");
  process.exit(1);
}
process.exit(2);
`;

const fakeBrew = `#!${process.execPath}
if (process.argv[2] === "info") {
  process.stdout.write(JSON.stringify({ formulae: [], casks: [{ version: "0.0.2" }] }));
  process.exit(0);
}
process.exit(1);
`;

let app!: AppFixture;
let page!: Page;
let brewPrefix = "";

test.beforeAll(async () => {
  app = await createAppFixture({
    name: "provider-update-command",
    initialState: "empty",
    codexAppServerSource,
    beforeLaunch: async ({ testDirectory }) => {
      brewPrefix = join(testDirectory, "brew");
      const keg = join(brewPrefix, "Caskroom", "claude-code", "0.0.1");
      await mkdir(keg, { recursive: true });
      await writeFile(join(keg, "claude"), fakeClaude, { mode: 0o755 });
      await symlink(join(keg, "claude"), join(testDirectory, "provider-bin", "claude"));
    },
  });
  page = app.page;
});

test.afterAll(async () => {
  await app.close();
});

async function capture(testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, animations: "disabled", scale: "css" });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

test("shows the Homebrew command instead of a native updater for a Homebrew Claude", async ({ browserName: _browserName }, testInfo) => {
  test.skip(process.platform === "win32", "Homebrew kegs exist only on macOS and Linux");
  await app.resizeWindow(1440, 920);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await page.getByRole("button", { name: "Configure Claude" }).click();
  const updates = page.getByRole("group", { name: "Provider updates" });
  await updates.getByRole("button", { name: "Check" }).click();
  await expect(updates.locator("code")).toHaveText("brew upgrade --cask claude-code");
  await expect(updates.getByRole("button", { name: /Update/u })).toHaveCount(0);
  await expect(updates.getByRole("button", { name: "Instructions" })).toBeVisible();
  await expect(updates).toContainText("Inertia could not find the Homebrew that owns this installation.");

  for (const theme of ["Light", "Dark"] as const) {
    await page.getByRole("button", { name: "Appearance", exact: true }).click();
    await page.getByRole("radio", { name: theme }).click();
    await page.getByRole("button", { name: "Agents", exact: true }).click();
    await page.getByRole("button", { name: "Configure Claude" }).click();
    for (const [width, height] of [[1440, 920], [760, 900]] as const) {
      await app.resizeWindow(width, height);
      await updates.scrollIntoViewIfNeeded();
      await capture(testInfo, `provider-update-command-${theme.toLowerCase()}-${width}x${height}`);
    }
  }
  await app.resizeWindow(1440, 920);
  expect(app.rendererErrors).toEqual([]);
});

test("offers Update with Homebrew once the keg's own brew is present and compares with its release", async ({ browserName: _browserName }, testInfo) => {
  test.skip(process.platform === "win32", "Homebrew kegs exist only on macOS and Linux");
  await mkdir(join(brewPrefix, "bin"), { recursive: true });
  await writeFile(join(brewPrefix, "bin", "brew"), fakeBrew, { mode: 0o755 });
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await page.getByRole("button", { name: "Configure Claude" }).click();
  const updates = page.getByRole("group", { name: "Provider updates" });
  await updates.getByRole("button", { name: "Check" }).click();
  await expect(updates).toContainText("Latest 0.0.2");
  await expect(updates.getByRole("button", { name: "Update", exact: true })).toBeVisible();
  await expect(updates.locator("code")).toHaveCount(0);

  for (const theme of ["Light", "Dark"] as const) {
    await page.getByRole("button", { name: "Appearance", exact: true }).click();
    await page.getByRole("radio", { name: theme }).click();
    await page.getByRole("button", { name: "Agents", exact: true }).click();
    await page.getByRole("button", { name: "Configure Claude" }).click();
    await app.resizeWindow(1440, 920);
    await updates.scrollIntoViewIfNeeded();
    await capture(testInfo, `provider-update-homebrew-${theme.toLowerCase()}-1440x920`);
  }
  expect(app.rendererErrors).toEqual([]);
});
