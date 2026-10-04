// @inertia-e2e-resource isolated
import { expect, test } from "@playwright/test";
import Database from "better-sqlite3";
import { readFile, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { RuntimeStore } from "../../src/server/database";
import { writeNodeFlagExecutable } from "../helpers/portable-provider-fixture";
import { createAppFixture } from "./support/app-fixture";
import { openLocalProjectFromDialog } from "./support/add-project";

const provider = `
const fs = require("node:fs");
if (process.argv.includes("--version")) { console.log("codex-cli 0.124.0"); process.exit(0); }
if (process.argv.includes("--help")) { console.log("Usage: codex app-server [OPTIONS] - Run the app server"); process.exit(0); }
if (process.argv.includes("login")) { console.log("Logged in using ChatGPT"); process.exit(0); }
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
const threadId = "scratch-fixture-thread";
require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: { userAgent: "scratch-fixture" } });
  if (message.method === "model/list") send({ id: message.id, result: { data: [], nextCursor: null } });
  if (message.method === "account/rateLimits/read") send({ id: message.id, result: { rateLimits: null } });
  if (message.method === "thread/goal/get") send({ id: message.id, result: { goal: null } });
  if (message.method === "thread/start" || message.method === "thread/resume") {
    fs.writeFileSync("scratch-proof.json", JSON.stringify({ processCwd: process.cwd(), requestedCwd: message.params.cwd }));
    send({ id: message.id, result: { thread: { id: threadId }, model: "fixture", serviceTier: message.params.serviceTier ?? null } });
  }
  if (message.method !== "turn/start") return;
  const turn = { id: "scratch-turn", status: "inProgress", items: [], error: null };
  send({ id: message.id, result: { turn } });
  send({ method: "turn/started", params: { threadId, turn } });
  send({ method: "item/agentMessage/delta", params: { threadId, turnId: turn.id, itemId: "answer", delta: "A calm weekend: explore a new neighborhood, visit a museum, and leave time for a long lunch." } });
  send({ method: "turn/completed", params: { threadId, turn: { ...turn, status: "completed" } } });
});
`;

test("starts without a project, runs in separate folders, and restores after restart", async () => {
  const info = test.info();
  const environment: Record<string, string> = {};
  const app = await createAppFixture({ name: "scratch-chat", initialState: "empty", initialNewThreadMode: "worktree",
    additionalEnvironment: environment,
    beforeLaunch: ({ testDirectory, workspaceDirectory }) => {
      const bin = join(testDirectory, "provider-bin");
      const command = writeNodeFlagExecutable(bin, "codex", provider);
      environment.INERTIA_PACKAGE_SMOKE_CODEX_EXPECTED = command;
      const store = new RuntimeStore(join(testDirectory, "data", "inertia.sqlite"), workspaceDirectory);
      try { store.updateSettings({ codexBinaryPath: command, theme: "light" }); } finally { store.close(); }
    },
  });
  let page = app.page;
  const chats = () => {
    const database = new Database(join(app.testDirectory, "data", "inertia.sqlite"), { readonly: true });
    try { return database.prepare("SELECT id, worktree_path FROM conversations ORDER BY created_at, id").all() as Array<{ id: string; worktree_path: string }>; }
    finally { database.close(); }
  };
  try {
    await app.resizeWindow(1440, 1000);
    await page.getByRole("button", { name: "Start without a project", exact: true }).click();
    await expect(page.getByRole("heading", { name: "What should we work on?" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Project", exact: true })).toHaveText("No project");
    expect(await readdir(join(app.testDirectory, "data", "scratch"))).toEqual([]);
    await page.getByRole("textbox", { name: "Message" }).fill("Help me plan a relaxed weekend in a new city.");
    await page.screenshot({ path: info.outputPath("scratch-draft-light.png"), animations: "disabled" });
    await expect.poll(() => page.locator(".composer .provider-readiness").allTextContents()).toEqual([]);
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page.getByText("A calm weekend:", { exact: false }).first()).toBeVisible();
    await expect.poll(() => chats().length).toBe(1);
    const first = chats()[0]!;
    expect(first.worktree_path).toContain(join("data", "scratch"));
    expect(JSON.parse(await readFile(join(first.worktree_path, "scratch-proof.json"), "utf8"))).toEqual({ processCwd: await realpath(first.worktree_path), requestedCwd: first.worktree_path });
    await expect(page.getByRole("group", { name: "Chat checkout context" })).toHaveText("Chat folder");
    ({ page } = await app.restart());
    await expect(page.getByText("A calm weekend:", { exact: false }).first()).toBeVisible();
    expect(chats()[0]!.worktree_path).toBe(first.worktree_path);
    await page.getByRole("button", { name: "Start a new chat", exact: true }).click();
    await page.getByRole("textbox", { name: "Message" }).fill("Suggest another weekend plan.");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect.poll(() => chats().length).toBe(2);
    const second = chats().find(({ id }) => id !== first.id)!;
    expect(second.worktree_path).not.toBe(first.worktree_path);
    await expect(page.getByText("A calm weekend:", { exact: false }).first()).toBeVisible();
    expect(JSON.parse(await readFile(join(second.worktree_path, "scratch-proof.json"), "utf8"))).toEqual({ processCwd: await realpath(second.worktree_path), requestedCwd: second.worktree_path });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Appearance", exact: true }).click();
    await page.getByRole("radio", { name: "Dark", exact: true }).click();
    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    await app.expectNoViewportOverflow();
    await page.screenshot({ path: info.outputPath("scratch-chat-dark.png"), animations: "disabled" });
    await app.electronApp.evaluate(({ dialog }, path) => {
      Reflect.set(dialog, "showOpenDialog", async () => ({ canceled: false, filePaths: [path] }));
    }, app.workspaceDirectory);
    await page.getByRole("button", { name: "Add project", exact: true }).click();
    await openLocalProjectFromDialog(page);
    await page.getByRole("button", { name: "Start a new chat", exact: true }).click();
    const composer = page.getByRole("textbox", { name: "Message" });
    await composer.fill("Keep this prompt while I choose where to work.");
    await page.getByRole("button", { name: "Project", exact: true }).click();
    await expect(page.getByRole("option", { name: "No project", exact: true })).toHaveCount(1);
    await page.screenshot({ path: info.outputPath("scratch-project-selector.png"), animations: "disabled" });
    await page.getByRole("option", { name: "No project", exact: true }).click();
    await expect(page.getByRole("button", { name: "Project", exact: true })).toHaveText("No project");
    await expect(composer).toHaveValue("Keep this prompt while I choose where to work.");
    await app.resizeWindow(1000, 800);
    await app.expectNoViewportOverflow();
    await page.screenshot({ path: info.outputPath("scratch-draft-narrow.png"), animations: "disabled" });
    expect(app.rendererErrors).toEqual([]);
  } catch (error) {
    await page.screenshot({ path: info.outputPath("scratch-failure.png"), animations: "disabled" });
    throw error;
  } finally { await app.close(); }
});
