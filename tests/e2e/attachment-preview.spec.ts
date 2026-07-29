import { expect, test } from "@playwright/test";
import { basename, join } from "node:path";
import { readFile, stat, writeFile } from "node:fs/promises";

import {
  createAppFixture,
  type AppFixture,
} from "./support/app-fixture";

let app!: AppFixture;
let electronApp!: AppFixture["electronApp"];
let page!: AppFixture["page"];

function readablePdf(): Buffer {
  const stream = "BT /F1 22 Tf 72 720 Td (Inertia attachment preview) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
      + "/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream, "ascii")} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, "ascii"));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, "ascii");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  pdf += offsets
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  pdf += `startxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "ascii");
}

test.beforeAll(async () => {
  app = await createAppFixture({
    name: "attachment-preview",
    initialState: "conversation",
  });
  electronApp = app.electronApp;
  page = app.page;
});

test.afterAll(async () => {
  await app.close();
});

test("opens secure image and Linux-style clipboard PDF previews", async ({
  browserName: _browserName,
}, testInfo) => {
  const pdfBytes = readablePdf();
  await writeFile(app.attachmentDocumentPath, pdfBytes);
  await app.resizeWindow(1_280, 820);
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
  });

  await electronApp.evaluate(({ dialog }, path) => {
    Reflect.set(dialog, "showOpenDialog", async () => ({
      canceled: false,
      filePaths: [path],
      bookmarks: [],
    }));
  }, app.attachmentImagePath);
  await page.getByRole("button", { name: "Attach images or documents" }).click();

  const attachments = page.getByRole("list", { name: "Attachments" });
  const imageTrigger = attachments.getByRole("button", {
    name: "Preview attachment preview.png",
  });
  await expect(imageTrigger).toBeVisible();
  const imageSource = await attachments.locator("img").getAttribute("src");
  const imageId = imageSource?.split("/").at(-1);
  expect(await page.evaluate(async (id) => {
    try {
      await window.inertia.openAttachmentExternally(id);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }, imageId!)).toContain("PDF attachment is unavailable");
  await imageTrigger.click();

  const imageDialog = page.getByRole("dialog", { name: "preview.png" });
  const imagePreview = imageDialog.getByRole("img", { name: "preview.png" });
  await expect(imageDialog).toBeVisible();
  await expect(imagePreview).toBeVisible();
  await expect.poll(() => imagePreview.evaluate((element) => {
    const image = element as HTMLImageElement;
    return { complete: image.complete, width: image.naturalWidth };
  })).toEqual({ complete: true, width: 1 });
  await expect(imageDialog.getByRole("button", {
    name: "Close preview of preview.png",
  })).toBeFocused();
  const imageGeometry = await imagePreview.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return {
      left: bounds.left,
      top: bounds.top,
      right: bounds.right,
      bottom: bounds.bottom,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      objectFit: getComputedStyle(element).objectFit,
    };
  });
  expect(imageGeometry.objectFit).toBe("contain");
  expect(imageGeometry.left).toBeGreaterThanOrEqual(0);
  expect(imageGeometry.top).toBeGreaterThanOrEqual(0);
  expect(imageGeometry.right).toBeLessThanOrEqual(imageGeometry.viewportWidth);
  expect(imageGeometry.bottom).toBeLessThanOrEqual(imageGeometry.viewportHeight);
  const lightScreenshot = testInfo.outputPath("image-preview-light.png");
  await page.screenshot({ animations: "disabled", path: lightScreenshot });
  await testInfo.attach("image-preview-light", {
    path: lightScreenshot,
    contentType: "image/png",
  });

  await page.keyboard.press("Escape");
  await expect(imageDialog).toHaveCount(0);
  await expect(imageTrigger).toBeFocused();
  await attachments.getByRole("button", {
    name: "Remove attachment preview.png",
  }).click();
  await expect(attachments.getByText("preview.png", { exact: true }))
    .toHaveCount(0);

  // Linux clipboard managers commonly omit File.type. The privileged import
  // boundary derives PDF type from the safe leaf name and verifies its bytes.
  await page.getByRole("textbox", { name: "Message" }).evaluate(
    (textarea, bytes) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(
        [new Uint8Array(bytes)],
        "linux-clipboard.pdf",
        { type: "" },
      ));
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: transfer });
      textarea.dispatchEvent(event);
    },
    [...pdfBytes],
  );
  const pdfTrigger = attachments.getByRole("button", {
    name: "Preview attachment linux-clipboard.pdf",
  });
  await expect(pdfTrigger).toBeVisible();
  await pdfTrigger.click();

  const pdfDialog = page.getByRole("dialog", { name: "linux-clipboard.pdf" });
  const pdfFrame = pdfDialog.getByTitle(
    "PDF preview: linux-clipboard.pdf",
  );
  await expect(pdfFrame).toBeVisible();
  const pdfClose = pdfDialog.getByRole("button", {
    name: "Close preview of linux-clipboard.pdf",
  });
  await expect(pdfClose).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(pdfDialog.getByRole("button", {
    name: "Open in PDF app",
  })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(pdfClose).toBeFocused();
  const pdfSource = await pdfFrame.getAttribute("src");
  expect(pdfSource).toMatch(
    /^inertia:\/\/bundle\/attachment-preview\/[0-9a-f-]{36}$/u,
  );
  expect(pdfSource).not.toContain(app.testDirectory);
  const pdfResponse = await electronApp.evaluate(
    async ({ net }, url) => {
      const response = await net.fetch(url);
      return {
        status: response.status,
        type: response.headers.get("content-type"),
        disposition: response.headers.get("content-disposition"),
        prefix: Buffer.from(await response.arrayBuffer())
          .subarray(0, 8)
          .toString("ascii"),
      };
    },
    pdfSource!,
  );
  expect(pdfResponse).toEqual({
    status: 200,
    type: "application/pdf",
    disposition: null,
    prefix: "%PDF-1.4",
  });

  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await app.resizeWindow(520, 700);
  const pdfGeometry = await pdfDialog.evaluate((element) => {
    const dialog = element.getBoundingClientRect();
    const frame = element.querySelector("iframe")?.getBoundingClientRect();
    return {
      dialogLeft: dialog.left,
      dialogTop: dialog.top,
      dialogRight: dialog.right,
      dialogBottom: dialog.bottom,
      frameHeight: frame?.height ?? 0,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    };
  });
  expect(pdfGeometry.dialogLeft).toBeGreaterThanOrEqual(0);
  expect(pdfGeometry.dialogTop).toBeGreaterThanOrEqual(0);
  expect(pdfGeometry.dialogRight).toBeLessThanOrEqual(pdfGeometry.viewportWidth);
  expect(pdfGeometry.dialogBottom).toBeLessThanOrEqual(pdfGeometry.viewportHeight);
  expect(pdfGeometry.frameHeight).toBeGreaterThan(300);
  const darkScreenshot = testInfo.outputPath("pdf-preview-dark-narrow.png");
  await page.screenshot({ animations: "disabled", path: darkScreenshot });
  await testInfo.attach("pdf-preview-dark-narrow", {
    path: darkScreenshot,
    contentType: "image/png",
  });

  await electronApp.evaluate(({ shell }) => {
    Reflect.set(globalThis, "__openedAttachmentPath", null);
    Reflect.set(shell, "openPath", async (path: string) => {
      Reflect.set(globalThis, "__openedAttachmentPath", path);
      return "";
    });
  });
  await pdfDialog.getByRole("button", { name: "Open in PDF app" }).click();
  await expect.poll(() => electronApp.evaluate(() =>
    Reflect.get(globalThis, "__openedAttachmentPath") as string | null))
    .not.toBeNull();
  const openedPath = await electronApp.evaluate(() =>
    Reflect.get(globalThis, "__openedAttachmentPath") as string);
  expect(basename(openedPath)).toMatch(
    /^[0-9a-f-]{36}\.pdf$/u,
  );
  expect(openedPath).toContain(join("inertia-attachments", ""));
  expect(await pdfDialog.textContent()).not.toContain(openedPath);

  const pdfTempPath = openedPath;
  const selectedBytes = await readFile(pdfTempPath);
  const replacement = Buffer.from(selectedBytes);
  replacement[replacement.length - 1] =
    replacement[replacement.length - 1]! ^ 0x01;
  await writeFile(pdfTempPath, replacement);
  expect(await electronApp.evaluate(
    async ({ net }, url) => (await net.fetch(url)).status,
    pdfSource!,
  )).toBe(404);

  await pdfDialog.getByRole("button", { name: "Open in PDF app" }).click();
  await expect(pdfDialog.getByRole("alert")).toHaveText(
    "The validated copy could not be opened.",
  );
  await page.keyboard.press("Escape");
  await attachments.getByRole("button", {
    name: "Remove attachment linux-clipboard.pdf",
  }).click();
  await expect.poll(async () =>
    stat(pdfTempPath).then(() => true, () => false)).toBe(false);
  expect(await electronApp.evaluate(
    async ({ net }, url) => (await net.fetch(url)).status,
    pdfSource!,
  )).toBe(404);
  expect(app.rendererErrors).toEqual([]);
});
