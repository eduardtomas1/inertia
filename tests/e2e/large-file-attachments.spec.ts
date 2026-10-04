// @inertia-e2e-resource isolated
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";

import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { setAppearanceInPlace } from "./support/appearance";
import { expectComposerEndsAtDock } from "./support/layout-assertions";

const FIXED_NOW = Date.parse("2026-09-30T16:20:00.000Z");
const LONG_LOG_NAME = "2026-09-30-production-incident-timeline-and-remediation-notes-final.log";
const BINARY_NAME = "build-cache-darwin-arm64.tar.zst";
const PASTED_NAME = `pasted-text-${FIXED_NOW}.txt`;

function readablePdf(): number[] {
  const stream = "BT /F1 22 Tf 72 720 Td (Quarterly roadmap) Tj ET";
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
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return [...Buffer.from(pdf, "ascii")];
}

function incidentLog(): string {
  const lines: string[] = [];
  for (let index = 0; lines.join("\n").length < 1_200_000; index += 1) {
    const second = String(index % 60).padStart(2, "0");
    lines.push(`2026-09-30T14:${String(Math.floor(index / 60) % 60).padStart(2, "0")}:${second}Z INFO  api-gateway request_id=${(index * 7919).toString(16).padStart(8, "0")} route=/v1/attachments status=200 duration_ms=${(index * 37) % 900}`);
  }
  return lines.join("\n");
}

async function capture(page: Page, info: TestInfo, name: string): Promise<void> {
  const path = info.outputPath(`${name}.png`);
  await page.mouse.move(0, 0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.screenshot({ path, animations: "disabled" });
  await info.attach(name, { path, contentType: "image/png" });
}

function composer(page: Page): Locator {
  return page.getByRole("region", { name: "Message composer" });
}

async function expectComposerLayoutHolds(app: AppFixture): Promise<void> {
  await app.expectNoViewportOverflow();
  await expectComposerEndsAtDock(composer(app.page));
  const layout = await composer(app.page).evaluate((element) => {
    const list = element.querySelector<HTMLElement>(".composer-attachments");
    return {
      overflow: list ? list.scrollWidth - list.clientWidth : 0,
      nested: [...element.querySelectorAll("button")]
        .filter((button) => button.parentElement?.closest("button")).length,
      chipsOutside: [...element.querySelectorAll<HTMLElement>(".composer-attachment")]
        .filter((chip) => {
          const bounds = chip.getBoundingClientRect();
          const dock = element.getBoundingClientRect();
          return bounds.left < dock.left - 0.5 || bounds.right > dock.right + 0.5;
        }).length,
    };
  });
  expect(layout.overflow).toBeLessThanOrEqual(1);
  expect(layout.nested).toBe(0);
  expect(layout.chipsOutside).toBe(0);
}

async function dropFiles(page: Page, files: { name: string; type: string; bytes?: number[]; text?: string; image?: boolean; size?: number }[]): Promise<void> {
  await page.locator(".composer").evaluate(async (element, entries) => {
    const transfer = new DataTransfer();
    for (const entry of entries) {
      if (entry.image) {
        const canvas = new OffscreenCanvas(320, 200);
        const context = canvas.getContext("2d")!;
        const gradient = context.createLinearGradient(0, 0, 320, 200);
        gradient.addColorStop(0, "#3b5bdb");
        gradient.addColorStop(1, "#12b886");
        context.fillStyle = gradient;
        context.fillRect(0, 0, 320, 200);
        context.fillStyle = "#ffffffcc";
        context.fillRect(24, 28, 180, 18);
        context.fillRect(24, 60, 260, 96);
        transfer.items.add(new File([await canvas.convertToBlob({ type: "image/png" })], entry.name, { type: entry.type }));
      } else if (entry.size !== undefined) {
        transfer.items.add(new File([new Uint8Array(entry.size)], entry.name, { type: entry.type }));
      } else {
        transfer.items.add(new File([entry.text ?? new Uint8Array(entry.bytes ?? [])], entry.name, { type: entry.type }));
      }
    }
    element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, files);
}

async function pasteText(page: Page, text: string): Promise<void> {
  await page.getByRole("textbox", { name: "Message" }).evaluate((element, value) => {
    const transfer = new DataTransfer();
    transfer.setData("text/plain", value);
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: transfer });
    element.dispatchEvent(event);
  }, text);
}

