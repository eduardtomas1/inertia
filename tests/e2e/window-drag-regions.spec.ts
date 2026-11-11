// @inertia-e2e-resource isolated
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { RuntimeStore } from "../../src/server/database";
import { WINDOW_HEADER_HEIGHT } from "../../src/shared/window-chrome";
import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { measureWindowDragBand, type DragPoint, type WindowDragBand } from "./support/window-drag-regions";
import { rightPanelToggle } from "./support/workspace-tools";

const MINIMUM_DRAGGABLE_SHARE = 0.9;

let app!: AppFixture;
let page!: Page;

test.beforeAll(async () => {
  app = await createAppFixture({
    name: "window-drag-regions",
    initialState: "conversation",
    beforeLaunch: ({ testDirectory, workspaceDirectory }) => {
      const store = new RuntimeStore(
        join(testDirectory, "data", "inertia.sqlite"),
        workspaceDirectory,
        { recoverInterruptedRuns: false },
      );
      try {
        const snapshot = store.shellSnapshot();
        if (!snapshot.activeConversationId || !snapshot.activeProjectId) {
          throw new Error("The drag region fixture requires an active chat.");
        }
        for (let index = 0; index < 30; index += 1) {
          store.createMessage(snapshot.activeConversationId, `Question ${index}: where does the window drag?`, "user");
          store.createMessage(
            snapshot.activeConversationId,
            [`Answer ${index}`, "", `\`\`\`ts file=src/drag-${index}.ts`, `const region = ${index};`, "```", "", "The top bar drags it."].join("\n"),
            "assistant",
          );
        }
        for (let index = 0; index < 40; index += 1) {
          store.createConversation(snapshot.activeProjectId, `Scrolled chat ${index}`, { activate: false });
        }
      } finally {
        store.close();
      }
    },
  });
  page = app.page;
  await app.resizeWindow(1280, 800);
});

test.afterAll(async () => {
  await app?.close();
});

async function expectDraggableTopBar(
  target: Page,
  points: readonly DragPoint[] = [],
): Promise<WindowDragBand> {
  const band = await measureWindowDragBand(target, { points });
  const context = JSON.stringify({ blockers: band.blockers, rowSpans: band.rowSpans });
  expect(band.controls.length, "The top bar exposes its controls").toBeGreaterThan(0);
  expect(
    band.controls.filter((control) => control.draggableArea > 0 || control.hitRegion !== "no-drag"),
    "Every top bar control stays outside the drag region",
  ).toEqual([]);
  expect(
    band.points.filter((point) => !point.overControl && point.region !== "drag"),
    `Every empty top bar sample drags the window: ${context}`,
  ).toEqual([]);
  expect(band.draggableShare, `Draggable share of the empty top bar area: ${context}`)
    .toBeGreaterThan(MINIMUM_DRAGGABLE_SHARE);
  expect(band.rowDraggableShare, `Draggable share of the empty top bar width: ${context}`)
    .toBeGreaterThan(MINIMUM_DRAGGABLE_SHARE);
  return band;
}

async function emptyHeaderPoints(target: Page, includeSidebar: boolean): Promise<DragPoint[]> {
  return await target.evaluate((withSidebar) => {
    const bounds = (selector: string): DOMRect => {
      const element = document.querySelector(selector);
      if (!element) throw new Error(`Missing ${selector}`);
      return element.getBoundingClientRect();
    };
    const title = bounds(".header-title-wrap h1");
    const trailing = bounds(".header-trailing");
    const middle = (title.right + trailing.left) / 2;
    const points = [
      { x: title.right + 16, y: 24 },
      { x: middle, y: 3 },
      { x: middle, y: 24 },
      { x: middle, y: 45 },
      { x: trailing.left - 16, y: 24 },
    ];
    if (!withSidebar) return points;
    const sidebar = bounds(".sidebar");
    const lockup = bounds(".brand-lockup");
    return [
      ...points,
      { x: sidebar.left + 3, y: 3 },
      { x: sidebar.left + sidebar.width / 2, y: 4 },
      { x: sidebar.right - 4, y: 24 },
      { x: (lockup.right + sidebar.right) / 2, y: Math.min(44, lockup.top + lockup.height / 2) },
    ];
  }, includeSidebar);
}

async function showTranscript(target: Page): Promise<void> {
  const history = target.locator(".orphan-run-flow details");
  if (!await history.evaluate((element) => (element as HTMLDetailsElement).open)) {
    await history.locator("summary").click();
  }
  await expect(target.locator(".message-scroll .response-code-file-link").first()).toBeAttached();
  await expect.poll(async () => await target.locator(".message-scroll").evaluate(
    (element) => element.scrollHeight - element.clientHeight,
  )).toBeGreaterThan(600);
}

