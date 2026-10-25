// @inertia-e2e-resource isolated
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";

import type { AppSnapshot, ServerEvent } from "../../src/shared/contracts";
import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { expectBackendSetupFinished } from "./support/backend-accounts-endpoint";
import { createLinuxSecretService, type LinuxSecretService } from "./support/linux-secret-service";

const evidenceDirectory = join(process.cwd(), "docs", "pr-evidence", "backend-accounts");
const FIXTURE_KEY = "fixture-key-not-a-real-secret";

let app!: AppFixture;
let page!: Page;
let claudeSignedIn = false;
let secretService: LinuxSecretService | undefined;

function withFixtureProviders(snapshot: AppSnapshot): AppSnapshot {
  return {
    ...snapshot,
    providers: snapshot.providers.map((provider) => {
      if (provider.id === "codex") {
        return { ...provider, available: true, installState: "installed", authState: "authenticated", canRun: true };
      }
      if (provider.id === "claude") {
        return {
          ...provider,
          available: true,
          installState: "installed",
          authState: claudeSignedIn ? "authenticated" : "unauthenticated",
          canRun: claudeSignedIn,
          statusMessage: null,
        };
      }
      return provider;
    }),
  };
}

async function capture(testInfo: TestInfo, name: string): Promise<void> {
  await page.mouse.move(0, 0);
  const path = join(evidenceDirectory, `${name}.png`);
  await page.screenshot({ animations: "disabled", path });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

async function openSettingsSection(name: "Agents" | "Appearance"): Promise<void> {
  if (!await page.getByRole("main", { name: "Settings", exact: true }).isVisible()) {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
  }
  await page.getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name, exact: true }).click();
}

async function setTheme(theme: "Light" | "Dark"): Promise<void> {
  await openSettingsSection("Appearance");
  await page.getByRole("radio", { name: theme, exact: true }).click();
}

function accounts(): Locator {
  return page.getByRole("region", { name: "Accounts and API keys" });
}

test.beforeAll(async () => {
  mkdirSync(evidenceDirectory, { recursive: true });
  secretService = await createLinuxSecretService();
  app = await createAppFixture({
    name: "backend-accounts-visual",
    initialState: "conversation",
    ...(secretService
      ? { additionalEnvironment: secretService.environment, electronMainEntry: secretService.electronMainEntry }
      : {}),
  });
  page = app.page;
  await page.routeWebSocket(/.*/u, (route) => {
    route.connectToServer().onMessage((data) => {
      const event = JSON.parse(data.toString()) as ServerEvent;
      if (event.type === "server.welcome" || event.type === "snapshot.updated") {
        event.snapshot = withFixtureProviders(event.snapshot);
      } else if (event.type === "runtime.event" && event.event.type === "snapshot.updated") {
        event.event.snapshot = withFixtureProviders(event.event.snapshot);
      }
      route.send(JSON.stringify(event));
    });
  });
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
});

test.afterAll(async () => {
  try { await app?.close(); }
  finally { await secretService?.close(); }
});

test("captures accounts, API keys and the API key route in the model chooser", async ({ browserName: _browserName }, testInfo) => {
  test.setTimeout(240_000);
  await app.resizeWindow(1440, 920);
  await setTheme("Light");
  await openSettingsSection("Agents");

  const section = accounts();
  await expect(section).toBeVisible();
  await section.getByRole("button", { name: "Add custom backend…" }).click();
  const form = section.getByRole("form", { name: "New custom backend" });
  await form.getByRole("textbox", { name: "Name", exact: true }).fill("Anthropic API key");
  await form.getByRole("textbox", { name: "Base URL" }).fill(`${app.previewUrl}backend-accounts`);
  await form.getByRole("switch", { name: "Allow localhost HTTP" }).click();
  await form.getByRole("textbox", { name: "Model 1 ID" }).fill("claude-opus-5-5");
  await form.getByRole("textbox", { name: "Model 1 display name" }).fill("Claude Opus 5.5");
  await form.getByRole("button", { name: "Add model" }).click();
  await form.getByRole("textbox", { name: "Model 2 ID" }).fill("claude-sonnet-5-5");
  await form.getByRole("textbox", { name: "Model 2 display name" }).fill("Claude Sonnet 5.5");
  const key = form.getByLabel("API key", { exact: true });
  await key.fill(FIXTURE_KEY);
  await key.press("Enter");
  await expectBackendSetupFinished(form, 90_000);

  const claude = section.getByRole("region", { name: "Claude Code" });
  const keyRow = claude.getByRole("listitem", { name: "Anthropic API key" });
  await expect(claude.getByText("Signed out", { exact: true })).toBeVisible();
  await expect(keyRow.getByText("Ready", { exact: true })).toBeVisible();
  await keyRow.getByRole("button", { name: /^Test Anthropic API key/u }).click();
  const results = keyRow.getByRole("list", { name: /^Test results for Anthropic API key/u });
  await expect(results.getByText(/^Works/u)).toHaveCount(2, { timeout: 60_000 });
  await keyRow.getByRole("button", { name: "Hide results" }).click();

  for (const theme of ["Light", "Dark"] as const) {
    const slug = theme.toLowerCase();
    await setTheme(theme);
    await openSettingsSection("Agents");
    await section.evaluate((element) => element.scrollIntoView({ block: "start" }));
    await expect(keyRow.getByText("Ready", { exact: true })).toBeVisible();
    await app.expectNoViewportOverflow();
    await capture(testInfo, `accounts-and-api-keys-${slug}`);

    const add = claude.getByRole("button", { name: "Add API key for Claude Code" });
    await add.click();
    const dialog = page.getByRole("dialog", { name: "Add Anthropic API key" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("API key", { exact: true })).toBeFocused();
    await capture(testInfo, `add-api-key-dialog-${slug}`);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(add).toBeFocused();
  }

  claudeSignedIn = true;
  await setTheme("Light");
  await openSettingsSection("Agents");
  await expect(claude.getByText(/^Signed in(?: |$)/u)).toBeVisible();

  for (const theme of ["Light", "Dark"] as const) {
    const slug = theme.toLowerCase();
    await setTheme(theme);
    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
    const trigger = page.getByRole("button", { name: /^Choose model\./u });
    await trigger.click();
    const chooser = page.getByRole("dialog", { name: "Choose model" });
    await expect(chooser).toBeVisible();
    await chooser.getByRole("combobox", { name: "Search models" }).fill("Claude");
    const rows = chooser.getByRole("grid", { name: "Model results" });
    await expect(rows.getByRole("row", { name: /^Claude Opus 5\.5 .*Anthropic API key/u })).toBeVisible();
    await expect(rows.getByRole("row", { name: /^Provider default Claude/u })).toBeVisible();
    await capture(testInfo, `model-chooser-api-key-route-${slug}`);
    await page.keyboard.press("Escape");
    await expect(chooser).toHaveCount(0);
  }

  await setTheme("Light");
  expect(app.rendererErrors).toEqual([]);
});
