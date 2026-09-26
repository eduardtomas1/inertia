// @inertia-e2e-resource primary-display
import { expect, test, type Page } from "@playwright/test";
import { createCanvas } from "@napi-rs/canvas";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createAppFixture } from "./support/app-fixture";
import { closeElectronAfterTest } from "./support/electron-failure-evidence";
import { attachImageSendFailureDiagnostics } from "./support/image-send-failure-diagnostics";

let activeApp: Awaited<ReturnType<typeof createAppFixture>> | undefined;
let bodyFailure: { error: unknown } | undefined;

test.afterEach(async () => {
  const app = activeApp;
  const failure = bodyFailure;
  activeApp = undefined;
  bodyFailure = undefined;
  if (app) await closeElectronAfterTest(() => app.close(), () => test.info(), failure);
});

const followUpCodexAppServer = `
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const readline = require("node:readline");
const args = process.argv.slice(2);
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
if (args[0] === "--help") {
  process.stdout.write("Usage: codex app-server [OPTIONS] - Run the app server\\n");
  process.exit(0);
}
let threadId = "image-follow-up-thread";
let turnIndex = 0;
let held = null;
const digests = (input) => input.filter((item) => item.type === "localImage")
  .map((item) => fs.statSync(item.path).isFile()
    ? crypto.createHash("sha256").update(fs.readFileSync(item.path)).digest("hex")
    : "missing").join(",");
const answer = (turnId, itemId, text) => send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId, delta: text } });
const complete = (turnId, status) => send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status, items: [], error: null } } });
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "image-follow-up-fixture" } });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "model/list") {
    send({ id: message.id, result: { data: [{ id: "vision-fixture", model: "vision-fixture", displayName: "Vision fixture", isDefault: true, inputModalities: ["text", "image"], supportedReasoningEfforts: [] }], nextCursor: null } });
    return;
  }
  if (message.method === "account/rateLimits/read") {
    send({ id: message.id, result: { rateLimits: null, rateLimitsByLimitId: null } });
    return;
  }
  if (message.method === "thread/start" || message.method === "thread/resume") {
    threadId = message.params.threadId || threadId;
    send({ id: message.id, result: { thread: { id: threadId }, model: "vision-fixture" } });
    return;
  }
  if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
    if (held) complete(held, "interrupted");
    held = null;
    return;
  }
  if (message.method === "turn/steer") {
    if (!held || message.params.expectedTurnId !== held) {
      send({ id: message.id, error: { code: -32600, message: "no active turn" } });
      return;
    }
    const turnId = held;
    held = null;
    send({ id: message.id, result: { turnId } });
    answer(turnId, "steer-answer", "\\n\\nsteered-image-sha256:" + digests(message.params.input));
    complete(turnId, "completed");
    return;
  }
  if (message.method !== "turn/start") return;
  turnIndex += 1;
  const turnId = "image-follow-up-turn-" + turnIndex;
  const text = message.params.input.find((item) => item.type === "text")?.text ?? "";
  send({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [], error: null } } });
  send({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress", items: [], error: null } } });
  if (text.includes("Keep working")) {
    held = turnId;
    answer(turnId, "working-" + turnIndex, "working-on-turn-" + turnIndex);
    if (text.includes("briefly")) {
      // Slow imports must not lose their active-turn authority to a fixture timer.
      const release = setInterval(() => {
        if (held !== turnId) { clearInterval(release); return; }
        if (!fs.existsSync(path.join(__dirname, "release-queued-turn"))) return;
        clearInterval(release);
        held = null;
        answer(turnId, "released-" + turnIndex, "\\n\\nreleased-turn-" + turnIndex);
        complete(turnId, "completed");
      }, 50);
    }
    return;
  }
  answer(turnId, "image-answer-" + turnIndex, "image-sha256:" + digests(message.params.input));
  complete(turnId, "completed");
});
`;

function colouredPng(red: number, green: number, blue: number): number[] {
  const canvas = createCanvas(96, 64);
  const context = canvas.getContext("2d");
  context.fillStyle = `rgb(${red}, ${green}, ${blue})`;
  context.fillRect(0, 0, canvas.width, canvas.height);
  return [...canvas.encodeSync("png")];
}

function sha256(bytes: readonly number[]): string {
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}