function emptySamples(band: WindowDragBand, from: number, count: number): number {
  return band.points.slice(from, from + count).filter((point) => !point.overControl).length;
}

interface TuckState {
  points: DragPoint[];
  exposed: string[];
  center: DragPoint;
  forward: boolean;
  scrollTop: number;
  candidates: number;
  distance: number | null;
}

async function tuckControlsUnderTopBar(target: Page, selector: string): Promise<DragPoint[]> {
  const read = async (forward?: boolean): Promise<TuckState | null> => await target.evaluate(({ controls, height, direction }) => {
    const scrolls = (element: Element): boolean => element.scrollHeight > element.clientHeight + height
      && /auto|scroll/u.test(getComputedStyle(element).overflowY);
    let scroller: Element | null = null;
    for (const control of document.querySelectorAll(controls)) {
      for (let ancestor = control.parentElement; ancestor && !scroller; ancestor = ancestor.parentElement) {
        if (scrolls(ancestor)) scroller = ancestor;
      }
      if (scroller) break;
    }
    if (!scroller) return null;
    const owner = scroller;
    const bounds = owner.getBoundingClientRect();
    const headerControl = (x: number, y: number): boolean => {
      const hit = document.elementFromPoint(x, y);
      return Boolean(hit && !owner.contains(hit) && hit.closest("button, input, textarea, a[href], [role='separator'], .header-title-wrap h1"));
    };
    const elements = [...owner.querySelectorAll(controls)].map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter(({ rect }) => rect.width >= 12 && rect.height >= 6);
    const exposed: string[] = [];
    const points = elements.flatMap(({ element, rect }) => {
      const top = Math.max(0, rect.top);
      const bottom = Math.min(height, rect.bottom);
      if (bottom - top < 6) return [];
      return [0.2, 0.5, 0.8]
        .map((share) => ({ x: Math.round(rect.left + rect.width * share), y: Math.round((top + bottom) / 2) }))
        .filter((point) => {
          const hit = document.elementFromPoint(point.x, point.y);
          if (hit && owner.contains(hit)) {
            exposed.push(`${element.getAttribute("aria-label") ?? element.className} at ${point.x},${point.y}`);
            return false;
          }
          return !headerControl(point.x, point.y);
        });
    });
    const moving = direction ?? owner.scrollTop < (owner.scrollHeight - owner.clientHeight) / 2;
    const candidates = elements
      .filter(({ rect }) => !headerControl(Math.round(rect.left + rect.width / 2), Math.round(height / 2)))
      .map(({ rect }) => rect.top + rect.height / 2 - height / 2)
      .filter((distance) => moving ? distance > 1 : distance < -1)
      .sort((first, second) => Math.abs(first) - Math.abs(second));
    return {
      points,
      exposed,
      center: { x: Math.round(bounds.left + bounds.width / 2), y: Math.round(bounds.top + Math.min(bounds.height, window.innerHeight - bounds.top) / 2) },
      forward: moving,
      scrollTop: Math.round(owner.scrollTop),
      candidates: candidates.length,
      distance: candidates[0] ?? null,
    };
  }, { controls: selector, height: WINDOW_HEADER_HEIGHT, direction: forward });
  const start = await read();
  if (!start) throw new Error(`No scrolling container holds ${selector}.`);
  await target.mouse.move(start.center.x, start.center.y);
  const history: string[] = [];
  let state: TuckState | null = start;
  for (let attempt = 0; attempt < 12 && state; attempt += 1) {
    expect(state.exposed, `A control under ${selector} shows through the top bar`).toEqual([]);
    if (state.points.length > 0) return state.points;
    history.push(`scrollTop ${state.scrollTop}, ${state.candidates} candidates, next ${state.distance ?? "none"}`);
    if (state.distance === null) break;
    const before = state.scrollTop;
    await target.mouse.wheel(0, Math.round(state.distance));
    await expect.poll(async () => (await read(start.forward))?.scrollTop ?? before, { timeout: 2_000 }).not.toBe(before);
    await target.evaluate(async () => await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    state = await read(start.forward);
  }
  throw new Error(`Could not scroll a control under ${selector} beneath the empty top bar: ${history.join("; ")}`);
}

test("drags the window from every empty part of the chat top bar", async () => {
  await expect(page.locator(".workspace-header .header-title-button")).toBeVisible();
  const band = await expectDraggableTopBar(page, await emptyHeaderPoints(page, true));
  expect(band.longestRowSpan).toBeGreaterThan(240);
  const labels = band.controls.map((control) => control.label).join("\n");
  expect(labels).toContain("Start a new chat");
  expect(labels).toContain("Toggle project navigation");
  expect(labels).toContain("header-title-button");
  expect(labels).toContain("Toggle right panel");
});

test("keeps the top bar draggable above scrolled chats and transcript", async () => {
  const underSidebar = await tuckControlsUnderTopBar(page, ".sidebar button:not(.drag-region *)");
  await showTranscript(page);
  const underHeader = await tuckControlsUnderTopBar(page, ".message-scroll button");
  const band = await expectDraggableTopBar(page, [
    ...underSidebar,
    ...underHeader,
    ...await emptyHeaderPoints(page, true),
  ]);
  expect(emptySamples(band, 0, underSidebar.length), "A sidebar control is scrolled under the empty top bar").toBeGreaterThan(0);
  expect(emptySamples(band, underSidebar.length, underHeader.length), "A transcript control is scrolled under the empty top bar").toBeGreaterThan(0);
});

test("keeps the header draggable with the sidebar collapsed", async () => {
  const toggle = page.getByRole("button", { name: "Toggle project navigation" });
  await toggle.click();
  await expect(page.locator(".app-shell")).toHaveClass(/is-sidebar-collapsed/u);
  await expect(page.locator(".sidebar")).toHaveCount(0);
  await expectDraggableTopBar(page, await emptyHeaderPoints(page, false));
  await toggle.click();
  await expect(page.locator(".sidebar")).toBeVisible();
});

test("keeps the corner controls clickable above a draggable right panel", async () => {
  const toggle = rightPanelToggle(page);
  await toggle.click();
  const panel = page.locator(".workspace-panel");
  await expect(panel).toBeVisible();
  for (const width of [1280, 1000]) {
    await app.resizeWindow(width, 800);
    await expect(panel).toBeVisible();
    const band = await expectDraggableTopBar(page);
    const labels = band.controls.map((control) => control.label).join("\n");
    expect(labels).toContain("Toggle terminal");
    expect(labels).toContain("Toggle right panel");
  }
  await app.resizeWindow(1280, 800);
  await toggle.click();
  await expect(panel).toBeHidden();
});

test("drags the detached chat window from its header", async () => {
  await page.locator(".workspace-header .header-title-button").click();
  const opened = app.electronApp.waitForEvent("window");
  await page.getByRole("menuitem", { name: "Open chat in new window" }).click();
  const popup = await opened;
  await popup.locator(".detached-chat-shell").waitFor();
  await popup.getByRole("textbox", { name: "Message" }).waitFor();
  await showTranscript(popup);
  const underHeader = await tuckControlsUnderTopBar(popup, ".message-scroll button");
  const band = await expectDraggableTopBar(popup, underHeader);
  expect(emptySamples(band, 0, underHeader.length), "A transcript control is scrolled under the empty detached header").toBeGreaterThan(0);
  expect(band.longestRowSpan).toBeGreaterThan(80);
  await popup.getByRole("button", { name: "Return chat to main window" }).click();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
});

test("leaves the top of an open popup's backdrop to dismiss it instead of dragging", async () => {
  await page.locator(".sidebar-footer").getByRole("button", { name: "Usage", exact: true }).click();
  const popup = page.getByRole("dialog", { name: "Usage", exact: true });
  await expect(popup).toBeVisible();
  const above = await popup.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: Math.max(2, rect.top / 2) };
  });
  const reading = await measureWindowDragBand(page, { points: [above] });
  expect(reading.points[0]?.region).toBe("no-drag");
  await page.mouse.click(above.x, above.y);
  await expect(popup).toHaveCount(0);
});

