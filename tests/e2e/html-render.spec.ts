// @inertia-e2e-resource isolated
import { expect, test, type Frame, type Page, type TestInfo } from "@playwright/test";
import { createAppFixture } from "./support/app-fixture";
import {
  HTML_RENDER_ANSWER,
  HTML_RENDER_HEADING,
  HTML_RENDER_LINK,
  HTML_RENDER_TABLE_TITLE,
  HTML_RENDER_TITLE,
  seedHtmlRenderConversation,
} from "./support/html-render-fixture";

const INLINE_FRAME = `[data-testid="html-render-frame"][title="${HTML_RENDER_TITLE}"]`;

async function inlineFrame(page: Page): Promise<Frame> {
  const handle = await page.locator(INLINE_FRAME).elementHandle();
  const frame = await handle?.contentFrame();
  await handle?.dispose();
  if (!frame) throw new Error("The visual reply frame has no document.");
  return frame;
}

/** The chat canvas color as the browser resolves it, in the same rgb() form as a computed background. */
async function canvasColor(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.backgroundColor = "var(--conversation-canvas-surface)";
    document.body.append(probe);
    const color = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return color;
  });
}

async function frameAppearance(frame: Frame): Promise<{ background: string; colorScheme: string }> {
  return await frame.evaluate(() => {
    const styles = getComputedStyle(document.documentElement);
    return { background: styles.backgroundColor, colorScheme: styles.colorScheme };
  });
}

async function expectThemedLike(page: Page, scheme: "light" | "dark"): Promise<string> {
  await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
  const canvas = await canvasColor(page);
  const frame = await inlineFrame(page);
  await expect.poll(() => frameAppearance(frame)).toEqual({ background: canvas, colorScheme: scheme });
  await expect(page.locator(INLINE_FRAME)).toHaveCSS("color-scheme", scheme);
  return canvas;
}

async function capture(page: Page, info: TestInfo, name: string, label: string): Promise<void> {
  const path = info.outputPath(name);
  await page.screenshot({ path, animations: "disabled" });
  await info.attach(label, { path, contentType: "image/png" });
}

async function chooseTheme(page: Page, label: "Light" | "Dark" | "System"): Promise<void> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await page.getByRole("radio", { name: label, exact: true }).click();
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
}

