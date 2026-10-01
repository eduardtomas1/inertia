// @inertia-e2e-resource isolated
import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RuntimeStore } from "../../src/server/database";
import { defaultProjectPreferences } from "../../src/shared/project-preferences";
import { createAppFixture } from "./support/app-fixture";

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
    try { return store.shellSnapshot().conversations.find((chat) => chat.projectId === projectId && chat.worktreePath !== null); }
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
    expect(readChat()?.latestTurn).toBeNull();
    const worktreePath = readChat()!.worktreePath!;
    expect(existsSync(join(app.workspaceDirectory, "first-attempt"))).toBe(false);
    await capture("worktree-setup-running");
    writeFileSync(join(worktreePath, "release-setup"), "release");
    await expect(card.getByText("Worktree setup needs attention", { exact: true })).toBeVisible();
    await expect(composer).toHaveValue(prompt);
    await card.getByRole("button", { name: "Show setup output", exact: true }).click();
    await expect(card.getByLabel("Setup output", { exact: true })).toContainText("Dependency installation failed");
    await capture("worktree-setup-recovery");
    expect(readChat()?.latestTurn).toBeNull();
    await card.getByRole("button", { name: "Retry setup", exact: true }).click();
    await expect(card.getByText("Worktree ready", { exact: true })).toBeVisible();
    await expect(card.getByLabel("Setup output", { exact: true })).toContainText("Dependencies installed");
    expect(readChat()?.worktreePath).toBe(worktreePath);
    expect(readFileSync(join(worktreePath, "first-attempt"), "utf8")).toBe("kept");
    expect(readFileSync(join(worktreePath, "setup-ready"), "utf8")).toBe("ready");
    await app.page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect.poll(() => readChat()?.latestTurn?.id).toBeTruthy();
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