async function holdCommits(app: AppFixture): Promise<void> {
  await app.electronApp.evaluate(({ ipcMain }) => {
    const handlers = Reflect.get(ipcMain, "_invokeHandlers") as Map<string, (...args: unknown[]) => unknown> | undefined;
    const original = handlers?.get("inertia:commit-attachment-import");
    if (!handlers || !original) throw new Error("The attachment commit handler is unavailable.");
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    Reflect.set(globalThis, "releaseAttachmentCommits", () => {
      handlers.set("inertia:commit-attachment-import", original);
      release();
    });
    handlers.set("inertia:commit-attachment-import", async (...args: unknown[]) => {
      await gate;
      return await original(...args);
    });
  });
}

async function releaseCommits(app: AppFixture): Promise<void> {
  await app.electronApp.evaluate(() => {
    (Reflect.get(globalThis, "releaseAttachmentCommits") as () => void)();
  });
}

let app!: AppFixture;

test.beforeAll(async () => {
  app = await createAppFixture({ name: "large-file-attachments", initialState: "conversation" });
  await app.page.clock.setFixedTime(FIXED_NOW);
});

test.afterAll(async () => {
  await app.close();
});

test("composer holds mixed files, a folded paste, an upload in flight and a rejected file", async ({ browserName: _browserName }, info) => {
  const page = app.page;
  await app.resizeWindow(1440, 920);
  await setAppearanceInPlace(app, "dark");
  await dropFiles(page, [
    { name: "dashboard-review.png", type: "image/png", image: true },
    { name: "q4-roadmap.pdf", type: "application/pdf", bytes: readablePdf() },
    { name: "release-notes.md", type: "text/markdown", text: "# Release notes\n\n- Streamed attachments\n- Retained file paths\n" },
    { name: BINARY_NAME, type: "application/zstd", bytes: [40, 181, 47, 253, 4, 0, 1, 2, 3, 4, 5, 6, 7, 8] },
    { name: LONG_LOG_NAME, type: "text/plain", text: incidentLog() },
  ]);
  const attachments = page.getByRole("list", { name: "Attachments", exact: true });
  for (const name of ["dashboard-review.png", "q4-roadmap.pdf", "release-notes.md", BINARY_NAME, LONG_LOG_NAME]) {
    await expect(attachments.getByRole("button", { name: `Preview attachment ${name}` })).toBeEnabled();
  }
  const binaryChip = attachments.getByRole("listitem").filter({ hasText: BINARY_NAME });
  await expect(binaryChip).toContainText("File · 14 B");
  await expect(binaryChip.locator("svg.lucide-file")).toHaveCount(1);
  await expect(attachments.getByText(LONG_LOG_NAME, { exact: true })).toHaveAttribute("title", LONG_LOG_NAME);

  await pasteText(page, `${"const retained = attachment.path;\n".repeat(1_200)}`);
  await expect(attachments.getByRole("button", { name: `Preview attachment ${PASTED_NAME}` })).toBeEnabled();
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("");
  await page.getByRole("textbox", { name: "Message" }).fill("Compare the incident log with the roadmap and the build cache.");

  await expectComposerLayoutHolds(app);
  await capture(page, info, "composer-attachments-dark-wide");
  await setAppearanceInPlace(app, "light");
  await capture(page, info, "composer-attachments-light-wide");
  await app.resizeWindow(1000, 800);
  await expectComposerLayoutHolds(app);
  await capture(page, info, "composer-attachments-light-narrow");
  await setAppearanceInPlace(app, "dark");
  await capture(page, info, "composer-attachments-dark-narrow");
  await app.resizeWindow(760, 600);
  await expectComposerLayoutHolds(app);
  await capture(page, info, "composer-attachments-dark-760x600");

  await app.resizeWindow(1440, 920);
  await holdCommits(app);
  try {
    await dropFiles(page, [{ name: "telemetry-export.parquet", type: "", bytes: [80, 65, 82, 49, 0, 0, 80, 65, 82, 49] }]);
    const pending = attachments.getByRole("listitem").filter({ hasText: "telemetry-export.parquet" });
    await expect(pending).toHaveAttribute("data-attachment-pending", "true");
    await expect(composer(page).getByRole("status").filter({ hasText: "Adding attachments…" })).toBeVisible();
    await pending.evaluate((element) => element.scrollIntoView({ block: "nearest" }));
    await expectComposerLayoutHolds(app);
    await capture(page, info, "composer-upload-pending-dark-wide");
    await setAppearanceInPlace(app, "light");
    await capture(page, info, "composer-upload-pending-light-wide");
  } finally {
    await releaseCommits(app);
  }
  await expect(attachments.getByRole("button", { name: "Preview attachment telemetry-export.parquet" })).toBeEnabled();

  await dropFiles(page, [{ name: "screen-recording.mov", type: "video/quicktime", size: 50 * 1024 * 1024 + 1 }]);
  const rejection = page.getByRole("alert").filter({ hasText: "50 MiB" });
  await expect(rejection).toContainText("No files were attached.");
  await expect(attachments.getByText("screen-recording.mov", { exact: true })).toHaveCount(0);
  await expectComposerLayoutHolds(app);
  await capture(page, info, "composer-rejected-light-wide");
  await setAppearanceInPlace(app, "dark");
  await capture(page, info, "composer-rejected-dark-wide");
  await rejection.getByRole("button", { name: /^Dismiss/u }).click();
  await expect(rejection).toHaveCount(0);
  expect(app.rendererErrors).toEqual([]);
});

