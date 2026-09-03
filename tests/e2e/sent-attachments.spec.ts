import { expect, test, type Locator } from "@playwright/test";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  createAppFixture,
  type AppFixture,
} from "./support/app-fixture";
import { installRuntimeRecoveryConsent } from
  "./support/runtime-crash-safety";

let app!: AppFixture;
let electronApp!: AppFixture["electronApp"];
let page!: AppFixture["page"];
let testDirectory!: AppFixture["testDirectory"];
let attachmentImagePath!: AppFixture["attachmentImagePath"];
let attachmentDocumentPath!: AppFixture["attachmentDocumentPath"];
let malformedAttachmentPath!: AppFixture["malformedAttachmentPath"];
let rendererErrors!: AppFixture["rendererErrors"];
let resizeWindow!: AppFixture["resizeWindow"];

async function expectImagePreviewSettled(image: Locator): Promise<void> {
  await expect.poll(() => image.evaluate((element) => ({
    complete: (element as HTMLImageElement).complete,
    width: (element as HTMLImageElement).naturalWidth,
  }))).toEqual({ complete: true, width: 1 });
}

async function stagedAttachmentPath(
  id: string | undefined,
  extension: string,
): Promise<string> {
  expect(id).toBeTruthy();
  const root = join(
    await electronApp.evaluate(({ app: electron }) =>
      electron.getPath("temp")),
    "inertia-attachments",
  );
  const sessions = (await readdir(root))
    .filter((name) => /^session-[A-Za-z0-9_-]{6}$/u.test(name));
  const candidates = await Promise.all(sessions.map(async (session) => {
    const path = join(root, session, `${id}.${extension}`);
    return await stat(path).then(() => path, () => null);
  }));
  const matches = candidates.filter((path) => path !== null);
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

test.beforeAll(async () => {
  app = await createAppFixture({
    name: "sent-attachments",
    initialState: "conversation",
    attachmentImportDelayMs: 750,
    attachmentCommitDelayMs: 750,
  });
  electronApp = app.electronApp;
  page = app.page;
  testDirectory = app.testDirectory;
  attachmentImagePath = app.attachmentImagePath;
  attachmentDocumentPath = app.attachmentDocumentPath;
  malformedAttachmentPath = app.malformedAttachmentPath;
  rendererErrors = app.rendererErrors;
  resizeWindow = app.resizeWindow;
});

test.afterAll(async () => {
  await app.close();
});

test("previews, validates, removes, and cleans up secure composer attachments", {
  tag: "@runtime-recovery",
}, async ({ browserName: _browserName }, testInfo) => {
  // The deliberate macOS crash can consume the complete bounded 20-second
  // recovery path before this long attachment journey performs its final
  // restart assertions. Keep the inner recovery bound authoritative while
  // leaving enough outer headroom for the remaining real desktop checks.
  test.setTimeout(75_000);
  await resizeWindow(1440, 920);
  await electronApp.evaluate(({ dialog }, paths) => {
    Reflect.set(dialog, "showOpenDialog", async () => ({
      canceled: false,
      filePaths: paths,
      bookmarks: [],
    }));
  }, [attachmentImagePath, attachmentDocumentPath]);

  await page.getByRole("button", {
    name: "Attach images, documents, or spreadsheets",
  }).click();
  const importStatus = page.getByRole("status");
  await expect(importStatus).toBeVisible();
  await expect(importStatus).toHaveText("Adding attachments…");
  const mainHeartbeatStarted = Date.now();
  await electronApp.evaluate(async () => {
    await new Promise<void>((resolveHeartbeat) => {
      setTimeout(resolveHeartbeat, 10);
    });
  });
  expect(Date.now() - mainHeartbeatStarted).toBeLessThan(500);
  const responsiveProbe = "Typing stays responsive while files are validated.";
  const probeStarted = Date.now();
  await page.getByRole("textbox", { name: "Message" }).fill(responsiveProbe);
  await expect(page.getByRole("textbox", { name: "Message" }))
    .toHaveValue(responsiveProbe);
  expect(Date.now() - probeStarted).toBeLessThan(500);
  await expect(page.getByRole("button", { name: "Send message" }))
    .toBeDisabled();
  const responsiveScreenshotPath = testInfo.outputPath(
    "attachment-import-responsive-1440x920.png",
  );
  await page.screenshot({
    animations: "disabled",
    path: responsiveScreenshotPath,
  });
  await testInfo.attach("attachment-import-responsive-1440x920", {
    path: responsiveScreenshotPath,
    contentType: "image/png",
  });
  await page.getByRole("textbox", { name: "Message" }).fill("");
  const attachments = page.getByRole("list", {
    name: "Attachments",
    exact: true,
  });
  await expect(attachments.getByText("preview.png", { exact: true })).toBeVisible();
  await expect(attachments.getByText("notes.pdf", { exact: true })).toBeVisible();
  await expect(attachments.getByText("PNG image · 68 B", { exact: true })).toBeVisible();
  await expect(attachments.getByText(
    `PDF document · ${(await stat(attachmentDocumentPath)).size} B`,
    { exact: true },
  )).toBeVisible();
  const chosenPreview = attachments.locator("img");
  await expect(chosenPreview).toHaveCount(1);
  await expect.poll(() => chosenPreview.evaluate((element) => {
    const image = element as HTMLImageElement;
    const source = image.currentSrc || image.src;
    return {
      complete: image.complete,
      width: image.naturalWidth,
      scheme: new URL(source).protocol,
      host: new URL(source).host,
    };
  })).toEqual({
    complete: true,
    width: 1,
    scheme: "inertia:",
    host: "bundle",
  });
  const chosenPreviewSource = await chosenPreview.getAttribute("src");
  expect(chosenPreviewSource).toMatch(
    /^inertia:\/\/bundle\/attachment-preview\/[0-9a-f-]{36}$/u,
  );
  const untrustedHostStatus = await electronApp.evaluate(
    async ({ net }, url) => (await net.fetch(url)).status,
    chosenPreviewSource!.replace("inertia://bundle/", "inertia://untrusted/"),
  );
  expect(untrustedHostStatus).toBe(404);
  expect(chosenPreviewSource).not.toContain(testDirectory);
  expect(await page.locator(".composer").textContent()).not.toContain(testDirectory);
  await expect(page.getByText(
    /Document preview is available, but this route cannot read/u,
  )).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled();

  await resizeWindow(520, 720);
  const attachmentBounds = await attachments.evaluate((list) => {
    const bounds = list.getBoundingClientRect();
    return {
      right: bounds.right,
      viewport: window.innerWidth,
      scrollHeight: list.scrollHeight,
      clientHeight: list.clientHeight,
    };
  });
  expect(attachmentBounds.right).toBeLessThanOrEqual(attachmentBounds.viewport + 1);
  expect(attachmentBounds.clientHeight).toBeLessThanOrEqual(152);
  expect(attachmentBounds.scrollHeight).toBeGreaterThanOrEqual(attachmentBounds.clientHeight);
  await resizeWindow(1440, 920);
  const screenshotPath = testInfo.outputPath("secure-attachments-1440x920.png");
  await page.screenshot({ animations: "disabled", path: screenshotPath });
  await testInfo.attach("secure-attachments-1440x920", {
    path: screenshotPath,
    contentType: "image/png",
  });

  await attachments.getByRole("button", { name: "Remove attachment notes.pdf" }).click();
  await expect(attachments.getByText("notes.pdf", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled();

  const chosenId = chosenPreviewSource?.split("/").at(-1);
  expect(chosenId).toBeTruthy();
  const selectedTempPath = await stagedAttachmentPath(chosenId, "png");
  await expect.poll(async () => stat(selectedTempPath).then(() => true, () => false)).toBe(true);
  const selectedBytes = await readFile(selectedTempPath);
  const sameSizeReplacement = Buffer.from(selectedBytes);
  const replacementIndex = sameSizeReplacement.length - 1;
  sameSizeReplacement[replacementIndex] =
    sameSizeReplacement[replacementIndex]! ^ 0x01;
  await writeFile(selectedTempPath, sameSizeReplacement);
  const replacedPreviewStatus = await electronApp.evaluate(
    async ({ net }, url) => (await net.fetch(url)).status,
    chosenPreviewSource!,
  );
  expect(replacedPreviewStatus).toBe(404);
  await writeFile(selectedTempPath, selectedBytes);
  const restoredPreviewStatus = await electronApp.evaluate(
    async ({ net }, url) => (await net.fetch(url)).status,
    chosenPreviewSource!,
  );
  expect(restoredPreviewStatus).toBe(200);
  await page.getByRole("textbox", { name: "Message" }).fill("Inspect the selected image.");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(attachments).toHaveCount(0);
  await expect(page.getByRole("button", {
    name: "Attach images, documents, or spreadsheets",
  }))
    .toBeEnabled({ timeout: 5_000 });
  await expect.poll(async () =>
    stat(selectedTempPath).then(() => true, () => false)).toBe(false);
  const sentAttachments = page.locator(".sent-attachments").filter({
    has: page.getByRole("button", {
      name: "Preview attachment preview.png",
    }),
  });
  const sentPreview = sentAttachments.locator("img");
  await expect(sentAttachments).toBeVisible();
  await expect(sentAttachments.getByText("PNG image · 68 B", {
    exact: true,
  })).toBeVisible();
  await expect.poll(() => sentPreview.evaluate((element) => {
    const image = element as HTMLImageElement;
    return { complete: image.complete, width: image.naturalWidth };
  })).toEqual({ complete: true, width: 1 });
  await resizeWindow(520, 720);
  const sentBounds = await sentAttachments.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return {
      left: bounds.left,
      right: bounds.right,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      viewportWidth: window.innerWidth,
    };
  });
  expect(sentBounds.left).toBeGreaterThanOrEqual(0);
  expect(sentBounds.right).toBeLessThanOrEqual(sentBounds.viewportWidth + 1);
  expect(sentBounds.scrollWidth).toBeLessThanOrEqual(
    sentBounds.clientWidth + 1,
  );
  await resizeWindow(1440, 920);
  const retainedPath = join(
    testDirectory,
    "data",
    "conversation-attachments",
    chosenId!,
    `${chosenId}.png`,
  );
  await expect.poll(async () =>
    stat(retainedPath).then(() => true, () => false)).toBe(true);

  await page.reload();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible({
    timeout: 10_000,
  });
  await expect(sentAttachments).toBeVisible();
  await expect.poll(() => sentPreview.evaluate((element) => {
    const image = element as HTMLImageElement;
    return { complete: image.complete, width: image.naturalWidth };
  })).toEqual({ complete: true, width: 1 });
  const closeEnvironment = page.getByRole("button", {
    name: "Close environment summary",
  });
  if (await closeEnvironment.isVisible()) await closeEnvironment.click();
  const sentScreenshotPath = testInfo.outputPath(
    "sent-attachment-persisted-1440x920.png",
  );
  await page.screenshot({ animations: "disabled", path: sentScreenshotPath });
  await testInfo.attach("sent-attachment-persisted-1440x920", {
    path: sentScreenshotPath,
    contentType: "image/png",
  });

  const imageBytes = [...await readFile(attachmentImagePath)];
  await page.getByRole("textbox", { name: "Message" }).evaluate((textarea, bytes) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(bytes)], "pasted.png", { type: "image/png" }));
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: transfer });
    textarea.dispatchEvent(event);
  }, imageBytes);
  await expect(attachments.getByText("pasted.png", { exact: true })).toBeVisible();
  const pendingPastedAttachment = attachments.locator(
    '[data-attachment-pending="true"]',
  ).filter({ hasText: "pasted.png" });
  await expect(pendingPastedAttachment).toBeVisible();
  await expect(pendingPastedAttachment.locator("img")).toHaveCount(0);
  const pastedPreview = attachments.locator("img");
  await expect(pastedPreview).toHaveCount(1);
  await expect(pendingPastedAttachment).toHaveCount(0);
  await expectImagePreviewSettled(pastedPreview);
  const pastedSource = await pastedPreview.getAttribute("src");
  const pastedId = pastedSource?.split("/").at(-1);
  const pastedTempPath = await stagedAttachmentPath(pastedId, "png");
  await attachments.getByRole("button", { name: "Remove attachment pasted.png" }).click();
  await expect.poll(async () => stat(pastedTempPath).then(() => true, () => false)).toBe(false);

  const documentBytes = [...await readFile(attachmentDocumentPath)];
  await page.locator(".composer").evaluate((composer, bytes) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(bytes)], "dropped.pdf", { type: "application/pdf" }));
    composer.dispatchEvent(new DragEvent("drop", {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
    }));
  }, documentBytes);
  await expect(attachments.getByText("dropped.pdf", { exact: true })).toBeVisible();
  await expect(attachments.getByText(
    `PDF document · ${(await stat(attachmentDocumentPath)).size} B`,
    { exact: true },
  )).toBeVisible();
  await attachments.getByRole("button", { name: "Remove attachment dropped.pdf" }).click();

  await electronApp.evaluate(({ dialog }, path) => {
    Reflect.set(dialog, "showOpenDialog", async () => ({
      canceled: false,
      filePaths: [path],
      bookmarks: [],
    }));
  }, malformedAttachmentPath);
  await page.getByRole("button", {
    name: "Attach images, documents, or spreadsheets",
  }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Attachment content does not match its safe file type.",
  );
  await page.getByRole("button", { name: "Dismiss error" }).click();
  await expect(attachments).toHaveCount(0);

  await electronApp.evaluate(({ dialog }, path) => {
    Reflect.set(dialog, "showOpenDialog", async () => ({
      canceled: false,
      filePaths: [path],
      bookmarks: [],
    }));
  }, attachmentImagePath);
  await page.getByRole("button", {
    name: "Attach images, documents, or spreadsheets",
  }).click();
  const unsentPreview = attachments.locator("img");
  await expectImagePreviewSettled(unsentPreview);
  const unsentSource = await unsentPreview.getAttribute("src");
  const unsentId = unsentSource?.split("/").at(-1);
  const unsentTempPath = await stagedAttachmentPath(unsentId, "png");
  await expect.poll(async () => stat(unsentTempPath).then(() => true, () => false)).toBe(true);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect.poll(async () => stat(unsentTempPath).then(() => true, () => false)).toBe(false);
  await page.getByRole("button", { name: "Workspace", exact: true }).click();

  const shell = page.locator(".app-shell");
  const beforeRuntimeGeneration = await shell.getAttribute(
    "data-runtime-generation",
  );
  expect(beforeRuntimeGeneration).toMatch(/^[0-9a-f-]{36}$/iu);
  const restoreRuntimeRecoveryConsent = await installRuntimeRecoveryConsent(
    electronApp,
  );
  let recoveryOperationError: unknown = null;
  let recoveryOperationFailed = false;
  try {
    await electronApp.evaluate(() => {
      const runtime = Reflect.get(
        globalThis,
        "__inertiaTestRuntime",
      ) as { crash: () => unknown } | undefined;
      if (!runtime) {
        throw new Error("The test runtime supervisor is unavailable");
      }
      runtime.crash();
    });
    await expect.poll(async () => {
      const [connectionStatus, runtimeGeneration] = await Promise.all([
        shell.getAttribute("data-connection-status", { timeout: 500 })
          .catch(() => null),
        shell.getAttribute("data-runtime-generation", { timeout: 500 })
          .catch(() => null),
      ]);
      return connectionStatus === "online"
        && runtimeGeneration !== null
        && runtimeGeneration !== beforeRuntimeGeneration;
    }, { timeout: 20_000 }).toBe(true);
  } catch (error) {
    recoveryOperationFailed = true;
    recoveryOperationError = error;
  }
  try {
    await restoreRuntimeRecoveryConsent();
  } catch (recoveryConsentError) {
    if (recoveryOperationFailed) {
      throw new AggregateError(
        [recoveryOperationError, recoveryConsentError],
        "Runtime recovery and recovery-consent restoration both failed.",
      );
    }
    throw recoveryConsentError;
  }
  if (recoveryOperationFailed) throw recoveryOperationError;
  await expect(sentAttachments).toBeVisible();
  await expect.poll(() => sentPreview.evaluate((element) => {
    const image = element as HTMLImageElement;
    return { complete: image.complete, width: image.naturalWidth };
  })).toEqual({ complete: true, width: 1 });

  ({ electronApp, page } = await app.restart());
  await resizeWindow(1440, 920);
  const restartedAttachments = page.locator(".sent-attachments").filter({
    has: page.getByRole("button", {
      name: "Preview attachment preview.png",
    }),
  });
  const restartedPreview = restartedAttachments.locator("img");
  await expect(restartedAttachments).toBeVisible();
  await expect.poll(() => restartedPreview.evaluate((element) => {
    const image = element as HTMLImageElement;
    return { complete: image.complete, width: image.naturalWidth };
  })).toEqual({ complete: true, width: 1 });
  await expect.poll(async () =>
    stat(retainedPath).then(() => true, () => false)).toBe(true);

  expect(rendererErrors).toEqual([]);
});
