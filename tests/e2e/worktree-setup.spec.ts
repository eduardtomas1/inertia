// @inertia-e2e-resource isolated
import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RuntimeStore } from "../../src/server/database";
import { defaultProjectPreferences } from "../../src/shared/project-preferences";
import { createAppFixture } from "./support/app-fixture";
import { setAppearanceInPlace } from "./support/appearance";
import { expectComposerEndsAtDock } from "./support/layout-assertions";

// The real executable waits on a file so screenshots never depend on a timed sleep.
test("prepares a new worktree before the first prompt and preserves a failed draft for retry", async ({ browserName: _browserName }, info) => {
  let projectId = "";
  const actionId = randomUUID();
  const app = await createAppFixture({ name: "worktree-setup", initialState: "conversation", initialNewThreadMode: "worktree",
    beforeLaunch: ({ testDirectory, workspaceDirectory }) => {
      writeFileSync(join(workspaceDirectory, "setup-worktree.cjs"), 'const fs=require("fs"); console.log("Preparing isolated checkout…"); const timer=setInterval(()=>{if(!fs.existsSync("release-setup"))return;clearInterval(timer);if(!fs.existsSync("first-attempt")){fs.writeFileSync("first-attempt","kept");console.error("Dependency installation failed. Retry after fixing the registry connection.");process.exit(1)}fs.writeFileSync("setup-ready","ready");console.log("Dependencies installed. Worktree ready.")},100)');
      execFileSync("git", ["-C", workspaceDirectory, "add", "setup-worktree.cjs"]);
      execFileSync("git", ["-C", workspaceDirectory, "-c", "user.name=Inertia Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Add setup fixture"]);
      const store = new RuntimeStore(join(testDirectory, "data", "inertia.sqlite"), workspaceDirectory);
      try {
        const project = store.shellSnapshot().projects.find(({ path }) => path === workspaceDirectory)!;
        projectId = project.id;
        store.updateProject(project.id, { name: "Setup studio", preferences: { ...defaultProjectPreferences(), workspace: "worktree", worktreeSetupActionId: actionId,
          // Provider discovery in this fixture searches only its fake binary directory.
          actions: [{ id: actionId, name: "Install dependencies", executable: process.execPath, args: ["setup-worktree.cjs"] }],
        } });
        store.selectProject(project.id);
        store.updateSettings({ theme: "dark", newThreadMode: "worktree" });
      } finally { store.close(); }
    },
  });
  const readChat = () => {
    const store = new RuntimeStore(join(app.testDirectory, "data", "inertia.sqlite"), app.workspaceDirectory, { recoverInterruptedRuns: false });
    try {
      const chat = store.shellSnapshot().conversations.find((chat) => chat.projectId === projectId && chat.worktreePath !== null);
      return chat ? { ...chat, messages: store.conversationDetail(chat.id)!.messages } : undefined;
    }
    finally { store.close(); }
  };
  const capture = async (name: string) => {
    const path = info.outputPath(`${name}.png`);
    await app.page.screenshot({ path, animations: "disabled" });
    await info.attach(name, { path, contentType: "image/png" });
    await app.expectNoViewportOverflow();
  };
  try {
    await app.resizeWindow(1400, 940);
    await app.page.getByRole("button", { name: "New chat", exact: true }).click();
    const card = app.page.getByRole("region", { name: "Worktree setup", exact: true });
    // New chat creates its checkout asynchronously; do not send into the
    // previous chat while that navigation is still being applied.
    await expect(card.getByText("Setting up worktree", { exact: true })).toBeVisible();
    const composer = app.page.getByRole("textbox", { name: "Message", exact: true });
    const prompt = "Review this isolated checkout once dependencies are ready.";
    await composer.fill(prompt);
    await app.page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect.poll(() => readChat()?.worktreeSetup?.status).toBe("running");
    await expect(card.getByText("Setting up worktree", { exact: true })).toBeVisible();
    expect(readChat()?.messages).toEqual([]);
    const worktreePath = readChat()!.worktreePath!;
    expect(existsSync(join(app.workspaceDirectory, "first-attempt"))).toBe(false);
    await capture("worktree-setup-running");
    writeFileSync(join(worktreePath, "release-setup"), "release");
    await expect(card.getByText("Worktree setup needs attention", { exact: true })).toBeVisible();
    await expect(composer).toHaveValue(prompt);
    await card.getByRole("button", { name: "Output", exact: true }).click();
    await expect(card.getByLabel("Setup output", { exact: true })).toContainText("Dependency installation failed");
    await capture("worktree-setup-recovery");
    expect(readChat()?.messages).toEqual([]);
    await card.getByRole("button", { name: "Retry setup", exact: true }).click();
    await expect(card.getByText("Worktree ready", { exact: true })).toBeVisible();
    await expect(card.getByLabel("Setup output", { exact: true })).toContainText("Dependencies installed");
    expect(readChat()?.worktreePath).toBe(worktreePath);
    expect(readFileSync(join(worktreePath, "first-attempt"), "utf8")).toBe("kept");
    expect(readFileSync(join(worktreePath, "setup-ready"), "utf8")).toBe("ready");
    await app.page.getByRole("button", { name: "Send message", exact: true }).click();
    // This fixture disables providers, so accepted prompts are transcript-only
    // messages. Verify persistence exactly once, without assuming a provider turn.
    await expect.poll(() => readChat()?.messages.map(({ role, content }) => ({ role, content })))
      .toEqual([{ role: "user", content: prompt }]);
    await capture("worktree-setup-ready");
    await app.page.getByRole("button", { name: "Settings", exact: true }).click();
    await app.page.getByRole("button", { name: "Projects", exact: true }).click();
    await app.page.getByRole("button", { name: "Choose project", exact: true }).click();
    await app.page.getByRole("combobox", { name: "Search projects" }).fill("Setup studio");
    await app.page.getByRole("combobox", { name: "Search projects" }).press("Enter");
    const setupSelector = app.page.getByRole("combobox", { name: "Worktree setup action", exact: true });
    await expect(setupSelector).toHaveValue(actionId);
    await setupSelector.scrollIntoViewIfNeeded();
    await capture("worktree-setup-settings");
    expect(app.rendererErrors).toEqual([]);
  } catch (error) {
    const chat = readChat();
    const store = new RuntimeStore(join(app.testDirectory, "data", "inertia.sqlite"), app.workspaceDirectory, { recoverInterruptedRuns: false });
    let output = "";
    try { output = chat ? store.worktreeSetups.read(chat.id)?.output ?? "" : ""; }
    finally { store.close(); }
    const diagnostics = JSON.stringify({ setup: chat?.worktreeSetup, output, rendererErrors: app.rendererErrors,
      screen: await app.page.locator("body").innerText().catch(() => "Window unavailable"),
    }, null, 2);
    console.error(`Worktree setup diagnostics: ${diagnostics}`);
    writeFileSync(info.outputPath("worktree-setup-diagnostics.json"), diagnostics);
    await app.page.screenshot({ path: info.outputPath("worktree-setup-error.png") }).catch(() => undefined);
    throw error;
  } finally { await app.close(); }
});