test("shows a sandboxed, themed visual reply above the answer and keeps it across reloads", async ({ browserName: _browserName }, info) => {
  test.setTimeout(180_000);
  const app = await createAppFixture({
    name: "html-render",
    initialState: "conversation",
    beforeLaunch: seedHtmlRenderConversation,
  });
  const { page } = app;
  try {
    await app.resizeWindow(1280, 960);
    await app.electronApp.evaluate(({ shell }) => {
      const opened: string[] = [];
      Reflect.set(globalThis, "__inertiaHtmlRenderOpened", opened);
      Reflect.set(shell, "openExternal", async (url: string) => { opened.push(url); });
    });

    // Both renders stack in message order above the final answer of their turn.
    const layer = page.locator('.turn-html-renders[data-turn-layer="html-renders"]');
    await expect(layer).toBeVisible();
    const figure = layer.getByRole("figure", { name: HTML_RENDER_TITLE, exact: true });
    const table = layer.getByRole("figure", { name: HTML_RENDER_TABLE_TITLE, exact: true });
    await expect(layer.getByTestId("html-render")).toHaveCount(2);
    await expect(layer.getByTestId("html-render").first()).toHaveAccessibleName(HTML_RENDER_TITLE);
    // "ready" here is reached through the frame's size message, which the
    // renderer accepts only from that frame's window with origin "null".
    await expect(figure).toHaveAttribute("data-html-render-state", "ready");
    await expect(table).toHaveAttribute("data-html-render-state", "ready");
    const answer = page.getByText(HTML_RENDER_ANSWER);
    await expect(answer).toBeVisible();
    const [tableBox, answerBox] = await Promise.all([table.boundingBox(), answer.boundingBox()]);
    expect(tableBox!.y + tableBox!.height).toBeLessThanOrEqual(answerBox!.y);

    const frameElement = page.locator(INLINE_FRAME);
    await expect(frameElement).toHaveAttribute("sandbox", "allow-scripts");
    await expect(frameElement).toHaveAttribute("referrerpolicy", "no-referrer");
    const content = page.frameLocator(INLINE_FRAME);
    await expect(content.getByRole("heading", { name: HTML_RENDER_HEADING })).toBeVisible();

    // The frame fits the page's own height instead of the seeded 320 px.
    const frame = await inlineFrame(page);
    const contentHeight = await frame.evaluate(() => Math.ceil(document.documentElement.getBoundingClientRect().height));
    await expect.poll(async () => Math.round((await frameElement.boundingBox())!.height)).toBe(contentHeight);
    expect(contentHeight).toBeGreaterThanOrEqual(80);
    expect(contentHeight).toBeLessThanOrEqual(2_000);
    expect(contentHeight).not.toBe(320);

    const darkCanvas = await expectThemedLike(page, "dark");
    await page.mouse.move(0, 0);
    await capture(page, info, "inline-dark.png", "Visual reply inline · dark");

    // A link click goes to the desktop browser; the frame itself never navigates.
    const frameUrl = frame.url();
    expect(frameUrl).toMatch(/^[a-z-]+:\/\/render\/[0-9a-f-]{36}$/u);
    await content.getByRole("link", { name: "Row guidelines" }).click();
    await expect.poll(() => app.electronApp.evaluate(() =>
      Reflect.get(globalThis, "__inertiaHtmlRenderOpened") as string[])).toEqual([HTML_RENDER_LINK]);
    expect(frame.url()).toBe(frameUrl);
    await expect(content.getByRole("heading", { name: HTML_RENDER_HEADING })).toBeVisible();

    // Full size: a modal second frame of the same page; Escape returns focus.
    const openButton = figure.getByRole("button", { name: `Open ${HTML_RENDER_TITLE} full size`, exact: true });
    await openButton.click();
    const dialog = page.getByRole("dialog", { name: HTML_RENDER_TITLE, exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute("aria-modal", "true");
    await expect(dialog).toHaveAttribute("data-testid", "html-render-dialog");
    await expect(dialog.getByTestId("html-render-dialog-frame")).toHaveAttribute("sandbox", "allow-scripts");
    await expect(page.frameLocator('[data-testid="html-render-dialog-frame"]')
      .getByRole("heading", { name: HTML_RENDER_HEADING })).toBeVisible();
    await expect(dialog.getByRole("button", { name: `Close ${HTML_RENDER_TITLE}`, exact: true })).toBeFocused();
    // The dialog shrink-wraps the page (plus the frame's 16 px vertical padding) instead of filling the window.
    const dialogFrameElement = dialog.getByTestId("html-render-dialog-frame");
    const dialogFrame = await (await dialogFrameElement.elementHandle())?.contentFrame();
    const dialogContentHeight = await dialogFrame!.evaluate(() => Math.ceil(document.documentElement.getBoundingClientRect().height));
    await expect.poll(async () => Math.round((await dialogFrameElement.boundingBox())!.height))
      .toBe(Math.max(240, dialogContentHeight + 32));
    expect((await dialog.boundingBox())!.height).toBeLessThanOrEqual(await page.evaluate(() => window.innerHeight * 0.9));
    await capture(page, info, "full-size-dialog-dark.png", "Visual reply full size · dark");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(openButton).toBeFocused();

    // Settings replaces the chat, so the page remounts there and is themed by
    // its URL fragment. Following the OS appearance then flips the theme while
    // the page stays mounted: it must arrive by message, without a reload.
    await page.emulateMedia({ colorScheme: "dark" });
    await chooseTheme(page, "System");
    await expectThemedLike(page, "dark");
    const liveFrame = await inlineFrame(page);
    await liveFrame.evaluate(() => Reflect.set(window, "__inertiaE2eMarker", "kept"));
    await page.emulateMedia({ colorScheme: "light" });
    const lightCanvas = await expectThemedLike(page, "light");
    expect(lightCanvas).not.toBe(darkCanvas);
    expect(await liveFrame.evaluate(() => Reflect.get(window, "__inertiaE2eMarker"))).toBe("kept");
    expect(await (await inlineFrame(page)).evaluate(() => Reflect.get(window, "__inertiaE2eMarker"))).toBe("kept");
    expect(liveFrame.url()).toBe(frameUrl);
    await expect(content.getByRole("heading", { name: HTML_RENDER_HEADING })).toBeVisible();
    await page.mouse.move(0, 0);
    await capture(page, info, "inline-light.png", "Visual reply inline · light");
    expect(app.rendererErrors).toEqual([]);

    // The page is stored, not held in memory: it returns after a reload.
    await page.reload();
    await page.locator('.app-shell[data-connection-status="online"]').waitFor();
    await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
    await expect(figure).toHaveAttribute("data-html-render-state", "ready");
    await expect(content.getByRole("heading", { name: HTML_RENDER_HEADING })).toBeVisible();
    await expectThemedLike(page, "light");

    // Probes from inside the page: an opaque origin with no app bridge, no
    // network or app-scheme reads, no popups and no referrer.
    const probe = await (await inlineFrame(page)).evaluate(async () => {
      let parentDocument = "readable";
      try {
        void window.parent.document.title;
      } catch {
        parentDocument = "blocked";
      }
      const scheme = location.protocol;
      const fetched = await fetch(`${scheme}//bundle/index.html`).then(() => "resolved", () => "rejected");
      const image = (src: string): Promise<string> => new Promise((resolve) => {
        const element = new Image();
        element.onload = () => resolve("load");
        element.onerror = () => resolve("error");
        element.src = src;
        setTimeout(() => resolve("timeout"), 5_000);
      });
      return {
        framed: window.parent !== window,
        parentDocument,
        bridge: typeof (window as unknown as { inertia?: unknown }).inertia,
        fetched,
        appImage: await image(`${scheme}//bundle/attachment-preview/00000000-0000-4000-8000-000000000000`),
        dataImage: await image("data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"),
        popup: window.open("https://example.com") === null ? "blocked" : "opened",
        referrer: document.referrer,
        // location.origin serializes the URL; self.origin is the document's own, opaque origin.
        origin: self.origin,
        url: location.origin,
        storage: (() => {
          try {
            void window.localStorage;
            return "available";
          } catch {
            return "blocked";
          }
        })(),
      };
    });
    expect(probe).toEqual({
      framed: true,
      parentDocument: "blocked",
      bridge: "undefined",
      fetched: "rejected",
      appImage: "error",
      dataImage: "load",
      popup: "blocked",
      referrer: "",
      origin: "null",
      url: expect.stringMatching(/^[a-z-]+:\/\/render$/u),
      storage: "blocked",
    });

    // The parent sees the page's messages from an opaque origin and applies them.
    await page.evaluate(() => {
      const origins: string[] = [];
      Reflect.set(window, "__inertiaE2eFrameOrigins", origins);
      window.addEventListener("message", (event) => origins.push(event.origin));
    });
    const reloadedFrame = await inlineFrame(page);
    const naturalHeight = await reloadedFrame.evaluate(() => Math.ceil(document.documentElement.getBoundingClientRect().height));
    await reloadedFrame.evaluate((height) => window.parent.postMessage({ type: "inertia-html-render:size", height }, "*"), naturalHeight + 40);
    await expect.poll(async () => Math.round((await page.locator(INLINE_FRAME).boundingBox())!.height)).toBe(naturalHeight + 40);
    expect(await page.evaluate(() => Reflect.get(window, "__inertiaE2eFrameOrigins"))).toEqual(["null"]);
    await reloadedFrame.evaluate((height) => window.parent.postMessage({ type: "inertia-html-render:size", height }, "*"), naturalHeight);
    await expect.poll(async () => Math.round((await page.locator(INLINE_FRAME).boundingBox())!.height)).toBe(naturalHeight);
    expect(await app.electronApp.evaluate(() =>
      Reflect.get(globalThis, "__inertiaHtmlRenderOpened") as string[])).toEqual([HTML_RENDER_LINK]);
  } finally {
    await app.close();
  }
});
