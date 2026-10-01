// @inertia-e2e-resource isolated
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeStore } from "../../src/server/database";
import { createAppFixture, type AppFixture } from "./support/app-fixture";

const codexId = "01962fd7-1000-7000-8000-123456789abc";
const claudeId = "01962fd7-2000-7000-8000-123456789abc";
const codexTitle = "Make the project sidebar easier to navigate";
const claudeTitle = "Review keyboard access in the settings panel";
const providerSource = `
const fs = require("node:fs");
const path = require("node:path");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
if (process.argv[2] === "--help") { process.stdout.write("Usage: codex app-server [OPTIONS] - Run the app server\\n"); process.exit(0); }
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ id: message.id, result: { userAgent: "cli-import-fixture" } });
  if (message.method === "model/list") return send({ id: message.id, result: { data: [], nextCursor: null } });
  if (message.method === "account/rateLimits/read") return send({ id: message.id, result: { rateLimits: null } });
  if (message.method === "thread/goal/get") return send({ id: message.id, result: { goal: null } });
  if (message.method === "thread/start") return send({ id: message.id, error: { code: -32600, message: "Imported session must resume" } });
  if (message.method === "thread/resume") {
    fs.appendFileSync(path.join(process.cwd(), "import-resume.jsonl"), JSON.stringify(message.params) + "\\n");
    return send({ id: message.id, result: { thread: { id: message.params.threadId }, model: "fixture" } });
  }
  if (message.method !== "turn/start") return;
  const threadId = message.params.threadId;
  const turn = { id: "import-follow-up", status: "inProgress", items: [], error: null };
  send({ id: message.id, result: { turn } });
  send({ method: "turn/started", params: { threadId, turn } });
  send({ method: "item/agentMessage/delta", params: { threadId, turnId: turn.id, itemId: "answer", delta: "Continued the original CLI conversation." } });
  send({ method: "turn/completed", params: { threadId, turn: { ...turn, status: "completed" } } });
});
`;
let app: AppFixture | undefined;
let historyRoot: string | undefined;
test.afterEach(async ({ browserName: _browserName }, info) => {
  if (app && info.status !== info.expectedStatus) {
    await info.attach("runtime-state", { body: JSON.stringify(await app.runtimeSnapshot()), contentType: "application/json" });
    await info.attach("import-dialog-state", { body: await app.page.locator("body").ariaSnapshot(), contentType: "text/plain" });
    await capture(info, "import-failure");
  }
  await app?.close(); if (historyRoot) await rm(historyRoot, { recursive: true, force: true });
});
async function openImporter(page: Page): Promise<void> {
  await page.getByRole("complementary", { name: "Project navigation" }).getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  await page.getByRole("button", { name: "Choose project", exact: true }).click();
  await page.getByRole("option", { name: "Workspace studio", exact: true }).click();
  await page.getByRole("button", { name: "Import conversations…", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Import CLI conversations" })).toBeVisible();
}
async function capture(info: TestInfo, name: string): Promise<void> {
  const path = info.outputPath(`${name}.png`);
  await app!.page.screenshot({ path, animations: "disabled" });
  await info.attach(name, { path, contentType: "image/png" });
  await app!.expectNoViewportOverflow();
}

test("imports both native histories, persists duplicates across restart, and resumes the original Codex session", async ({ browserName: _browserName }, info) => {
  test.setTimeout(120_000);
  historyRoot = await mkdtemp(join(tmpdir(), "inertia-cli-history-"));
  const codexRoot = join(historyRoot, "codex"); const claudeRoot = join(historyRoot, "claude");
  const codexFile = join(codexRoot, "sessions", "2026", "09", "25", `rollout-${codexId}.jsonl`);
  const claudeFile = join(claudeRoot, "projects", "workspace", `${claudeId}.jsonl`);
  let originalCodex = ""; let originalClaude = "";
  app = await createAppFixture({ name: "cli-conversation-import", initialState: "conversation", codexAppServerSource: providerSource,
    additionalEnvironment: { CODEX_HOME: codexRoot, CLAUDE_CONFIG_DIR: claudeRoot },
    beforeLaunch: async ({ testDirectory, workspaceDirectory }) => {
      await mkdir(join(codexRoot, "sessions", "2026", "09", "25"), { recursive: true });
      await mkdir(join(claudeRoot, "projects", "workspace"), { recursive: true });
      const timestamp = "2026-09-25T10:00:00.000Z";
      originalCodex = [
        { type: "session_meta", payload: { id: codexId, cwd: workspaceDirectory, model_provider: "openai" } },
        ...[["user", codexTitle], ["assistant", "I’ll group related chats under each project and keep the active conversation visible. Keyboard navigation will follow the same order as the sidebar."],
          ["user", "Keep collapsed projects compact, and make sure unread conversations are easy to spot."],
          ["assistant", "The sidebar now preserves each project’s expanded state. Unread chats have a small indicator, and arrow keys move between visible conversations."]]
          .map(([role, text]) => ({ type: "response_item", timestamp, payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] } })),
      ].map((item) => JSON.stringify(item)).join("\n");
      originalClaude = [["user", claudeTitle], ["assistant", "The settings panel needs a clear focus order, visible focus rings, and Escape to return to the previous view."]]
        .map(([type, content], index) => JSON.stringify({ type, uuid: `message-${index}`, parentUuid: index ? "message-0" : null, sessionId: claudeId, cwd: workspaceDirectory, timestamp, message: { role: type, content } })).join("\n");
      await writeFile(codexFile, originalCodex); await writeFile(claudeFile, originalClaude);
      const store = new RuntimeStore(join(testDirectory, "data", "inertia.sqlite"), workspaceDirectory);
      try { store.updateProject(store.shellSnapshot().projects[0]!.id, { name: "Workspace studio" }); store.updateSettings({ theme: "light", newThreadMode: "local" }); } finally { store.close(); }
    },
  });
  await app.resizeWindow(1280, 920);
  await openImporter(app.page);
  const dialog = app.page.getByRole("dialog", { name: "Import CLI conversations" });
  await dialog.getByRole("button", { name: new RegExp(codexTitle, "u") }).click();
  await expect(dialog.getByText("Codex · 4 text messages", { exact: true })).toBeVisible();
  await capture(info, "cli-import-preview-light");
  await dialog.getByRole("button", { name: "Import conversation", exact: true }).click();
  await expect.poll(async () => {
    const error = await dialog.getByRole("alert").allTextContents();
    return error.length ? error.join("\n") : await dialog.locator(".cli-import-footer button").innerText();
  }).toBe("Already imported");
  await dialog.getByRole("button", { name: new RegExp(claudeTitle, "u") }).click();
  await expect(dialog.getByText("Claude Code · 2 text messages", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Import conversation", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("Imported. Find this conversation");
  await dialog.getByRole("button", { name: "Close CLI import" }).click();
  await app.page.getByRole("button", { name: "General", exact: true }).click();
  await app.page.getByRole("radio", { name: "Dark", exact: true }).click();
  await openImporter(app.page);
  await dialog.getByRole("button", { name: new RegExp(codexTitle, "u") }).click();
  await expect(dialog.getByRole("button", { name: "Already imported", exact: true })).toBeDisabled();
  await capture(info, "cli-import-imported-dark");
  await app.resizeWindow(900, 700);
  await capture(info, "cli-import-compact-dark");
  await dialog.getByRole("button", { name: "Close CLI import" }).click();
  const store = new RuntimeStore(join(app.testDirectory, "data", "inertia.sqlite"), app.workspaceDirectory, { recoverInterruptedRuns: false });
  let conversationId: string;
  try { conversationId = store.importedCliConversation("codex", codexId)!; expect(store.importedCliConversation("claude", claudeId)).toBeTruthy(); } finally { store.close(); }
  await app.page.locator(`[data-work-focus-id="thread:${conversationId}"]`).click();
  await expect(app.page.locator(".composer .provider-readiness")).toHaveCount(0);
  await app.page.getByRole("textbox", { name: "Message", exact: true }).fill("Continue with the sidebar checks.");
  await app.page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(app.page.getByText("Continued the original CLI conversation.", { exact: true })).toBeVisible();
  expect(JSON.parse((await readFile(join(app.workspaceDirectory, "import-resume.jsonl"), "utf8")).trim())).toMatchObject({ threadId: codexId });
  await app.restart();
  await openImporter(app.page);
  await app.page.getByRole("dialog").getByRole("button", { name: new RegExp(codexTitle, "u") }).click();
  await expect(app.page.getByRole("button", { name: "Already imported", exact: true })).toBeDisabled();
  expect(await readFile(codexFile, "utf8")).toBe(originalCodex);
  expect(await readFile(claudeFile, "utf8")).toBe(originalClaude);
  expect(app.rendererErrors).toEqual([]);
});