test("previews a truncated text file with a visible notice", async ({ browserName: _browserName }, info) => {
  const page = app.page;
  await app.resizeWindow(1440, 920);
  await setAppearanceInPlace(app, "dark");
  const attachments = page.getByRole("list", { name: "Attachments", exact: true });
  const trigger = attachments.getByRole("button", { name: `Preview attachment ${LONG_LOG_NAME}` });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: LONG_LOG_NAME });
  await expect(dialog.getByLabel(`Text preview of ${LONG_LOG_NAME}`)).toBeVisible();
  const notice = dialog.getByRole("status").filter({ hasText: "Showing the first 1 MiB" });
  await expect(notice).toHaveCount(1);
  await app.expectNoViewportOverflow();
  await capture(page, info, "preview-truncated-dark-wide");
  await setAppearanceInPlace(app, "light");
  await capture(page, info, "preview-truncated-light-wide");
  await app.resizeWindow(760, 600);
  await app.expectNoViewportOverflow();
  await setAppearanceInPlace(app, "dark");
  await capture(page, info, "preview-truncated-dark-760x600");
  const unobscured = await notice.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
    return bounds.height > 0 && Boolean(hit && element.contains(hit));
  });
  expect(unobscured).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(app.rendererErrors).toEqual([]);
});

test("previews an opaque file as stored, not as a failure", async ({ browserName: _browserName }, info) => {
  const page = app.page;
  await app.resizeWindow(1440, 920);
  await setAppearanceInPlace(app, "dark");
  const attachments = page.getByRole("list", { name: "Attachments", exact: true });
  const trigger = attachments.getByRole("button", { name: `Preview attachment ${BINARY_NAME}` });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: BINARY_NAME });
  await expect(dialog).toContainText("File · 14 B");
  await expect(dialog.getByText("No preview for this file type", { exact: true })).toBeVisible();
  await expect(dialog.getByText(/agent can read/u)).toBeVisible();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await capture(page, info, "preview-file-dark-wide");
  await setAppearanceInPlace(app, "light");
  await capture(page, info, "preview-file-light-wide");
  await app.resizeWindow(760, 600);
  await setAppearanceInPlace(app, "dark");
  await capture(page, info, "preview-file-dark-760x600");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(app.rendererErrors).toEqual([]);
});

test("storage settings state the temporary budget the registry enforces", async ({ browserName: _browserName }, info) => {
  const page = app.page;
  await app.resizeWindow(1440, 920);
  await setAppearanceInPlace(app, "dark");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: /^Data(?: \d+)?$/u }).click();
  const card = page.locator(".attachment-storage-setting");
  await expect(card.getByRole("combobox", { name: "Attachment storage limit" })).toHaveValue("16");
  await card.evaluate((element) => element.scrollIntoView({ block: "start" }));
  await app.expectNoViewportOverflow();
  await capture(page, info, "storage-settings-dark-wide");
  await setAppearanceInPlace(app, "light");
  await capture(page, info, "storage-settings-light-wide");
  await app.resizeWindow(1000, 800);
  await card.evaluate((element) => element.scrollIntoView({ block: "start" }));
  await app.expectNoViewportOverflow();
  await capture(page, info, "storage-settings-light-narrow");
  await setAppearanceInPlace(app, "dark");
  await capture(page, info, "storage-settings-dark-narrow");
  await expect(card).toContainText("temporary disk budget of 16 GiB and 1,024 files");
  expect(app.rendererErrors).toEqual([]);
});