const captureScript = [
  "const fs = require(\"fs\");",
  "console.log(\"Preparing isolated checkout…\");",
  "const timer = setInterval(() => {",
  "  if (!fs.existsSync(\"release-setup\")) return;",
  "  clearInterval(timer);",
  "  const outcome = fs.readFileSync(\"release-setup\", \"utf8\");",
  "  fs.rmSync(\"release-setup\");",
  "  if (outcome === \"fail\") {",
  "    for (let line = 1; line <= 200; line += 1) console.log(`npm http fetch GET 200 https://registry.example.invalid/package-${line} ${line * 3}ms`);",
  "    console.error(\"npm error code ECONNRESET\");",
  "    console.error(\"Dependency installation failed. Retry after fixing the registry connection.\");",
  "    process.exit(1);",
  "  }",
  "  console.log(\"Dependencies installed. Worktree ready.\");",
  "}, 100);",
].join("\n");

test("captures every setup state in light, dark and narrow windows", async ({ browserName: _browserName }, info) => {
  test.setTimeout(240_000);
  const actionId = randomUUID();
  const app = await createAppFixture({ name: "worktree-setup-states", initialState: "conversation", initialNewThreadMode: "worktree",
    beforeLaunch: ({ testDirectory, workspaceDirectory }) => {
      writeFileSync(join(workspaceDirectory, "setup-worktree.cjs"), captureScript);
      execFileSync("git", ["-C", workspaceDirectory, "add", "setup-worktree.cjs"]);
      execFileSync("git", ["-C", workspaceDirectory, "-c", "user.name=Inertia Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Add setup fixture"]);
      const store = new RuntimeStore(join(testDirectory, "data", "inertia.sqlite"), workspaceDirectory);
      try {
        const project = store.shellSnapshot().projects.find(({ path }) => path === workspaceDirectory)!;
        store.updateProject(project.id, { name: "Setup studio", preferences: { ...defaultProjectPreferences(), workspace: "worktree", worktreeSetupActionId: actionId,
          actions: [{ id: actionId, name: "Install dependencies", executable: process.execPath, args: ["setup-worktree.cjs"] }],
        } });
        store.selectProject(project.id);
        store.updateSettings({ theme: "dark", newThreadMode: "worktree" });
      } finally { store.close(); }
    },
  });
  const page = app.page;
  const card = page.getByRole("region", { name: "Worktree setup", exact: true });
  const composer = page.getByRole("region", { name: "Message composer" });
  const settingRow = page.getByRole("heading", { name: "Run when creating a worktree", exact: true });
  const latestWorktree = (): string => {
    const store = new RuntimeStore(join(app.testDirectory, "data", "inertia.sqlite"), app.workspaceDirectory, { recoverInterruptedRuns: false });
    try {
      const chats = store.shellSnapshot().conversations.filter((chat) => chat.worktreePath !== null);
      return chats.sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]!.worktreePath!;
    } finally { store.close(); }
  };
  const capture = async (name: string): Promise<void> => {
    const path = info.outputPath(`${name}.png`);
    await page.mouse.move(0, 0);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.screenshot({ path, animations: "disabled" });
    await info.attach(name, { path, contentType: "image/png" });
  };
  const expectCardHolds = async (): Promise<void> => {
    await app.expectNoViewportOverflow();
    await expectComposerEndsAtDock(composer);
    const layout = await card.evaluate((element) => ({
      overflow: element.scrollWidth - element.clientWidth,
      nested: [...element.querySelectorAll("button")].filter((button) => button.parentElement?.closest("button")).length,
      truncated: [...element.querySelectorAll<HTMLElement>("strong, p")].filter((text) => text.scrollWidth > text.clientWidth + 1).length,
    }));
    expect(layout).toEqual({ overflow: 0, nested: 0, truncated: 0 });
  };
  const captureSizes = async (state: string): Promise<void> => {
    await app.resizeWindow(1440, 920);
    await setAppearanceInPlace(app, "dark");
    await expectCardHolds();
    await capture(`worktree-setup-${state}-dark-wide`);
    await setAppearanceInPlace(app, "light");
    await capture(`worktree-setup-${state}-light-wide`);
    await app.resizeWindow(1000, 800);
    await expectCardHolds();
    await capture(`worktree-setup-${state}-light-narrow`);
    await setAppearanceInPlace(app, "dark");
    await capture(`worktree-setup-${state}-dark-narrow`);
    await app.resizeWindow(760, 600);
    await expectCardHolds();
    await capture(`worktree-setup-${state}-dark-760x600`);
    await app.resizeWindow(1440, 920);
  };
  const captureSettings = async (name: string): Promise<void> => {
    await settingRow.evaluate((heading) => heading.closest("section")?.scrollIntoView({ block: "center" }));
    await app.expectNoViewportOverflow();
    await capture(name);
  };
  try {
    await page.clock.setFixedTime(new Date("2026-09-30T09:30:00.000Z"));
    await app.resizeWindow(1440, 920);
    await page.getByRole("button", { name: "New chat", exact: true }).click();
    await expect(card.getByText("Setting up worktree", { exact: true })).toBeVisible();
    const message = page.getByRole("textbox", { name: "Message", exact: true });
    await message.fill("Review this isolated checkout once dependencies are ready.");
    await message.blur();
    await captureSizes("running");

    await card.getByRole("button", { name: "Stop setup", exact: true }).click();
    await expect(card.getByText("Setup stopped. Retry or continue without setup. Your checkout has been kept.", { exact: true })).toBeVisible();
    await expect(card.getByRole("button", { name: "Retry setup", exact: true })).toBeFocused();
    await capture("worktree-setup-stopped-dark-wide");

    await page.keyboard.press("Enter");
    await expect(card.getByText("Setting up worktree", { exact: true })).toBeVisible();
    await expect(card.getByRole("button", { name: "Stop setup", exact: true })).toBeFocused();
    writeFileSync(join(latestWorktree(), "release-setup"), "fail");
    await expect(card.getByText("Worktree setup needs attention", { exact: true })).toBeVisible();
    await expect(card.getByRole("button", { name: "Retry setup", exact: true })).toBeFocused();
    const toggle = card.getByRole("button", { name: "Output", exact: true });
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const output = card.getByLabel("Setup output", { exact: true });
    await expect(output).toContainText("Dependency installation failed");
    expect(await output.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(1);
    await captureSizes("failed");

    await card.getByRole("button", { name: "Continue without setup", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(card.getByText("Setup skipped", { exact: true })).toBeVisible();
    await expect(toggle).toBeFocused();
    await capture("worktree-setup-skipped-dark-wide");
    await setAppearanceInPlace(app, "light");
    await capture("worktree-setup-skipped-light-wide");
    await setAppearanceInPlace(app, "dark");

    await page.locator("button.icon-button[aria-label='New chat']").click();
    await expect(card.getByText("Setting up worktree", { exact: true })).toBeVisible();
    writeFileSync(join(latestWorktree(), "release-setup"), "ok");
    await expect(card.getByText("Worktree ready", { exact: true })).toBeVisible();
    await capture("worktree-setup-ready-dark-wide");
    await setAppearanceInPlace(app, "light");
    await capture("worktree-setup-ready-light-wide");
    await setAppearanceInPlace(app, "dark");

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Projects", exact: true }).click();
    await page.getByRole("button", { name: "Choose project", exact: true }).click();
    await page.getByRole("combobox", { name: "Search projects" }).fill("Setup studio");
    await page.getByRole("combobox", { name: "Search projects" }).press("Enter");
    await expect(page.getByRole("combobox", { name: "Worktree setup action", exact: true })).toHaveValue(actionId);
    await captureSettings("worktree-setup-settings-dark-wide");
    await setAppearanceInPlace(app, "light");
    await captureSettings("worktree-setup-settings-light-wide");
    await app.resizeWindow(1000, 800);
    await captureSettings("worktree-setup-settings-light-narrow");
    await setAppearanceInPlace(app, "dark");
    await captureSettings("worktree-setup-settings-dark-narrow");
    await app.resizeWindow(760, 600);
    await captureSettings("worktree-setup-settings-dark-760x600");
    expect(app.rendererErrors).toEqual([]);
  } catch (error) {
    await page.screenshot({ path: info.outputPath("worktree-setup-states-error.png") }).catch(() => undefined);
    throw error;
  } finally { await app.close(); }
});
