// @inertia-e2e-resource isolated
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { openTerminalDock } from "./support/workspace-tools";

const name = "detached-chat-terminal-handoff";
const marker = "terminal-handoff-42";
const markerCommand = "echo terminal-handoff-$((6*7))";

let app!: AppFixture;
let heartbeatPath!: string;

test.beforeAll(async () => {
  app = await createAppFixture({ name, initialState: "conversation" });
  heartbeatPath = join(app.workspaceDirectory, "heartbeat.txt");
});

test.afterAll(async () => {
  await rm(heartbeatPath, { force: true });
  await app?.close();
});

function quotePosix(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function lastHeartbeat(): Promise<number> {
  const lines = (await readFile(heartbeatPath, "utf8").catch(() => ""))
    .trim()
    .split("\n");
  return Number(lines.at(-1) ?? "0");
}

async function expectHeartbeatAlive(): Promise<void> {
  await expect.poll(async () =>
    Math.abs(Date.now() / 1_000 - await lastHeartbeat()) <= 3,
  { timeout: 5_000 }).toBe(true);
}

async function openDetachedChat(): Promise<Page> {
  await app.page.locator(".workspace-header").getByRole("button", {
    name: `${name} fixture`,
    exact: true,
  }).click();
  const opened = app.electronApp.waitForEvent("window");
  await app.page.getByRole("menuitem", { name: "Open chat in new window" }).click();
  const popup = await opened;
  await popup.locator(".detached-chat-shell").waitFor();
  return popup;
}

test("keeps the chat's terminals alive while the chat moves between windows", async () => {
  test.skip(process.platform === "win32", "The heartbeat loop is a POSIX shell script.");
  test.setTimeout(150_000);
  const { page } = app;
  await app.resizeWindow(1440, 920);
  const mainDock = await openTerminalDock(page);
  await expect(mainDock.locator(".terminal-panel[data-terminal-state=ready]")).toHaveCount(1);
  const terminalId = await mainDock.locator(".terminal-panel[data-terminal-id]")
    .getAttribute("data-terminal-id");
  expect(terminalId).toBeTruthy();
  await mainDock.locator(".xterm").click();
  await page.keyboard.insertText(
    `${markerCommand}; while true; do date +%s >> ${quotePosix(heartbeatPath)}; sleep 1; done`,
  );
  await page.keyboard.press("Enter");
  await expect(mainDock.locator(".xterm-rows")).toContainText(marker);
  await expectHeartbeatAlive();

  const popup = await openDetachedChat();
  const popupDock = popup.locator(".terminal-dock");
  await expect(popupDock.locator(".xterm")).toBeVisible();
  await expect(popupDock.locator(".terminal-panel[data-terminal-state=ready]")).toHaveCount(1);
  await expect(popupDock.locator(".terminal-panel[data-terminal-id]"))
    .toHaveAttribute("data-terminal-id", terminalId!);
  await expect(popupDock.locator(".xterm-rows")).toContainText(marker);

  await popup.waitForTimeout(35_000);
  await expectHeartbeatAlive();
  await expect(popup.getByRole("alert")).toHaveCount(0);

  const returnToMain = popup.getByRole("button", { name: "Return chat to main window" });
  await expect(returnToMain).toBeEnabled();
  const closed = popup.waitForEvent("close");
  await returnToMain.evaluate((button: HTMLButtonElement) => {
    window.setTimeout(() => button.click(), 0);
  });
  await closed;

  const dockedDock = page.locator(".workspace-chat-column > .terminal-dock");
  await expect(dockedDock).toBeVisible();
  await expect(dockedDock.locator(".terminal-panel[data-terminal-state=ready]")).toHaveCount(1);
  await expect(dockedDock.locator(".terminal-panel[data-terminal-id]"))
    .toHaveAttribute("data-terminal-id", terminalId!);
  await expect(dockedDock.locator(".xterm-rows")).toContainText(marker);

  await page.waitForTimeout(35_000);
  await expectHeartbeatAlive();

  await dockedDock.locator(".xterm").click();
  await page.keyboard.press("Control+C");
  const stoppedAt = await lastHeartbeat();
  await page.waitForTimeout(2_500);
  expect(await lastHeartbeat()).toBeLessThanOrEqual(stoppedAt + 1);
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(app.rendererErrors).toEqual([]);
});
