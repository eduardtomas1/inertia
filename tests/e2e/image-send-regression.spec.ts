// @inertia-e2e-resource primary-display
import { expect, test } from "@playwright/test";
import { createCanvas } from "@napi-rs/canvas";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withEmptyPngDataChunks } from "../fixtures/attachments/png-chunks";

import { createAppFixture } from "./support/app-fixture";
import { closeElectronAfterTest } from "./support/electron-failure-evidence";
import { attachImageSendFailureDiagnostics } from "./support/image-send-failure-diagnostics";
import { observeImagePreviewFailure } from "./support/image-preview-failure-evidence";

let activeApp: Awaited<ReturnType<typeof createAppFixture>> | undefined;
let bodyFailure: { error: unknown } | undefined;
let previewEvidence: ReturnType<typeof observeImagePreviewFailure> | undefined;

test.afterEach(async () => {
  const app = activeApp;
  const failure = bodyFailure;
  const evidence = previewEvidence;
  previewEvidence = undefined;
  activeApp = undefined;
  bodyFailure = undefined;
  // Playwright gives teardown its own budget; the 45-second body must not
  // truncate the existing privileged cleanup receipt and process proof.
  if (app) {
    try { await evidence?.finish(test.info(), Boolean(failure)); }
    finally { await closeElectronAfterTest(() => app.close(), () => test.info(), failure); }
  }
});

const imageAwareCodexAppServer = `
const fs = require("node:fs");
const crypto = require("node:crypto");
const readline = require("node:readline");
const args = process.argv.slice(2);
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
if (args[0] === "--help") {
  process.stdout.write("Usage: codex app-server [OPTIONS] - Run the app server\\n");
  process.exit(0);
}
let threadId = "image-send-thread";
let turnIndex = 0;
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
  turnIndex += 1;
  const turnId = "image-send-turn-" + turnIndex;
  const image = message.params.input.find((item) => item.type === "localImage");
  const digest = image && fs.statSync(image.path).isFile()
    ? crypto.createHash("sha256").update(fs.readFileSync(image.path)).digest("hex")
    : "missing";
  send({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [], error: null } } });
  send({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress", items: [], error: null } } });
  send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "image-answer", delta: "image-sha256:" + digest } });
  send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [], error: null } } });
});
`;

test("repeatedly sends a pasted image after startup reconciliation in a non-Git project", async () => {
  const app = activeApp = await createAppFixture({
    name: "image-send-regression",
    initialState: "conversation",
    codexAppServerSource: imageAwareCodexAppServer,
    workspaceGit: false,
  });
  try {
    const imageBytes = [...withEmptyPngDataChunks(await readFile(app.attachmentImagePath))];
    const expectedDigest = createHash("sha256")
      .update(Buffer.from(imageBytes))
      .digest("hex");
    const composer = app.page.getByRole("textbox", { name: "Message" });
    const send = app.page.getByRole("button", { name: "Send message" });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await expect(send).toBeVisible();
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
      await expect(app.page.getByRole("button", {
        name: "Remove attachment pasted.png",
      })).toBeVisible();
      const prompt = `Inspect this image, attempt ${attempt}.`;
      await composer.fill(prompt);
      await send.click();
      await expect(app.page.getByText(prompt, { exact: true })).toBeVisible();
      await expect(app.page.getByText(`image-sha256:${expectedDigest}`, { exact: true }))
        .toHaveCount(attempt, { timeout: 15_000 });
      await expect(send).toBeVisible();
    }
    await expect(app.page.getByRole("alert")).toHaveCount(0);
    expect(app.rendererErrors).toEqual([]);
  } catch (error) {
    bodyFailure = { error };
    await attachImageSendFailureDiagnostics(test.info(), app).catch(() => undefined);
    throw error;
  }
});

