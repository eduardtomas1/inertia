import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

import { createAppFixture } from "./support/app-fixture";

const imageAwareCodexAppServer = `
const fs = require("node:fs");
const readline = require("node:readline");
const args = process.argv.slice(2);
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
if (args[0] === "--help") {
  process.stdout.write("Usage: codex app-server [OPTIONS] - Run the app server\\n");
  process.exit(0);
}
let threadId = "image-send-thread";
const turnId = "image-send-turn";
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "image-send-fixture" } });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "model/list") {
    send({ id: message.id, result: { data: [], nextCursor: null } });
    return;
  }
  if (message.method === "account/rateLimits/read") {
    send({ id: message.id, result: { rateLimits: null, rateLimitsByLimitId: null } });
    return;
  }
  if (message.method === "thread/start" || message.method === "thread/resume") {
    threadId = message.params.threadId || threadId;
    send({ id: message.id, result: { thread: { id: threadId }, model: "fixture" } });
    return;
  }
  if (message.method !== "turn/start") return;
  const image = message.params.input.find((item) => item.type === "localImage");
  const readable = image && fs.statSync(image.path).isFile();
  send({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [], error: null } } });
  send({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress", items: [], error: null } } });
  send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "image-answer", delta: readable ? "The image reached Codex." : "The image was missing." } });
  send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [], error: null } } });
});
`;

test("sends a pasted image through the real desktop and Codex path", async () => {
  const app = await createAppFixture({
    name: "image-send-regression",
    initialState: "conversation",
    codexAppServerSource: imageAwareCodexAppServer,
  });
  try {
    const imageBytes = [...await readFile(app.attachmentImagePath)];
    const composer = app.page.getByRole("textbox", { name: "Message" });
    await composer.evaluate((textarea, bytes) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(
        [new Uint8Array(bytes)],
        "pasted.png",
        { type: "image/png" },
      ));
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: transfer });
      textarea.dispatchEvent(event);
    }, imageBytes);
    await expect(app.page.getByText("pasted.png", { exact: true })).toBeVisible();
    await composer.fill("Inspect this image.");
    await app.page.getByRole("button", { name: "Send message" }).click();

    await expect(app.page.getByText("The image reached Codex.", { exact: true }))
      .toBeVisible({ timeout: 15_000 });
    await expect(app.page.getByRole("alert")).toHaveCount(0);
    expect(app.rendererErrors).toEqual([]);
  } finally {
    await app.close();
  }
});
