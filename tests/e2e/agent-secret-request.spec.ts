// @inertia-e2e-resource isolated
import { expect, test, type Locator, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readdir, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { RuntimeStore } from "../../src/server/database";
import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { setAppearanceInPlace } from "./support/appearance";
import { createLinuxSecretService, type LinuxSecretService } from "./support/linux-secret-service";
import {
  SECRET_DECLINED_REPLY,
  SECRET_DESCRIPTION,
  SECRET_FILE_NAME,
  SECRET_OUTPUT_TRACE_PREFIX,
  SECRET_PLAN_MESSAGE,
  SECRET_SAVED_REPLY,
  SECRET_TITLE,
  secretProviderEvents,
  secretRequestCodexAppServer,
  type SecretProviderEvent,
} from "./support/secret-request-provider-fixture";

const WIDTH = 1512;
const HEIGHT = 868;
const CAPTURE_DIRECTORY = process.env.INERTIA_CAPTURE_DIR?.trim() || null;
const CHAT_TITLE = "Tailscale test VMs";
const SECRET = "fake-token-kQ7rN2fixtureVb9mW4zPx3";
const FOOTNOTE = "Kept out of chat, in a private file this agent's commands can read for 24 hours";

let app!: AppFixture;
let secretService: LinuxSecretService | undefined;
let keyringUnavailable: string | null = null;
let restoredFile: string | null = null;
let plantedOrphan: string | null = null;

function page(): Page {
  return app.page;
}

function vaultFile(): string {
  return join(app.testDirectory, "electron-profile", "backend-credentials.vault.json");
}

async function vaultEntries(): Promise<Record<string, unknown>> {
  const raw = await readFile(vaultFile(), "utf8").catch(() => null);
  return raw ? (JSON.parse(raw) as { entries: Record<string, unknown> }).entries : {};
}

async function plantOrphanedVaultCopy(): Promise<void> {
  const raw = await readFile(vaultFile(), "utf8").catch(() => null);
  if (!raw) return;
  const vault = JSON.parse(raw) as { entries: Record<string, unknown> };
  const copy = Object.entries(vault.entries).find(([reference]) => reference.startsWith("secret:agent-secret:"));
  if (!copy) return;
  plantedOrphan = `secret:agent-secret:${randomUUID()}`;
  vault.entries[plantedOrphan] = copy[1];
  await writeFile(vaultFile(), JSON.stringify(vault), { mode: 0o600 });
}

function agentSecretsDirectory(): string {
  return join(app.testDirectory, "data", "agent-secrets");
}

async function exists(path: string): Promise<boolean> {
  return await stat(path).then(() => true, () => false);
}

async function settleFrame(target: Page): Promise<void> {
  await target.evaluate(async () => {
    await document.fonts.ready;
    const finite = document.getAnimations().filter((animation) => {
      const end = animation.effect?.getComputedTiming().endTime;
      return animation.playState === "running" && typeof end === "number" && Number.isFinite(end);
    });
    await Promise.race([
      Promise.all(finite.map((animation) => animation.finished.catch(() => undefined))),
      new Promise((resolve) => window.setTimeout(resolve, 3_000)),
    ]);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

async function capture(target: Page, name: string, clipFrom?: Locator): Promise<void> {
  if (!CAPTURE_DIRECTORY) return;
  await mkdir(CAPTURE_DIRECTORY, { recursive: true });
  await target.mouse.move(WIDTH - 4, Math.round(HEIGHT / 2));
  await settleFrame(target);
  const session = await target.context().newCDPSession(target);
  try {
    await session.send("Emulation.setDeviceMetricsOverride", {
      width: WIDTH,
      height: HEIGHT,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await settleFrame(target);
    const box = clipFrom ? await clipFrom.boundingBox() : null;
    const top = box ? Math.max(0, Math.floor(box.y - 24)) : 0;
    const { data } = await session.send("Page.captureScreenshot", {
      format: "png",
      ...(box ? { clip: { x: 0, y: top, width: WIDTH, height: HEIGHT - top, scale: 1 } } : {}),
    });
    await writeFile(join(CAPTURE_DIRECTORY, name), Buffer.from(data, "base64"));
  } finally {
    await session.send("Emulation.clearDeviceMetricsOverride").catch(() => undefined);
    await session.detach().catch(() => undefined);
  }
}

async function captureThemes(target: Page, dark: string, light: string | null, prepare: () => Promise<void>, clipFrom?: () => Locator): Promise<void> {
  await prepare();
  await capture(target, dark, clipFrom?.());
  if (!light) return;
  await setAppearanceInPlace(app, "light");
  await prepare();
  await capture(target, light, clipFrom?.());
  await setAppearanceInPlace(app, "dark");
}

async function send(target: Page, text: string): Promise<Locator> {
  const composer = target.getByRole("region", { name: "Message composer" });
  await composer.getByRole("textbox", { name: "Message", exact: true }).fill(text);
  await composer.getByRole("button", { name: "Send message" }).click();
  const turn = target.locator("[data-turn-id]").filter({ has: target.getByText(text, { exact: true }) });
  await expect(turn).toBeVisible();
  return turn;
}

function pendingCard(target: Page): Locator {
  return target.locator('.secret-request-card[data-secret-request-state="pending"]');
}

function cardIn(turn: Locator): Locator {
  return turn.locator(".secret-request-card");
}

async function centre(locator: Locator, block: ScrollLogicalPosition = "center"): Promise<void> {
  await locator.evaluate((element, position) => element.scrollIntoView({ block: position }), block);
}

async function toLatest(target: Page): Promise<void> {
  const jump = target.locator(".timeline-follow-controls").getByRole("button", { name: "Jump to latest" });
  if (await jump.isVisible()) await jump.click();
  await expect(target.locator(".timeline-jump")).toHaveCount(0);
}

async function settledChanges(target: Page, turn: Locator): Promise<void> {
  const settled = async (timeout: number): Promise<void> => {
    await expect(turn.getByRole("button", { name: "Run details" })).toBeVisible({ timeout });
    await expect(target.getByText("Capturing changes…", { exact: true })).toHaveCount(0, { timeout });
  };
  await expect(async () => {
    await settled(1_000);
    await target.waitForTimeout(1_500);
    await settled(100);
  }).toPass({ timeout: 45_000 });
}

async function toolResults(): Promise<SecretProviderEvent[]> {
  return (await secretProviderEvents(app.workspaceDirectory)).filter((event) => event.event === "tool-result");
}

async function nthToolResult(index: number): Promise<SecretProviderEvent> {
  await expect.poll(async () => (await toolResults()).length, { timeout: 30_000 }).toBeGreaterThan(index);
  return (await toolResults())[index]!;
}

async function expectPendingCard(target: Page): Promise<Locator> {
  const card = pendingCard(target);
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.getByText("Asking for a secret", { exact: true })).toBeVisible();
  await expect(card.getByRole("heading", { name: SECRET_TITLE, level: 3 })).toBeVisible();
  await expect(card.locator(".secret-request-description")).toHaveText(SECRET_DESCRIPTION);
  const input = card.getByRole("textbox", { name: SECRET_TITLE }).or(card.locator('input[name="agent-secret"]'));
  await expect(input).toHaveAttribute("type", "password");
  await expect(input).toHaveAttribute("placeholder", "Paste the secret");
  await expect(card.getByRole("button", { name: "Show secret" })).toHaveAttribute("aria-pressed", "false");
  await expect(card.getByRole("button", { name: "Save securely" })).toBeDisabled();
  await expect(card.getByRole("button", { name: "Decline" })).toBeEnabled();
  await expect(card.locator(".secret-request-footnote")).toHaveText(FOOTNOTE);
  return card;
}

async function filesContaining(root: string, needles: readonly Buffer[], skip: ReadonlySet<string>): Promise<string[]> {
  const hits: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (skip.has(path)) continue;
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const bytes = await readFile(path).catch(() => null);
        if (bytes && needles.some((needle) => bytes.includes(needle))) hits.push(path);
      }
    }
  };
  await visit(root);
  return hits;
}

function secretNeedles(): Buffer[] {
  return [
    Buffer.from(SECRET, "utf8"),
    Buffer.from(SECRET, "utf16le"),
    Buffer.from(Buffer.from(SECRET, "utf8").toString("base64"), "utf8"),
  ];
}

function secretHalves(): string[] {
  const middle = Math.floor(SECRET.length / 2);
  return [SECRET.slice(0, middle), SECRET.slice(middle)];
}

async function openAgentSecrets(target: Page): Promise<Locator> {
  await target.getByRole("button", { name: "Settings", exact: true }).click();
  await target.getByRole("button", { name: "Data", exact: true }).click();
  const group = target.locator('[data-setting-id="agent-secrets"]');
  await expect(group).toBeVisible();
  await expect(group.getByRole("heading", { name: "Agent secrets" })).toBeVisible();
  return group;
}

function cardAbove(group: Locator): Locator {
  return group.locator("xpath=preceding-sibling::*[1]");
}

async function backToWorkspace(target: Page): Promise<void> {
  await target.getByRole("button", { name: "Workspace", exact: true }).click();
  await expect(target.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  try {
    secretService = await createLinuxSecretService();
    if (!secretService) keyringUnavailable = "The Linux Secret Service only exists on Linux.";
  } catch (error) {
    keyringUnavailable = `The private Linux keyring could not start here: ${error instanceof Error ? error.message : String(error)}`;
  }
  app = await createAppFixture({
    name: "agent-secret-request",
    initialState: "conversation",
    codexAppServerSource: secretRequestCodexAppServer,
    ...(secretService
      ? { additionalEnvironment: secretService.environment, electronMainEntry: secretService.electronMainEntry }
      : {}),
    beforeLaunch: ({ testDirectory, workspaceDirectory }) => {
      const store = new RuntimeStore(join(testDirectory, "data", "inertia.sqlite"), workspaceDirectory, {
        recoverInterruptedRuns: false,
      });
      try {
        store.updateSettings({ theme: "dark", interfaceScale: "default", responseDensity: "default" });
        const conversation = store.snapshot().conversations[0];
        if (!conversation) throw new Error("The secret request conversation was not seeded.");
        store.updateConversation(conversation.id, { title: CHAT_TITLE });
      } finally {
        store.close();
      }
    },
  });
  await app.resizeWindow(WIDTH, HEIGHT);
});

async function closeSecretService(): Promise<void> {
  for (let attempt = 1; secretService; attempt += 1) {
    try {
      await secretService.close();
      return;
    } catch (error) {
      if (attempt >= 10) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

test.afterAll(async () => {
  try {
    await app?.close();
  } finally {
    await closeSecretService();
  }
});

test("asks for a secret in a private card and hands the agent only a file path", async () => {
  test.setTimeout(240_000);
  const target = page();
  await expect(target.locator("html")).toHaveAttribute("data-theme", "dark");

  const turn = await send(target, "Set up the Tailscale test VMs for this branch.");
  await expect(turn.getByText(SECRET_PLAN_MESSAGE)).toBeVisible({ timeout: 30_000 });
  const card = await expectPendingCard(target);
  await expect(cardIn(turn)).toHaveCount(1);

  const notice = target.locator("[data-secret-request-notice]");
  await expect(notice).toBeVisible();
  await expect(notice.getByText("Agent is asking for a secret", { exact: true })).toBeVisible();
  await expect(notice.getByText("Enter it in the private card, not here", { exact: true })).toBeVisible();
  await expect(notice.getByRole("button", { name: "Enter secret" })).toBeVisible();
  await expect(turn.getByText("Codex · OpenAI is waiting for input", { exact: true })).toBeVisible();

  const thread = (await secretProviderEvents(app.workspaceDirectory)).find((event) => event.event === "thread");
  expect(thread?.tools).toContain("inertia_request_secret");
  expect(await toolResults()).toEqual([]);

  await captureThemes(target, "01-card-pending.png", "08-card-pending-light.png", () => centre(card));
  await captureThemes(target, "03-composer-notice.png", "11-composer-notice-light.png",
    () => centre(card), () => notice);

  const input = card.locator('input[name="agent-secret"]');
  await input.fill(SECRET);
  await expect(card.getByRole("button", { name: "Save securely" })).toBeEnabled();
  await card.getByRole("button", { name: "Save securely" }).click();

  const saved = await nthToolResult(0);
  expect(saved.success).toBe(true);
  expect(saved.payload).toMatchObject({ status: "saved", file: expect.any(String), expiresAt: expect.any(String) });
  const file = String(saved.payload?.file);
  expect(basename(file)).toBe(SECRET_FILE_NAME);
  expect(dirname(dirname(file))).toBe(agentSecretsDirectory());
  expect(String(saved.payload?.use)).toContain(file);
  expect(JSON.stringify(saved.payload)).not.toContain(SECRET);
  expect(await readFile(file, "utf8")).toBe(SECRET);
  if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);

  const row = cardIn(turn);
  await expect(row).toHaveAttribute("data-secret-request-state", "saved");
  await expect(row.locator(".secret-request-row-copy")).toContainText(SECRET_TITLE);
  await expect(row.locator(".secret-request-row-status")).toHaveText(
    secretService ? "Saved · expires in 23h" : "Saved · expires in 23h · kept until Inertia quits",
  );
  await expect(row.getByRole("button", { name: `Revoke ${SECRET_TITLE}` })).toBeVisible();
  await expect(notice).toHaveCount(0);
  await expect(turn.getByText(SECRET_SAVED_REPLY)).toBeVisible({ timeout: 30_000 });

  await expect(turn.getByRole("status").filter({ hasText: "Completed · 1 action" })).toBeVisible({ timeout: 30_000 });
  const runDetails = turn.getByRole("button", { name: "Run details" });
  await runDetails.click();
  await expect(runDetails).toHaveAttribute("aria-expanded", "true");
  const disclosure = turn.getByRole("button", { name: /^Output: / });
  await expect(disclosure).toHaveCount(1);
  if (await disclosure.getAttribute("aria-expanded") !== "true") await disclosure.click();
  const output = turn.locator(".agent-activity-output");
  await expect(output).toBeVisible();
  await expect(output).toContainText(`${SECRET_OUTPUT_TRACE_PREFIX.slice(-9)}[redacted]`);
  await expect(output).not.toContainText(SECRET);

  const html = await target.evaluate(() => document.documentElement.outerHTML);
  expect(html).not.toContain(SECRET);
  for (const half of secretHalves()) expect(html).not.toContain(half);
  expect(html).toContain("[redacted]");

  const data = join(app.testDirectory, "data");
  for (const name of ["inertia.sqlite", "inertia.sqlite-wal"]) {
    const bytes = await readFile(join(data, name)).catch(() => Buffer.alloc(0));
    if (name === "inertia.sqlite") expect(bytes.length).toBeGreaterThan(0);
    for (const needle of secretNeedles()) expect(bytes.includes(needle), `${name} holds the secret`).toBe(false);
    for (const half of secretHalves()) expect(bytes.includes(Buffer.from(half, "utf8")), `${name} holds part of the secret`).toBe(false);
  }
  const logs = join(app.testDirectory, "electron-profile", "logs");
  expect(await exists(join(logs, "runtime"))).toBe(true);
  expect(await filesContaining(logs, secretNeedles(), new Set())).toEqual([]);
  expect(await filesContaining(app.testDirectory, secretNeedles(), new Set([agentSecretsDirectory()]))).toEqual([]);

  await settledChanges(target, turn);
  await captureThemes(target, "02-card-saved.png", "09-card-saved-light.png", async () => {
    await output.evaluate((element) => {
      for (let node: Element | null = element; node; node = node.parentElement) {
        if (node.scrollHeight > node.clientHeight + 1 && getComputedStyle(node).overflowY !== "visible") {
          node.scrollTop = node.scrollHeight;
          return;
        }
      }
    });
    await toLatest(target);
  });
});

test("lists the saved secret in Settings and revokes it there", async () => {
  test.setTimeout(180_000);
  const target = page();
  const saved = await nthToolResult(0);
  const file = String(saved.payload?.file);
  expect(await exists(file)).toBe(true);

  const group = await openAgentSecrets(target);
  const list = group.getByRole("list", { name: "Active agent secrets" });
  const entry = list.getByRole("listitem").filter({ hasText: SECRET_TITLE });
  await expect(entry).toHaveCount(1);
  await expect(entry.getByRole("button", { name: `Open chat ${CHAT_TITLE}` })).toBeVisible();
  await expect(entry).toContainText(/Saved (just now|1m ago) · expires in 23h/u);
  await expect(entry).toContainText(secretService ? "System keychain" : "Until Inertia quits");
  const copy = await group.innerText();
  expect(copy).not.toContain(SECRET);
  expect(copy).not.toContain(file);
  expect(copy).not.toContain("agent-secrets");

  await captureThemes(target, "05-settings-agent-secrets.png", "10-settings-agent-secrets-light.png", () => centre(cardAbove(group), "start"));

  await entry.getByRole("button", { name: `Revoke ${SECRET_TITLE}` }).click();
  await expect(group.getByText("No agent secrets are active.", { exact: true })).toBeVisible();
  await expect.poll(() => exists(file)).toBe(false);
  await expect.poll(() => exists(dirname(file))).toBe(false);
  await centre(cardAbove(group), "start");
  await capture(target, "06b-settings-after-revoke.png");

  await backToWorkspace(target);
  const turn = target.locator("[data-turn-id]").filter({
    has: target.getByText("Set up the Tailscale test VMs for this branch.", { exact: true }),
  });
  const row = cardIn(turn);
  await expect(row).toHaveAttribute("data-secret-request-state", "revoked");
  await expect(row.locator(".secret-request-row-status")).toHaveText("Revoked");
  await expect(row.getByRole("button", { name: /^Revoke/u })).toHaveCount(0);
  await centre(row);
  await capture(target, "06-settings-revoked.png");
});

test("tells the agent when the user declines", async () => {
  test.setTimeout(120_000);
  const target = page();
  const turn = await send(target, "Try the tailnet setup again.");
  const card = await expectPendingCard(target);
  await card.getByRole("button", { name: "Decline" }).click();

  const declined = await nthToolResult(1);
  expect(declined.success).toBe(false);
  expect(declined.payload).toMatchObject({ status: "declined" });
  expect(declined.payload?.file).toBeUndefined();
  const row = cardIn(turn);
  await expect(row).toHaveAttribute("data-secret-request-state", "declined");
  await expect(row.locator(".secret-request-row-status")).toHaveText("Declined");
  await expect(row.getByRole("button", { name: /^Revoke/u })).toHaveCount(0);
  await expect(target.locator("[data-secret-request-notice]")).toHaveCount(0);
  await expect(turn.getByText(SECRET_DECLINED_REPLY)).toBeVisible({ timeout: 30_000 });
  expect(await readdir(agentSecretsDirectory()).catch(() => [])).toEqual([]);
  await settledChanges(target, turn);
  await captureThemes(target, "04-card-declined.png", null, () => toLatest(target));
});

test("answers the request from a detached chat window", async () => {
  test.setTimeout(180_000);
  const target = page();
  await target.locator(".workspace-header").getByRole("button", { name: CHAT_TITLE, exact: true }).click();
  const opened = app.electronApp.waitForEvent("window");
  await target.getByRole("menuitem", { name: "Open chat in new window" }).click();
  const popup = await opened;
  await popup.locator(".detached-chat-shell").waitFor();
  await popup.getByRole("textbox", { name: "Message" }).waitFor();

  const turn = await send(popup, "Connect the simulator VM to the tailnet too.");
  const card = await expectPendingCard(popup);
  await expect(card).not.toHaveAttribute("data-secret-request-mode", "read-only");
  await centre(card);
  await capture(popup, "07-detached-window-card.png");

  await card.locator('input[name="agent-secret"]').fill(SECRET);
  await card.getByRole("button", { name: "Save securely" }).click();
  const saved = await nthToolResult(2);
  expect(saved.payload).toMatchObject({ status: "saved" });
  const file = String(saved.payload?.file);
  expect(await readFile(file, "utf8")).toBe(SECRET);
  const row = cardIn(turn);
  await expect(row).toHaveAttribute("data-secret-request-state", "saved");
  await expect(turn.getByText(SECRET_SAVED_REPLY)).toBeVisible({ timeout: 30_000 });
  expect(await popup.evaluate(() => document.documentElement.outerHTML)).not.toContain(SECRET);
  await settledChanges(popup, turn);
  await toLatest(popup);
  await capture(popup, "07b-detached-window-saved.png");
  restoredFile = file;
  await popup.close();
});

test("quitting removes every secret file", async () => {
  test.setTimeout(180_000);
  if (!restoredFile) throw new Error("The detached save did not leave an active secret.");
  expect(await exists(restoredFile)).toBe(true);
  let afterQuit: string[] | null = null;
  await app.restart({
    afterQuit: async () => {
      afterQuit = await readdir(agentSecretsDirectory()).catch(() => []);
      await plantOrphanedVaultCopy();
    },
  });
  expect(afterQuit).toEqual([]);
});

test("relaunching restores a keychain-backed secret at the same path", async () => {
  test.skip(keyringUnavailable !== null, keyringUnavailable ?? "");
  test.setTimeout(120_000);
  if (!restoredFile) throw new Error("No active secret was recorded before the restart.");
  const file = restoredFile;
  await expect.poll(() => exists(file), { timeout: 30_000 }).toBe(true);
  expect(await readFile(file, "utf8")).toBe(SECRET);
  expect(await readdir(agentSecretsDirectory())).toEqual([basename(dirname(file))]);
  const target = page();
  const turn = target.locator("[data-turn-id]").filter({
    has: target.getByText("Connect the simulator VM to the tailnet too.", { exact: true }),
  });
  await expect(cardIn(turn)).toHaveAttribute("data-secret-request-state", "saved");
  const group = await openAgentSecrets(target);
  await expect(group.getByRole("list", { name: "Active agent secrets" }).getByRole("listitem")).toHaveCount(1);
  await backToWorkspace(target);
  if (!plantedOrphan) throw new Error("No orphaned keychain copy was planted before the relaunch.");
  const orphan = plantedOrphan;
  await expect.poll(async () => Object.hasOwn(await vaultEntries(), orphan), { timeout: 30_000 }).toBe(false);
  expect(Object.keys(await vaultEntries()).filter((reference) => reference.startsWith("secret:agent-secret:"))).toHaveLength(1);
  expect(await readFile(file, "utf8")).toBe(SECRET);
  expect(app.rendererErrors).toEqual([]);
});
