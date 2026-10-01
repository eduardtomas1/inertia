// @inertia-e2e-resource primary-display
import { createCanvas } from "@napi-rs/canvas";
import { expect, test, type Request } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ConversationAttachmentStore } from "../../src/node/conversation-attachment-store";
import { RuntimeStore } from "../../src/server/database";
import { captureBoundedFailureDiagnostic } from "../helpers/bounded-failure-diagnostic";
import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { ensureWorkspaceTools, selectWorkspaceTool } from "./support/workspace-tools";

const largeId = randomUUID();
const requestedPreviewIds = new Set<string>();
const pendingPreviews = new Set<Request>();
const previewEvents: Record<string, unknown>[] = [];
const evidenceStartedAt = Date.now();
function recordLargePreview(request: Request, event: string, fields: Record<string, unknown> = {}): void {
  if (request.url() !== `inertia://bundle/attachment-preview/${largeId}`) return;
  if (previewEvents.length === 32) previewEvents.shift();
  previewEvents.push({ event, atMs: Date.now() - evidenceStartedAt, pendingPreviews: pendingPreviews.size, ...fields });
}
let app: AppFixture;

test.beforeAll(async () => {
  app = await createAppFixture({
    name: "gallery-visibility", initialState: "conversation", windowDisplay: "primary",
    observePage: (page) => {
      page.on("request", (request) => {
        const id = /\/attachment-preview\/([^/]+)$/u.exec(request.url())?.[1];
        if (id) { requestedPreviewIds.add(id); pendingPreviews.add(request); }
        recordLargePreview(request, "request");
      });
      page.on("response", (response) => recordLargePreview(response.request(), "response", { status: response.status() }));
      page.on("requestfinished", (request) => {
        pendingPreviews.delete(request);
        recordLargePreview(request, "finished");
      });
      page.on("requestfailed", (request) => {
        pendingPreviews.delete(request);
        const code = request.failure()?.errorText;
        recordLargePreview(request, "failed", { code: code?.match(/^net::ERR_[A-Z_]+$/u)?.[0] ?? "other" });
      });
    },
    beforeLaunch: async ({ testDirectory, workspaceDirectory }) => {
      const canvas = createCanvas(8_000, 5_000);
      canvas.getContext("2d").fillRect(0, 0, 8_000, 5_000);
      const large = canvas.toBuffer("image/png");
      const small = await readFile(join(testDirectory, "preview.png"));
      const data = join(testDirectory, "data");
      const files = await ConversationAttachmentStore.open(data);
      const store = new RuntimeStore(join(data, "inertia.sqlite"), workspaceDirectory, { recoverInterruptedRuns: false });
      try {
        const conversationId = store.shellSnapshot().activeConversationId!;
        for (let index = 0; index < 60; index += 1) {
          const id = index === 0 ? largeId : randomUUID();
          const bytes = index === 0 ? large : small;
          const attachments = await files.retain([{
            attachment: { id, path: id, name: `gallery-${index}.png`, mimeType: "image/png", size: bytes.length }, bytes,
          }]);
          const at = new Date(Date.UTC(2030, 0, 1, 0, index)).toISOString();
          const { turn } = store.beginAgentTurn({
            id: randomUUID(), conversationId, runId: randomUUID(), content: `Image ${index}`,
            attachments, providerId: "codex", harnessId: "codex-app-server", backendProfileId: "native:codex:app-server",
            model: "test", reasoningEffort: "", interactionMode: "build", accessMode: "supervised",
            configurationRevision: 0, association: "authoritative", requestedAt: at,
          });
          const reply = store.createMessage(conversationId, "Saved image.", "assistant", [], turn.id, at);
          store.updateAgentTurnLifecycle(turn.id, { status: "completed", startedAt: at, completedAt: at, updatedAt: at,
            terminalAssistantMessageId: reply.id, terminalReason: "provider-completed" });
        }
      } finally { store.close(); await files.close(); }
    },
  });
});

test.afterAll(async () => { await app?.close(); });

