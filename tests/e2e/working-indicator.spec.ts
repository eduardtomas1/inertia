// @inertia-e2e-resource isolated
import { expect, test, type Locator, type Page } from "@playwright/test";
import { join } from "node:path";
import Database from "better-sqlite3";

import { createAppFixture, type AppFixture } from "./support/app-fixture";
import {
  capturePageWebSockets,
  publishCapturedWebSocketEvent,
} from "./support/browser-websocket-fixture";
import { createWorkingIndicatorFixture } from "./support/working-indicator-fixture";

let app!: AppFixture;
let page!: Page;
let fixture!: ReturnType<typeof createWorkingIndicatorFixture>;

test.beforeAll(async () => {
  app = await createAppFixture({ name: "working-indicator", initialState: "conversation" });
  page = app.page;
  await app.resizeWindow(1440, 920);
  fixture = createWorkingIndicatorFixture({
    testDirectory: app.testDirectory,
    workspaceDirectory: app.workspaceDirectory,
    settings: { theme: "dark" },
    backgroundTitles: ["Polish the release notes"],
  });
  await capturePageWebSockets(page);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Working indicator fixture", level: 1 })).toBeVisible();
});

test.afterAll(async () => {
  await app?.close();
});

const activeTurn = (): Locator => page.locator(`[data-turn-id="${fixture.active.turn.id}"]`);
const workingRowOrb = (): Locator => activeTurn().locator(".turn-working-status .working-orb");
const sidebarRow = (title: string): Locator => page.locator(".activity-thread", { hasText: title });
const sidebarOrb = (title: string): Locator => sidebarRow(title).locator('[data-work-status="working"] .working-orb');

async function shownDesign(orb: Locator): Promise<string | null> {
  return await orb.locator("canvas").getAttribute("data-orb-shown");
}

async function canvasSignature(orb: Locator): Promise<string> {
  return await orb.locator("canvas").evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL());
}

async function openAppearanceSettings(): Promise<void> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "General", exact: true }).click();
  await page.locator(".working-indicator-settings").scrollIntoViewIfNeeded();
}

test("keeps the Classic grid and rings by default", async () => {
  await expect(activeTurn().locator(".turn-working-status .agent-pixel-loader > span")).toHaveCount(9);
  await expect(page.locator(".working-orb")).toHaveCount(0);
  await expect(sidebarRow("Working indicator fixture").locator('.agent-pixel-loader[data-rhythm="orbit"]')).toBeVisible();
  const ring = await activeTurn().locator(".agent-activity.is-running .agent-activity-icon").first()
    .evaluate((element) => getComputedStyle(element, "::after").content);
  expect(ring).toBe('""');
  expect(app.rendererErrors).toEqual([]);
});

