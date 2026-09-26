// @inertia-e2e-resource isolated
import { expect, test } from "@playwright/test";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { ensureWorkspaceTools, selectWorkspaceTool } from "./support/workspace-tools";

const textProvider = `
const fs = require("node:fs");
const send = message => process.stdout.write(JSON.stringify(message) + "\\n");
if (process.argv[2] === "--help") {
  process.stdout.write("Usage: codex app-server [OPTIONS] - Run the app server\\n");
  process.exit(0);
}
const threadId = "text-attachment-thread";
require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: { userAgent: "text-fixture" } });
  if (message.method === "model/list") send({ id: message.id, result: { data: [], nextCursor: null } });
  if (message.method === "account/rateLimits/read") send({ id: message.id, result: { rateLimits: null } });
  if (message.method === "thread/start" || message.method === "thread/resume") {
    send({ id: message.id, result: { thread: { id: threadId }, model: "fixture" } });
  }
  if (message.method !== "turn/start") return;
  fs.writeFileSync("received-text-input.json", JSON.stringify(message.params.input));
  const turnId = "text-attachment-turn";
  const turn = { id: turnId, status: "inProgress", items: [], error: null };
  send({ id: message.id, result: { turn } });
  send({ method: "turn/started", params: { threadId, turn } });
  send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "text-answer", delta: "Attachment text received." } });
  send({ method: "turn/completed", params: { threadId, turn: { ...turn, status: "completed" } } });
});
`;

let app: AppFixture | undefined;
test.afterEach(async () => { await app?.close(); });

test("text and log files survive picker, drop, paste, provider delivery and restart", async () => {
  app = await createAppFixture({
    name: "text-attachments",
    initialState: "conversation",
    codexAppServerSource: textProvider,
    workspaceGit: false,
  });
  const files = [
    { name: "notes.txt", bytes: Buffer.from("\ufeffRésumé 東京", "utf16le"), text: "Résumé 東京" },
    { name: "Dockerfile", bytes: Buffer.from("FROM scratch\n"), text: "FROM scratch" },
    { name: "color.log", bytes: Buffer.from("\x1b[31mERROR\x1b[0m: disk full\n"), text: "ERROR: disk full" },
    { name: "pasted.log", bytes: Buffer.from("\ufeffINFO clipboard ready", "utf16le").swap16(), text: "INFO clipboard ready" },
  ];
  for (const file of files.slice(0, 2)) await writeFile(join(app.testDirectory, file.name), file.bytes);
  await app.electronApp.evaluate(({ dialog }, paths) => {
    Reflect.set(dialog, "showOpenDialog", async (_window: unknown, options: { filters: { extensions: string[] }[] }) => {
      Reflect.set(globalThis, "textAttachmentPickerFilters", options.filters);
      return { canceled: false, filePaths: paths, bookmarks: [] };
    });
  }, files.slice(0, 2).map(({ name }) => join(app!.testDirectory, name)));
  await app.page.getByRole("button", { name: "Attach images, documents, or spreadsheets" }).click();
  const attachments = app.page.getByRole("list", { name: "Attachments", exact: true });
  await expect(attachments.getByRole("button", { name: "Preview attachment notes.txt" })).toBeVisible();
  const filters = await app.electronApp.evaluate(() =>
    Reflect.get(globalThis, "textAttachmentPickerFilters") as { extensions: string[] }[]);
  expect(filters[0]!.extensions).toEqual(expect.arrayContaining(["txt", "log", "jsonc"]));
  expect(filters[1]!.extensions).toEqual(["*"]);

  await expect(app.page.getByRole("button", { name: /^Attach /u })).toBeEnabled();
  await app.page.locator(".composer").evaluate((element, data) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(data)], "color.log", { type: "text/x-log" }));
    transfer.items.add(new File(["PK"], "archive.zip", { type: "application/zip" }));
    element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, [...files[2]!.bytes]);
  await expect(attachments.getByRole("button", { name: "Preview attachment color.log" })).toBeVisible();
  await expect(app.page.getByText(/Unsupported file type: archive.zip/u)).toBeVisible();
  await expect(attachments.getByText("archive.zip", { exact: true })).toHaveCount(0);

  await expect(app.page.getByRole("button", { name: /^Attach /u })).toBeEnabled();
  await app.page.getByRole("textbox", { name: "Message" }).evaluate((element, data) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(data)], "pasted.log", { type: "binary/octet-stream" }));
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: transfer });
    element.dispatchEvent(event);
  }, [...files[3]!.bytes]);
  for (const file of files) {
    const trigger = attachments.getByRole("button", { name: `Preview attachment ${file.name}` });
    await trigger.click();
    await expect(app.page.getByLabel(`Text preview of ${file.name}`)).toHaveText(file.text);
    await app.page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
  }
  await app.page.getByRole("textbox", { name: "Message" }).fill("Inspect all four text attachments.");
  await app.page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(app.page.getByText("Attachment text received.", { exact: true })).toBeVisible();
  const input = JSON.parse(await readFile(join(app.workspaceDirectory, "received-text-input.json"), "utf8")) as { type: string; text?: string }[];
  expect(input.every(({ type }) => type === "text")).toBe(true);
  const prompt = input.map(({ text }) => text ?? "").join("\n");
  for (const { name, text } of files) {
    expect(prompt).toContain(name);
    expect(prompt).toContain(JSON.stringify(text));
  }
  expect(prompt).not.toContain("\x1b");

  await app.restart();
  await selectWorkspaceTool(await ensureWorkspaceTools(app.page), "Attachments");
  const gallery = app.page.getByRole("list", { name: "Chat attachments", exact: true });
  for (const file of files) {
    await gallery.getByRole("button", { name: `Preview attachment ${file.name}` }).click();
    await expect(app.page.getByLabel(`Text preview of ${file.name}`)).toHaveText(file.text);
    await app.page.keyboard.press("Escape");
  }
  const retainedRoot = join(app.testDirectory, "data", "conversation-attachments");
  const retained = await Promise.all((await readdir(retainedRoot)).map(async (id) =>
    await readFile(join(retainedRoot, id, `${id}.txt`))));
  expect(retained).toHaveLength(files.length);
  for (const file of files) expect(retained.some((bytes) => bytes.equals(file.bytes))).toBe(true);
  expect(app.rendererErrors).toEqual([]);
});