test("keeps offscreen gallery originals unloaded and opens a retained 40-megapixel image by keyboard", async ({ browserName: _browserName }, testInfo) => {
  const { page } = app;
  const startedAt = Date.now();
  const imageSamples: Record<string, unknown>[] = [];
  const sampleLargeImage = async (stage: string) => {
    const state = await captureBoundedFailureDiagnostic(() => page.evaluate(() => {
      const button = document.querySelector('[aria-label="Chat attachments"] [aria-label="Preview attachment gallery-0.png"]');
      const image = button?.querySelector("img");
      return {
        thumbnailState: button?.querySelector("[data-thumbnail-state]")?.getAttribute("data-thumbnail-state"),
        imagePresent: !!image, complete: image?.complete,
        width: image?.naturalWidth, height: image?.naturalHeight,
      };
    }), 1_000);
    imageSamples.push({ stage, atMs: Date.now() - evidenceStartedAt,
      pendingPreviews: pendingPreviews.size, requestedPreviews: requestedPreviewIds.size, state });
    return state;
  };
  const memorySamples: Array<{ stage: string; workingSetKiB: number; requestedPreviews: number }> = [];
  const sampleMemory = async (stage: string): Promise<void> => {
    const workingSetKiB = await app.electronApp.evaluate(({ app }) => app.getAppMetrics()
      .reduce((total, metric) => total + metric.memory.workingSetSize, 0));
    memorySamples.push({ stage, workingSetKiB, requestedPreviews: requestedPreviewIds.size });
  };
  try {
    await app.resizeWindow(1440, 920);
    const transcript = page.locator(".message-scroll");
    await expect(transcript.getByRole("button", { name: "Preview attachment gallery-59.png" })).toBeVisible();
    await expect.poll(() => transcript.evaluate((scroll) => scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight)).toBeLessThan(2);
    // Virtualization retains overscan rows. Their thumbnails must not fetch and
    // decode originals outside the transcript scrollport.
    await expect.poll(() => transcript.evaluate((scroll) => {
      const clip = scroll.getBoundingClientRect();
      const images = [...scroll.querySelectorAll(".sent-attachment-thumbnail img")];
      return images.length > 0 && images.every((image) => {
        const rect = image.getBoundingClientRect();
        return rect.bottom >= clip.top && rect.top <= clip.bottom
          && rect.bottom >= 0 && rect.top <= innerHeight;
      });
    })).toBe(true);
    await sampleMemory("transcript settled before opening gallery");
    await app.electronApp.evaluate(({ utilityProcess }, startedAt) => {
      const original = utilityProcess.fork;
      const events: Record<string, unknown>[] = [];
      let worker = 0;
      Reflect.set(globalThis, "galleryPreviewWorkers", { events, restore: () => { utilityProcess.fork = original; } });
      utilityProcess.fork = (...args) => {
        const child = original(...args);
        if (args[2]?.serviceName !== "Inertia Attachment Store") return child;
        const id = ++worker;
        const record = (event: string, fields: Record<string, unknown> = {}): void => {
          if (events.length === 512) events.shift();
          events.push({ worker: id, event, atMs: Date.now() - startedAt, ...fields });
        };
        record("fork");
        child.on("spawn", () => record("spawn"));
        child.on("exit", (code) => record("exit", { code }));
        child.on("message", (message) => {
          if (message?.type === "conversation-attachment-store.ready") record("ready");
          if (message?.type === "conversation-attachment-store.result") record("result", { ok: message.ok === true });
        });
        const send = child.postMessage.bind(child);
        child.postMessage = (message, transfer) => {
          if (message?.type === "conversation-attachment-store.result-ack") record("ack");
          if (message?.type === "conversation-attachment-store.perform") {
            try {
              const operation = JSON.parse(message.encodedOperation);
              record("perform", { operation: ["read", "persist", "remove"].includes(operation.operation) ? operation.operation : "other",
                attachmentId: typeof operation.id === "string" && /^[0-9a-f-]{36}$/u.test(operation.id) ? operation.id : undefined });
            } catch { record("invalid-perform"); }
          }
          send(message, transfer);
        };
        return child;
      };
    }, evidenceStartedAt);
    // Recent attachments live in the right panel's Attachments surface.
    await selectWorkspaceTool(await ensureWorkspaceTools(page), "Attachments");
    const gallery = page.getByRole("list", { name: "Chat attachments" });
    await expect(gallery.getByRole("listitem")).toHaveCount(60);
    const first = gallery.getByRole("button", { name: "Preview attachment gallery-59.png" });
    const last = gallery.getByRole("button", { name: "Preview attachment gallery-0.png" });
    await expect.poll(() => first.locator("img").evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await expect(last.locator("img")).toHaveCount(0);
    await sampleMemory("retained gallery; 40 MP original offscreen");

    const mountedImagesAreVisible = () => gallery.evaluate((list) => {
      const clip = list.parentElement!.getBoundingClientRect();
      const images = [...list.querySelectorAll("img")];
      return images.length > 0 && images.length < 60 && images.every((image) => {
        const rect = image.getBoundingClientRect();
        return rect.bottom >= clip.top && rect.top <= clip.bottom
          && rect.bottom >= 0 && rect.top <= innerHeight;
      });
    });
    await expect.poll(mountedImagesAreVisible).toBe(true);
    // All buttons remain focusable. Native focus scrolls the last tile into
    // view, which loads its original without decoding the intervening rows.
    await last.focus();
    await expect(last).toBeFocused();
    await expect(first.locator("img")).toHaveCount(0);
    try {
      await expect.poll(() => last.locator("img").evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBe(8_000);
    } catch (error) {
      const firstFailure = await sampleLargeImage("original 15-second assertion failed");
      const remaining = startedAt + 38_000 - Date.now();
      // Diagnose a late response/decode while preserving the original assertion
      // and the 45-second test budget. This wait can never make the test pass.
      if (remaining > 0 && !(firstFailure.outcome === "captured" && firstFailure.value.complete)) {
        await captureBoundedFailureDiagnostic(() => page.waitForFunction(() => {
          const image = document.querySelector<HTMLImageElement>('[aria-label="Chat attachments"] [aria-label="Preview attachment gallery-0.png"] img');
          return image?.complete;
        }, undefined, { timeout: remaining }).then(() => undefined), remaining);
      }
      await sampleLargeImage("after bounded late-completion observation");
      throw error;
    }
    await expect(last.locator("img")).toHaveAttribute("src", `inertia://bundle/attachment-preview/${largeId}`);
    await expect.poll(mountedImagesAreVisible).toBe(true);
    await page.keyboard.press("Enter");
    const preview = page.getByRole("dialog", { name: "gallery-0.png" });
    await expect(preview).toBeVisible();
    const stage = preview.getByRole("group", { name: /^Zoomable preview of / });
    await expect.poll(() => stage.locator("img").evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBe(8_000);
    await stage.locator("img").evaluate((image) => (image as HTMLImageElement).decode());
    await sampleMemory("40 MP original visible in gallery and preview");
    await stage.focus();
    await page.keyboard.press("+");
    await expect(stage.getByLabel("Zoom level")).toHaveText("150%");
    await page.keyboard.press("Escape");
    await expect(preview).toBeHidden();
    await expect(last).toBeFocused();
    await first.focus();
    await expect(last.locator("img")).toHaveCount(0);
    await expect.poll(mountedImagesAreVisible).toBe(true);
    await sampleMemory("40 MP preview closed and gallery image offscreen");
    await app.expectNoViewportOverflow();
    expect(app.rendererErrors).toEqual([]);
  } finally {
    const workers = await captureBoundedFailureDiagnostic(() => app.electronApp.evaluate(() => {
      const state = Reflect.get(globalThis, "galleryPreviewWorkers") as { events: Record<string, unknown>[]; restore: () => void } | undefined;
      state?.restore();
      return state?.events ?? [];
    }), 1_000);
    await captureBoundedFailureDiagnostic(async () => {
      await testInfo.attach("image-memory-samples", { body: JSON.stringify(memorySamples, null, 2), contentType: "application/json" });
      const path = testInfo.outputPath("gallery-preview-state.json");
      await writeFile(path, JSON.stringify({ largeId, events: previewEvents, imageSamples, workers, memorySamples,
        requestedPreviews: requestedPreviewIds.size, pendingPreviews: pendingPreviews.size,
        rendererErrorCount: app.rendererErrors.length }, null, 2));
      await testInfo.attach("gallery-preview-state", { path, contentType: "application/json" });
      const imagePath = testInfo.outputPath("large-fixture.png");
      await writeFile(imagePath, await readFile(join(app.testDirectory, "data", "conversation-attachments", largeId, `${largeId}.png`)));
      await testInfo.attach("large-fixture", { path: imagePath, contentType: "image/png" });
    }, 2_000);
  }
});