test("changes the indicator from Settings with the keyboard and updates the open chat live", async () => {
  await openAppearanceSettings();
  const picker = page.getByRole("radiogroup", { name: "Working indicator" });
  const classic = picker.getByRole("radio", { name: "Classic" });
  await expect(classic).toHaveAttribute("aria-checked", "true");
  await classic.focus();
  await page.keyboard.press("ArrowRight");
  const automatic = picker.getByRole("radio", { name: "Automatic" });
  await expect(automatic).toBeFocused();
  await expect(automatic).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Tab");
  await expect(automatic).not.toBeFocused();
  const colours = page.getByRole("radiogroup", { name: "Colour" });
  await colours.getByRole("radio", { name: "Theme ink" }).focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(colours.getByRole("radio", { name: "Lilac" })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("switch", { name: "Glow" }).click();
  await expect(page.getByRole("switch", { name: "Glow" })).toHaveAttribute("aria-checked", "true");
  await expect.poll(() => {
    const database = new Database(join(app.testDirectory, "data", "inertia.sqlite"), { readonly: true });
    const value = database.prepare("SELECT working_indicator_json AS value FROM app_state WHERE id = 1")
      .pluck().get() as string;
    database.close();
    return JSON.parse(value) as unknown;
  }).toMatchObject({ style: "automatic", color: "lilac", glow: true });

  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  await expect(workingRowOrb()).toHaveAttribute("data-orb-design", "connecting");
  await expect(activeTurn().locator(".agent-pixel-loader")).toHaveCount(0);
  await expect(activeTurn().locator('.agent-activity-icon[data-activity-indicator="orb"]')).toHaveCount(2);
  const surfaces = await workingRowOrb().evaluate((host) => {
    const canvas = host.querySelector("canvas")!;
    const read = (element: Element) => {
      const styles = getComputedStyle(element);
      return [styles.backgroundColor, styles.backgroundImage, styles.boxShadow, styles.borderTopWidth, styles.outlineStyle];
    };
    return {
      host: read(host),
      canvas: read(canvas),
      alpha: canvas.getContext("2d")?.getContextAttributes().alpha,
      filter: getComputedStyle(canvas).filter,
    };
  });
  expect(surfaces).toEqual({
    host: ["rgba(0, 0, 0, 0)", "none", "none", "0px", "none"],
    canvas: ["rgba(0, 0, 0, 0)", "none", "none", "0px", "none"],
    alpha: true,
    filter: "none",
  });
  const box = await workingRowOrb().boundingBox();
  expect(box?.width).toBe(18);
  expect(box?.height).toBe(18);
  expect(app.rendererErrors).toEqual([]);
});

test("follows the phase in Automatic and keeps the sidebar row in step with the working row", async () => {
  const publish = (event: object): Promise<void> => publishCapturedWebSocketEvent(page, event);
  for (const activity of fixture.runningActivities) {
    await publish({ type: "agent.activity", activity: { ...activity, status: "completed" } });
  }
  const phases = [
    { kind: "tool", title: "Search release documentation", phase: "searching", design: "searching" },
    { kind: "file", title: "Edit tray icon loader", phase: "coding", design: "solving" },
    { kind: "command", title: "Run focused tests", phase: "command", design: "working" },
  ] as const;
  let previous: { id: string } | null = null;
  const seen: string[] = [];
  for (const [index, step] of phases.entries()) {
    if (previous) {
      await publish({ type: "agent.activity", activity: { ...fixture.runningActivities[0], ...previous, status: "completed" } });
    }
    const activity = {
      ...fixture.runningActivities[0],
      id: `working-indicator-live-${index}`,
      kind: step.kind,
      title: step.title,
      status: "running",
      createdAt: fixture.activeAt(20 + index * 2),
    };
    await publish({ type: "agent.activity", activity });
    previous = { id: activity.id };
    await expect(activeTurn().locator(`[data-active-agent-phase="${step.phase}"]`)).toBeVisible();
    await expect(workingRowOrb()).toHaveAttribute("data-orb-design", step.design);
    await expect(sidebarOrb("Working indicator fixture")).toHaveAttribute("data-orb-design", step.design);
    await expect.poll(() => shownDesign(workingRowOrb())).toBe(step.design);
    expect(await shownDesign(sidebarOrb("Working indicator fixture"))).toBe(step.design);
    seen.push(step.design);
  }
  expect(new Set(seen).size).toBe(phases.length);

  await publish({ type: "agent.activity", activity: { ...fixture.runningActivities[0], ...previous, status: "completed" } });
  await publish({
    type: "agent.text",
    conversationId: fixture.conversation.id,
    runId: fixture.active.turn.runId,
    turnId: fixture.active.turn.id,
    text: "The tray icon is now bundled with the release build.",
  });
  await expect(activeTurn().locator('[data-active-agent-phase="responding"]')).toBeVisible();
  await expect(workingRowOrb()).toHaveAttribute("data-orb-design", "composing");
  await expect(sidebarOrb("Working indicator fixture")).toHaveAttribute("data-orb-design", "composing");
  await expect(sidebarOrb("Polish the release notes")).toHaveAttribute("data-orb-design", "working");
  await expect.poll(() => shownDesign(workingRowOrb())).toBe("composing");
  expect(await shownDesign(sidebarOrb("Working indicator fixture"))).toBe("composing");

  const first = await canvasSignature(workingRowOrb());
  await expect.poll(() => canvasSignature(workingRowOrb())).not.toBe(first);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForTimeout(300);
  const still = await canvasSignature(workingRowOrb());
  await page.waitForTimeout(400);
  expect(await canvasSignature(workingRowOrb())).toBe(still);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect.poll(() => canvasSignature(workingRowOrb())).not.toBe(still);

  await openAppearanceSettings();
  await page.getByRole("radio", { name: "Classic" }).click();
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  await expect(activeTurn().locator(".turn-working-status .agent-pixel-loader > span")).toHaveCount(9);
  await expect(page.locator(".working-orb")).toHaveCount(0);
  await openAppearanceSettings();
  await page.getByRole("radio", { name: "Automatic" }).click();
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  await expect(workingRowOrb()).toHaveAttribute("data-orb-design", "composing");
  expect(app.rendererErrors).toEqual([]);
});

test("restores the indicator settings after restart", async () => {
  ({ page } = await app.restart());
  await openAppearanceSettings();
  await expect(page.getByRole("radio", { name: "Automatic" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("radio", { name: "Lilac" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("switch", { name: "Glow" })).toHaveAttribute("aria-checked", "true");
  expect(app.rendererErrors).toEqual([]);
});