test("native clipboard, dropped, and selected screenshots survive send and restart", async () => {
  const app = activeApp = await createAppFixture({
    name: "native-attachment-lifecycle",
    initialState: "conversation",
    windowDisplay: "primary",
    codexAppServerSource: imageAwareCodexAppServer,
    workspaceGit: false,
  });
  // Retain the post-restart click boundary when the full Windows x64 lane
  // reproduces a preview failure; other scenarios and platforms do not trace.
  if (process.platform === "win32" && process.arch === "x64" && process.env.CI) {
    previewEvidence = observeImagePreviewFailure(app);
  }
  try {
    const canvas = createCanvas(1_920, 1_080);
    const context = canvas.getContext("2d");
    context.fillStyle = "#2563eb";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#f9c74f";
    context.fillRect(120, 160, 800, 440);
    const png = withEmptyPngDataChunks(canvas.encodeSync("png"));
    const attachments = app.page.getByRole("list", { name: "Attachments", exact: true });
    const composer = app.page.getByRole("textbox", { name: "Message" });
    const retained: { name: string; digest: string; id: string }[] = [];
    for (const method of ["clipboard", "drop", "picker"] as const) {
      let bytes = [...png];
      let name = `${method}.png`;
      if (method === "clipboard") {
        // Exercise Chromium's native clipboard conversion, not a synthetic
        // File/DataTransfer event. This fixture owns the display in CI.
        await app.electronApp.evaluate(async ({ clipboard, ClipboardItem }, data) => {
          await clipboard.write([new ClipboardItem({
            "image/png": new Blob([new Uint8Array(data)], { type: "image/png" }),
          })]);
        }, bytes);
        await composer.evaluate((textarea) => {
          Reflect.set(window, "nativeAttachmentPaste", null);
          textarea.addEventListener("paste", (event) => {
            const paste = event as ClipboardEvent;
            const file = paste.clipboardData?.files[0];
            if (!file) return;
            void file.arrayBuffer().then((data) => {
              Reflect.set(window, "nativeAttachmentPaste", {
                trusted: event.isTrusted,
                name: file.name,
                type: file.type,
                bytes: [...new Uint8Array(data)],
              });
            });
          }, { once: true });
        });
        await composer.press(process.platform === "darwin" ? "Meta+V" : "Control+V");
        await expect.poll(() => app.page.evaluate(() =>
          Reflect.get(window, "nativeAttachmentPaste") !== null)).toBe(true);
        const paste = await app.page.evaluate(() =>
          Reflect.get(window, "nativeAttachmentPaste") as {
            trusted: boolean; name: string; type: string; bytes: number[];
          });
        expect(paste.trusted).toBe(true);
        expect(paste.type).toBe("image/png");
        name = paste.name;
        bytes = paste.bytes;
      } else if (method === "drop") {
        await app.page.locator(".composer").evaluate((element, data) => {
          const transfer = new DataTransfer();
          transfer.items.add(new File([new Uint8Array(data.bytes)], data.name, {
            type: "image/png",
          }));
          element.dispatchEvent(new DragEvent("drop", {
            bubbles: true, cancelable: true, dataTransfer: transfer,
          }));
        }, { bytes, name });
      } else {
        const path = join(app.testDirectory, name);
        await writeFile(path, Buffer.from(bytes));
        await app.electronApp.evaluate(({ dialog }, selected) => {
          Reflect.set(dialog, "showOpenDialog", async () => ({
            canceled: false, filePaths: [selected], bookmarks: [],
          }));
        }, path);
        await app.page.getByRole("button", {
          name: "Attach images, documents, or spreadsheets",
        }).click();
      }
      const preview = attachments.getByRole("button", {
        name: `Preview attachment ${name}`,
      });
      await expect(preview).toBeVisible();
      const source = await attachments.locator("img").getAttribute("src");
      const id = source?.split("/").at(-1);
      expect(id).toMatch(/^[0-9a-f-]{36}$/u);
      await preview.click();
      const dialog = app.page.getByRole("dialog", { name, exact: true });
      await expect.poll(() => dialog.getByRole("img").evaluate((element) => {
        const image = element as HTMLImageElement;
        return [image.naturalWidth, image.naturalHeight];
      })).toEqual([1_920, 1_080]);
      await app.page.keyboard.press("Escape");
      const digest = createHash("sha256").update(Buffer.from(bytes)).digest("hex");
      await composer.fill(`Inspect the ${method} screenshot.`);
      await app.page.getByRole("button", { name: "Send message" }).click();
      retained.push({ name, digest, id: id! });
      await expect(app.page.getByText(`image-sha256:${digest}`, { exact: true }))
        .toHaveCount(retained.filter((image) => image.digest === digest).length);
      await expect(app.page.getByRole("button", { name: "Send message" })).toBeVisible();
      await expect(attachments).toHaveCount(0);
    }

    await app.restart();
    await previewEvidence?.afterRestart();
    for (const attachment of retained) {
      const path = join(app.testDirectory, "data", "conversation-attachments",
        attachment.id, `${attachment.id}.png`);
      expect(createHash("sha256").update(await readFile(path)).digest("hex"))
        .toBe(attachment.digest);
      // The same retained file is also offered in Recent attachments. Verify
      // both surfaces exist, then exercise the original message's preview.
      const previewName = `Preview attachment ${attachment.name}`;
      const messagePreview = app.page.getByRole("list", {
        name: "Request attachments", exact: true,
      }).getByRole("button", { name: previewName, exact: true });
      await expect(messagePreview).toHaveCount(1);
      await expect(app.page.getByRole("list", {
        name: "Recent attachments", exact: true,
      }).getByRole("button", { name: previewName, exact: true })).toHaveCount(1);
      await messagePreview.click();
      const dialog = app.page.getByRole("dialog", {
        name: attachment.name, exact: true,
      });
      await expect.poll(() => dialog.getByRole("img").evaluate((element) => {
        const image = element as HTMLImageElement;
        return [image.naturalWidth, image.naturalHeight];
      })).toEqual([1_920, 1_080]);
      await app.page.keyboard.press("Escape");
    }
    await expect(app.page.getByRole("alert")).toHaveCount(0);
    expect(app.rendererErrors).toEqual([]);
  } catch (error) {
    bodyFailure = { error };
    await attachImageSendFailureDiagnostics(test.info(), app).catch(() => undefined);
    throw error;
  }
});