async function pasteImages(page: Page, images: readonly number[][]): Promise<void> {
  const composer = page.getByRole("textbox", { name: "Message" });
  await expect(page.getByRole("button", { name: /^Attach /u })).toBeEnabled();
  await composer.evaluate((textarea, files) => {
    const transfer = new DataTransfer();
    files.forEach((bytes, index) => transfer.items.add(new File(
      [new Uint8Array(bytes)],
      `follow-up-${index + 1}.png`,
      { type: "image/png" },
    )));
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: transfer });
    textarea.dispatchEvent(event);
  }, images.map((bytes) => [...bytes]));
  for (let index = 1; index <= images.length; index += 1) {
    const remove = page.getByRole("button", {
      name: `Remove attachment follow-up-${index}.png`,
    });
    await expect(remove).toBeVisible();
    // Imports render before privileged acknowledgement; Enter/Tab need readiness.
    await expect(remove).toBeEnabled();
  }
}

async function startHeldTurn(page: Page, prompt: string): Promise<void> {
  await page.getByRole("textbox", { name: "Message" }).fill(prompt);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByRole("button", { name: "Stop agent" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message" }))
    .toHaveAttribute("placeholder", "Enter sends · Tab queues");
}

test("queued, steered, and later image follow-ups keep working once durable attachment storage is full", async () => {
  test.setTimeout(90_000);
  const app = activeApp = await createAppFixture({
    name: "image-follow-up-regression",
    initialState: "conversation",
    codexAppServerSource: followUpCodexAppServer,
    workspaceGit: false,
    additionalEnvironment: { INERTIA_TEST_CONVERSATION_ATTACHMENT_MAX_RECORDS: "3" },
  });
  try {
    const page = app.page;
    const composer = page.getByRole("textbox", { name: "Message" });
    const send = page.getByRole("button", { name: "Send message" });
    const history = [colouredPng(200, 40, 40), colouredPng(40, 200, 40), colouredPng(200, 200, 40)];
    for (const [index, image] of history.entries()) {
      await pasteImages(page, [image]);
      await composer.fill(`Fill attachment storage ${index + 1}.`);
      await send.click();
      await expect(page.getByText(`image-sha256:${sha256(image)}`, { exact: true })).toBeVisible();
      await expect(send).toBeVisible();
    }

    await page.getByRole("button", { name: "New chat", exact: true }).click();
    await expect(page.getByRole("heading", { name: "What should we build in Inertia?" })).toBeVisible();
    await startHeldTurn(page, "Keep working until I steer you.");
    const steered = colouredPng(40, 40, 200);
    await pasteImages(page, [steered]);
    await composer.fill("Steer with this image.");
    await composer.press("Enter");
    await expect(page.getByText(`steered-image-sha256:${sha256(steered)}`, { exact: true }))
      .toBeVisible({ timeout: 15_000 });
    await expect(send).toBeVisible();

    await startHeldTurn(page, "Keep working briefly.");
    const queued = [colouredPng(220, 180, 20), colouredPng(20, 180, 220)];
    await pasteImages(page, queued);
    await composer.fill("Queue these images.");
    await composer.press("Tab");
    await expect(page.getByRole("list", { name: "Queued messages" })).toContainText("2 images");
    await expect(page.getByRole("button", { name: "Stop agent" })).toBeVisible();
    await writeFile(join(app.workspaceDirectory, "release-queued-turn"), "release", { flag: "wx" });
    await expect(page.getByText(`image-sha256:${queued.map(sha256).join(",")}`, { exact: true }))
      .toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("list", { name: "Queued messages" })).toHaveCount(0);
    await expect(send).toBeVisible();

    const later = colouredPng(120, 20, 160);
    await pasteImages(page, [later]);
    await composer.fill("And one more after it finished.");
    await send.click();
    await expect(page.getByText(`image-sha256:${sha256(later)}`, { exact: true }))
      .toBeVisible({ timeout: 15_000 });

    await expect(page.getByRole("alert")).toHaveCount(0);
    expect(app.rendererErrors).toEqual([]);
  } catch (error) {
    bodyFailure = { error };
    await attachImageSendFailureDiagnostics(test.info(), app).catch(() => undefined);
    throw error;
  }
});
