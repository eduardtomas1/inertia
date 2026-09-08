// @inertia-e2e-resource primary-display
import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { RuntimeStore } from "../../src/server/database";
import type { ClientCommand } from "../../src/shared/contracts";
import { createAppFixture } from "./support/app-fixture";
import { capturePageWebSockets, refreshCapturedRuntimeSnapshot } from "./support/browser-websocket-fixture";

test("reopens project filters and changes the new-chat project without leaving the draft", async ({ browserName: _browserName }, testInfo) => {
  const app = await createAppFixture({ name: "project-navigation", initialState: "conversation", seedSecondProject: true, windowDisplay: "primary" });
  try {
    await app.resizeWindow(1200, 800);
    const page = app.page;
    const commands: ClientCommand[] = [];
    page.on("websocket", (socket) => socket.on("framesent", ({ payload }) => {
      commands.push(JSON.parse(String(payload)) as ClientCommand);
    }));
    await capturePageWebSockets(page);
    await page.reload();
    const sidebar = page.getByRole("complementary", { name: "Project navigation", exact: true });
    const filter = sidebar.getByRole("button", { name: "Filter work by project" });
    const filterDialog = page.getByRole("dialog", { name: "Choose project filter" });
    for (const name of ["Companion", "Inertia", "All projects", "Companion", "All projects"]) {
      await filter.click();
      await expect(filterDialog).toBeVisible();
      await filterDialog.getByRole("option", { name, exact: true }).click();
      await expect(filterDialog).toBeHidden();
      await expect(filter).toHaveText(name);
      if (name !== "All projects") {
        await sidebar.locator(".activity-thread-select").first().click();
        await refreshCapturedRuntimeSnapshot(page);
      }
    }
    await filter.click();
    await expect(filterDialog).toBeVisible();
    await filter.click();
    await expect(filterDialog).toBeHidden();
    await filter.click();
    await sidebar.getByRole("searchbox").click();
    await expect(filterDialog).toBeHidden();
    await filter.click();
    await expect(filterDialog).toBeVisible();
    const filterScreenshot = testInfo.outputPath("project-filter.png");
    await page.screenshot({ path: filterScreenshot, animations: "disabled" });
    await testInfo.attach("project-filter", { path: filterScreenshot, contentType: "image/png" });
    await page.keyboard.press("Escape");
    await sidebar.getByRole("button", { name: "project-navigation fixture, Codex, Inertia, Idle", exact: true }).click();
    await refreshCapturedRuntimeSnapshot(page);
    await sidebar.getByRole("button", { name: "Start a new chat" }).click();
    commands.length = 0;
    const heading = page.getByRole("heading", { name: "What should we build today?" });
    await expect(heading).toBeVisible();
    const input = page.getByRole("textbox", { name: "Message", exact: true });
    await input.fill("Keep this draft while I choose a project");
    await app.electronApp.evaluate(({ dialog }, path) => {
      Reflect.set(dialog, "showOpenDialog", async () => ({ canceled: false, filePaths: [path], bookmarks: [] }));
    }, app.attachmentImagePath);
    await page.getByRole("button", { name: "Attach images, documents, or spreadsheets" }).click();
    await expect(page.getByRole("button", { name: "Remove attachment" })).toBeVisible();
    const project = page.getByRole("button", { name: "Project", exact: true });
    await project.click();
    await page.getByRole("dialog", { name: "Choose project", exact: true }).getByRole("option", { name: "Companion", exact: true }).click();
    await expect(project).toHaveText("Companion");
    await expect(heading).toBeVisible();
    await expect(input).toHaveValue("Keep this draft while I choose a project");
    await expect(page.getByRole("button", { name: "Remove attachment" })).toBeVisible();
    await refreshCapturedRuntimeSnapshot(page);
    await expect(heading).toBeVisible();
    await expect(project).toHaveText("Companion");
    expect(commands.filter(({ type }) => type === "project.select" || type === "conversation.select" || type === "conversation.create")).toEqual([]);
    await input.fill("@beta");
    await page.getByRole("listbox", { name: "Project files" }).getByRole("option", { name: "beta-only.ts file" }).click();
    await input.fill("Keep this draft while I choose a project");
    await project.click();
    await expect(page.getByRole("dialog", { name: "Choose project", exact: true })).toBeVisible();
    await expect(page.getByText("Conversation not found.", { exact: true })).toBeHidden();
    const draftScreenshot = testInfo.outputPath("draft-project-picker.png");
    await page.screenshot({ path: draftScreenshot, animations: "disabled" });
    await testInfo.attach("draft-project-picker", { path: draftScreenshot, contentType: "image/png" });
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect.poll(() => commands.find(({ type }) => type === "conversation.create")).toBeTruthy();
    const create = commands.find((command) => command.type === "conversation.create")!;
    const store = new RuntimeStore(join(app.testDirectory, "data", "inertia.sqlite"), app.workspaceDirectory, { recoverInterruptedRuns: false });
    let inertiaProjectId = "";
    try {
      const projects = store.shellSnapshot().projects;
      const target = projects.find(({ name }) => name === "Companion")!;
      inertiaProjectId = projects.find(({ name }) => name === "Inertia")!.id;
      expect(create.payload.projectId).toBe(target.id);
    } finally { store.close(); }
    await expect(heading).toBeHidden();
    await sidebar.getByRole("button", { name: "Start a new chat" }).click();
    await expect(heading).toBeVisible();
    await refreshCapturedRuntimeSnapshot(page);
    await expect(heading).toBeVisible();
    await project.click();
    await page.getByRole("dialog", { name: "Choose project", exact: true }).getByRole("option", { name: "Inertia", exact: true }).click();
    commands.length = 0;
    await page.keyboard.press("ControlOrMeta+n");
    await expect.poll(() => commands.find((command) => command.type === "conversation.create")?.payload.projectId).toBe(inertiaProjectId);
    await expect(heading).toBeHidden();
    expect(app.rendererErrors).toEqual([]);
  } finally { await app.close(); }
});