test("keeps a view title selectable while the rest of its header drags", async () => {
  await page.locator(".sidebar .sidebar-tasks-action").click();
  await expect(page.getByRole("main", { name: "Tasks" })).toBeVisible();
  await expect(page.locator(".header-title-wrap h1 > .header-title-text")).toBeVisible();
  const title = await page.locator(".header-title-wrap h1").evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  const reading = await measureWindowDragBand(page, { points: [title] });
  expect(reading.points[0]?.region).toBe("no-drag");
  await expectDraggableTopBar(page, await emptyHeaderPoints(page, true));
});

test("keeps the navigation drawer controls clickable above the header", async () => {
  await app.resizeWindow(700, 800);
  await expect(page.locator(".sidebar")).toHaveAttribute("aria-hidden", "true");
  await expectDraggableTopBar(page);
  await page.getByRole("button", { name: "Toggle project navigation" }).click();
  const navigation = page.getByRole("complementary", { name: "Project navigation", exact: true });
  await expect(navigation).toBeVisible();
  await expect.poll(async () => await page.locator(".sidebar").evaluate((element) => Math.abs(element.getBoundingClientRect().left) < 1)).toBe(true);
  const band = await expectDraggableTopBar(page, [{ x: 6, y: 4 }]);
  const labels = band.controls.map((control) => control.label).join("\n");
  expect(labels).toContain("Start a new chat");
  expect(labels).toContain("mobile-close");
  await navigation.getByRole("button", { name: "Close navigation" }).click();
  await expect(navigation).toBeHidden();
});
