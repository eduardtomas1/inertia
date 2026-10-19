// @inertia-e2e-resource isolated
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { setAppearanceInPlace } from "./support/appearance";

const evidenceDirectory = process.env.INERTIA_ROUTING_EVIDENCE_DIR
  ? resolve(process.env.INERTIA_ROUTING_EVIDENCE_DIR)
  : null;

const providerOutput = "Traced the retry loop; the remote handle is read after it was released.";
const routedPrompt = [
  "Fix the crash in the retry loop when the remote is offline and debug why it fails:",
  "",
  "```",
  "TypeError: Cannot read properties of undefined (reading 'close')",
  "    at retryFetch (src/server/git.ts:142:17)",
  "    at async syncRemote (src/server/git.ts:201:5)",
  "```",
].join("\n");

// Three models with different reasoning ranges so the Light, Standard, Heavy
// and Max tiers derive different presets from the live catalog.
const codexAppServerSource = `
if (process.argv[2] === "--help") {
  process.stdout.write("Usage: codex app-server [OPTIONS] - Run the app server\\n");
  process.exit(0);
}
const readline = require("node:readline");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const titleThreads = new Set();
let threadId = "routing-evidence-thread";
let turnSequence = 0;
const turn = (id, status) => ({ id, status, items: [], error: null });
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "routing-evidence-fixture" } });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "model/list") {
    send({ id: message.id, result: { data: [
      {
        model: "gpt-5.3-codex",
        displayName: "GPT-5.3 Codex",
        description: "Agentic coding model for everyday engineering work.",
        isDefault: true,
        inputModalities: ["text", "image"],
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: [
          { reasoningEffort: "low", description: "Fast responses" },
          { reasoningEffort: "medium", description: "Balanced reasoning" },
          { reasoningEffort: "high", description: "Deep reasoning" }
        ]
      },
      {
        model: "gpt-5.4-pro",
        displayName: "GPT-5.4 Pro",
        description: "Strongest model for hard debugging and planning.",
        inputModalities: ["text", "image"],
        defaultReasoningEffort: "high",
        supportedReasoningEfforts: [
          { reasoningEffort: "medium", description: "Balanced reasoning" },
          { reasoningEffort: "high", description: "Deep reasoning" },
          { reasoningEffort: "xhigh", description: "Extra deep reasoning" }
        ]
      },
      {
        model: "gpt-5.2-codex-mini",
        displayName: "GPT-5.2 Codex Mini",
        description: "Fast, efficient coding model for small tasks.",
        inputModalities: ["text"],
        defaultReasoningEffort: "low",
        supportedReasoningEfforts: [
          { reasoningEffort: "minimal", description: "Fastest responses" },
          { reasoningEffort: "low", description: "Fast responses" },
          { reasoningEffort: "medium", description: "Balanced reasoning" }
        ]
      }
    ], nextCursor: null } });
    return;
  }
  if (message.method === "account/rateLimits/read") {
    send({ id: message.id, result: { rateLimits: null, rateLimitsByLimitId: null } });
    return;
  }
  if (message.method === "thread/goal/get") {
    send({ id: message.id, result: { goal: null } });
    return;
  }
  if (message.method === "config/read") {
    send({ id: message.id, result: { config: {} } });
    return;
  }
  if (message.method === "thread/start" && message.params.threadSource === "thread_title") {
    const titleThreadId = "routing-title-thread-" + process.pid;
    titleThreads.add(titleThreadId);
    send({ id: message.id, result: {
      thread: { id: titleThreadId, ephemeral: message.params.ephemeral === true },
      model: message.params.model || "gpt-5.3-codex", modelProvider: "openai", serviceTier: null, cwd: process.cwd(),
      approvalPolicy: "never", approvalsReviewer: "user", reasoningEffort: null,
      sandbox: { type: "readOnly", networkAccess: false },
    } });
    return;
  }
  if (message.method === "thread/start" || message.method === "thread/resume") {
    threadId = message.params.threadId || threadId;
    send({ id: message.id, result: {
      thread: { id: threadId }, cwd: process.cwd(), model: message.params.model || "gpt-5.3-codex",
      serviceTier: null, initialTurnsPage: null,
    } });
    return;
  }
  if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
    return;
  }
  if (message.method !== "turn/start") return;
  turnSequence += 1;
  const turnId = "routing-evidence-turn-" + process.pid + "-" + turnSequence;
  const target = message.params.threadId;
  send({ id: message.id, result: { turn: turn(turnId, "inProgress") } });
  send({ method: "turn/started", params: { threadId: target, turn: turn(turnId, "inProgress") } });
  if (titleThreads.has(target)) {
    send({ method: "item/completed", params: {
      threadId: target, turnId, completedAtMs: Date.now(),
      item: { type: "agentMessage", id: "title-" + turnSequence, text: JSON.stringify({ title: "Offline retry crash" }), phase: "final_answer" },
    } });
  } else {
    send({ method: "item/agentMessage/delta", params: {
      threadId: target, turnId, itemId: "answer-" + turnSequence, delta: ${JSON.stringify(providerOutput)},
    } });
  }
  send({ method: "turn/completed", params: { threadId: target, turn: turn(turnId, "completed") } });
});
`;

const claudeAuthSource = `
if (process.argv[2] === "status") {
  process.stdout.write(JSON.stringify({ loggedIn: false }) + "\\n");
  process.exit(1);
}
`;

const WIDE = { width: 1440, height: 920 } as const;
const NARROW = { width: 760, height: 920 } as const;

let app!: AppFixture;
let page!: Page;
const captured = new Set<string>();

function settingsNavigation(label: string): Locator {
  return page.getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: label, exact: true });
}

function settingsContent(): Locator {
  return page.locator(".settings-content");
}

function composer(): Locator {
  return page.getByRole("region", { name: "Message composer" });
}

function modelTrigger(): Locator {
  return page.getByRole("button", { name: /^Choose model\./u });
}

function modelChooser(): Locator {
  return page.getByRole("dialog", { name: "Choose model" });
}

function autoRow(): Locator {
  return modelChooser().getByRole("button", { name: /^Auto:/u });
}

function enableSwitch(): Locator {
  return page.getByRole("switch", { name: "Enable Auto routing" });
}

function tooltip(): Locator {
  return page.locator(".tooltip[data-positioned='true']");
}

const OVERRIDE_HINT = "Choosing a model or effort turns Auto off for this chat.";

function chipLabel(): Locator {
  return modelTrigger().locator(".selected-model-chip-label");
}

/** The tooltip's rendered lines; each must fit on one line without wrapping. */
async function tooltipLines(): Promise<string[]> {
  const { text, height, lineHeight, chrome } = await tooltip().evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      text: (element as HTMLElement).innerText,
      height: element.getBoundingClientRect().height,
      lineHeight: Number.parseFloat(style.lineHeight),
      chrome: Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom)
        + Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.borderBottomWidth),
    };
  });
  const lines = text.split("\n");
  expect(Math.round((height - chrome) / lineHeight), `tooltip wrapped: ${JSON.stringify(lines)}`).toBe(lines.length);
  return lines;
}

/** True when the element's content overflows its box, which clips or ellipsizes it. */
async function isClipped(target: Locator): Promise<boolean> {
  return target.evaluate((element) => element.scrollWidth > element.clientWidth + 0.5);
}

interface CaptureOptions {
  /** Keep the pointer where it is, for hover tooltips. */
  keepPointer?: boolean;
  /** Keep keyboard focus, for focus rings and open popovers. */
  keepFocus?: boolean;
  /** Crop to the union of these elements, padded. Defaults to the full window. */
  around?: Locator[];
  /** Must still be visible once the screenshot is taken, or the capture fails. */
  verify?: Locator;
}

async function clipAround(targets: Locator[]): Promise<{ x: number; y: number; width: number; height: number }> {
  const boxes = (await Promise.all(targets.map((target) => target.boundingBox())))
    .filter((box): box is NonNullable<typeof box> => box !== null);
  if (boxes.length === 0) throw new Error("Nothing to crop the evidence image around.");
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const padding = 24;
  const left = Math.max(0, Math.min(...boxes.map(({ x }) => x)) - padding);
  const top = Math.max(0, Math.min(...boxes.map(({ y }) => y)) - padding);
  const right = Math.min(viewport.width, Math.max(...boxes.map(({ x, width }) => x + width)) + padding);
  const bottom = Math.min(viewport.height, Math.max(...boxes.map(({ y, height }) => y + height)) + padding);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * A clipped page.screenshot briefly resizes the Electron viewport, which
 * fires pointerleave and closes hover tooltips. Capture the whole window and
 * crop it in the main process instead.
 */
async function cropPng(
  png: Buffer,
  clip: { x: number; y: number; width: number; height: number },
): Promise<Buffer> {
  const viewportWidth = await page.evaluate(() => innerWidth);
  const cropped = await app.electronApp.evaluate(({ nativeImage }, { data, rect, cssWidth }) => {
    const image = nativeImage.createFromBuffer(Buffer.from(data, "base64"));
    const scale = image.getSize().width / cssWidth;
    return image.crop({
      x: Math.round(rect.x * scale),
      y: Math.round(rect.y * scale),
      width: Math.round(rect.width * scale),
      height: Math.round(rect.height * scale),
    }).toPNG().toString("base64");
  }, { data: png.toString("base64"), rect: clip, cssWidth: viewportWidth });
  return Buffer.from(cropped, "base64");
}

async function capture(testInfo: TestInfo, name: string, options: CaptureOptions = {}): Promise<void> {
  if (captured.has(name)) throw new Error(`Evidence image ${name} was captured twice.`);
  if (!options.keepPointer) await page.mouse.move(0, 0);
  if (!options.keepFocus && !options.keepPointer) {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  }
  await page.waitForTimeout(150);
  const clip = options.around ? await clipAround(options.around) : null;
  const screenshot = await page.screenshot({ animations: "disabled" });
  if (options.verify && !await options.verify.isVisible()) {
    throw new Error(`Evidence image ${name} lost its subject before the screenshot finished.`);
  }
  const path = testInfo.outputPath(`${name}.png`);
  await writeFile(path, clip ? await cropPng(screenshot, clip) : screenshot);
  captured.add(name);
  await testInfo.attach(name, { path, contentType: "image/png" });
  if (evidenceDirectory) await copyFile(path, join(evidenceDirectory, `${name}.png`));
}

async function waitForSettledSection(): Promise<void> {
  await expect(settingsContent().locator("[aria-busy='true']")).toHaveCount(0);
  await expect(settingsContent()).not.toContainText(/Loading .*…/u);
  await expect.poll(() => settingsContent().evaluate((element) => new Promise<boolean>((done) => {
    const height = element.scrollHeight;
    requestAnimationFrame(() => requestAnimationFrame(() => done(element.scrollHeight === height)));
  }))).toBe(true);
}

async function openRoutingSettings(): Promise<void> {
  if (!await page.getByRole("main", { name: "Settings" }).isVisible()) {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
  }
  await expect(page.getByRole("main", { name: "Settings" })).toBeVisible();
  await settingsNavigation("Routing").click();
  await expect(settingsNavigation("Routing")).toHaveAttribute("aria-current", "page");
  await expect(enableSwitch()).toBeVisible();
  await settingsContent().evaluate((element) => { element.scrollTop = 0; });
  await waitForSettledSection();
}

async function closeSettings(): Promise<void> {
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  await expect(page.getByRole("main", { name: "Settings" })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
}

async function scrollSettingsTo(target: Locator, offset = 16): Promise<void> {
  await target.evaluate((element, gap) => {
    const scroller = element.closest(".settings-content")!;
    const top = element.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    scroller.scrollTop = Math.max(0, Math.floor(top) - gap);
  }, offset);
  await page.waitForTimeout(120);
}

async function openChooser(): Promise<void> {
  await modelTrigger().click();
  await expect(modelChooser()).toBeVisible();
  await expect(modelChooser().getByRole("combobox", { name: "Search models" })).toBeFocused();
}

async function closeChooser(): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(modelChooser()).toBeHidden();
}

/** Hover tooltips close on any window blur or scroll, so retry until one survives the screenshot. */
async function captureChipTooltip(testInfo: TestInfo, name: string, around: Locator[]): Promise<void> {
  await expect(async () => {
    await showChipTooltip();
    await capture(testInfo, name, { keepPointer: true, around: [...around, tooltip()], verify: tooltip() });
  }).toPass({ timeout: 30_000 });
}

async function showChipTooltip(): Promise<void> {
  await expect(async () => {
    await page.mouse.move(0, 0);
    await modelTrigger().hover();
    await expect(tooltip()).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
}

test.beforeAll(async () => {
  app = await createAppFixture({
    name: "routing-evidence",
    initialState: "conversation",
    codexAppServerSource,
    claudeAuthSource,
  });
  page = app.page;
  if (evidenceDirectory) await mkdir(evidenceDirectory, { recursive: true });
});

test.afterAll(async () => {
  await app?.close();
});

test("captures Auto routing settings, chooser and composer decision evidence", async ({ browserName: _browserName }, testInfo) => {
  test.setTimeout(300_000);
  await setAppearanceInPlace(app, "light");
  await app.resizeWindow(WIDE.width, WIDE.height);

  await test.step("Auto is hidden while routing is off", async () => {
    await expect(modelTrigger()).toBeVisible();
    await expect(modelTrigger()).not.toHaveAttribute("data-routing-mode", "auto");
    await openChooser();
    await expect(modelChooser().getByRole("button", { name: /^Codex, \d+ models?$/u })).toBeVisible();
    await expect(autoRow()).toHaveCount(0);
    await closeChooser();
  });

  await test.step("Settings → Routing, off", async () => {
    await openRoutingSettings();
    await expect(enableSwitch()).toHaveAttribute("aria-checked", "false");
    await capture(testInfo, "routing-settings-off-light");
  });

  await test.step("Settings → Routing, on", async () => {
    await enableSwitch().click();
    await expect(enableSwitch()).toHaveAttribute("aria-checked", "true");
    await expect(settingsContent().locator("[data-setting-id='routing-enabled']").getByRole("status"))
      .toHaveText("Saved");
    const presets = page.getByRole("group", { name: "Tier presets" });
    for (const tier of ["Light", "Standard", "Heavy", "Max"]) {
      await expect(presets.getByRole("list", { name: `${tier} presets` })).toBeVisible();
    }
    await expect(presets.getByRole("list", { name: "Light presets" })).toContainText("GPT-5.2 Codex Mini");
    await expect(presets.getByRole("list", { name: "Max presets" })).toContainText("GPT-5.4 Pro");
    await expect(settingsContent().locator("[data-setting-id='routing-enabled']")).not.toContainText("Saved", { timeout: 10_000 });
    await waitForSettledSection();
    await capture(testInfo, "routing-settings-on-light");

    await setAppearanceInPlace(app, "dark");
    await waitForSettledSection();
    await capture(testInfo, "routing-settings-on-dark");

    await app.resizeWindow(NARROW.width, NARROW.height);
    await app.expectNoViewportOverflow();
    await settingsContent().evaluate((element) => { element.scrollTop = 0; });
    await waitForSettledSection();
    await capture(testInfo, "routing-settings-on-dark-narrow");
  });

  await test.step("Tier preset editor", async () => {
    await setAppearanceInPlace(app, "light");
    await app.resizeWindow(WIDE.width, WIDE.height);
    await waitForSettledSection();
    const heavy = page.locator("section[data-routing-tier='heavy']");
    await page.getByRole("button", { name: "Customize Heavy", exact: true }).click();
    await expect(heavy.getByRole("button", { name: "Reset Heavy to defaults", exact: true })).toBeVisible();
    await expect(heavy.getByRole("combobox", { name: /^Weight for /u }).first()).toBeVisible();
    await heavy.getByRole("combobox", { name: "Model to add to Heavy" })
      .selectOption({ label: "Codex · GPT-5.3 Codex · high" });
    await heavy.getByRole("button", { name: "Add to Heavy", exact: true }).click();
    await expect(heavy.getByRole("list", { name: "Heavy presets" }).getByRole("listitem")).toHaveCount(2);
    await expect(heavy).not.toContainText("Saving", { timeout: 10_000 });
    const weights = heavy.getByRole("combobox", { name: /^Weight for /u });
    const fallbackTier = settingsContent().locator("[data-setting-id='routing-fallback-tier'] select");
    const expectWeightsUnclipped = async (): Promise<void> => {
      const fallbackHeight = (await fallbackTier.boundingBox())!.height;
      for (const weight of await weights.all()) {
        expect(await isClipped(weight), "weight select clips its label").toBe(false);
        expect((await weight.boundingBox())!.height).toBeCloseTo(fallbackHeight, 0);
      }
    };
    await expect(weights).toHaveCount(2);
    await expectWeightsUnclipped();
    await scrollSettingsTo(page.locator("section[data-routing-tier='standard']"));
    await capture(testInfo, "routing-tier-presets-light");

    await setAppearanceInPlace(app, "dark");
    await app.resizeWindow(NARROW.width, NARROW.height);
    await app.expectNoViewportOverflow();
    await waitForSettledSection();
    await expectWeightsUnclipped();
    await scrollSettingsTo(heavy);
    await capture(testInfo, "routing-tier-presets-dark-narrow");
    await setAppearanceInPlace(app, "light");
    await app.resizeWindow(WIDE.width, WIDE.height);
    await waitForSettledSection();
    await heavy.getByRole("button", { name: "Reset Heavy to defaults", exact: true }).click();
    await expect(heavy.getByRole("button", { name: "Customize Heavy", exact: true })).toBeVisible();
    await closeSettings();
  });

  await test.step("Chooser offers Auto and the composer shows the badge", async () => {
    await openChooser();
    await expect(autoRow()).toBeVisible();
    await expect(autoRow()).toHaveAttribute("aria-pressed", "false");
    await capture(testInfo, "routing-chooser-auto-row-light", { keepFocus: true });
    await autoRow().click();
    await expect(modelChooser()).toBeHidden();
    await expect(modelTrigger()).toHaveAttribute("data-routing-mode", "auto");
    // The badge names the model only; the effort control beside it shows the effort.
    await expect(chipLabel()).toHaveText(/^Auto · [^·]+$/u);
    expect(await isClipped(chipLabel()), "Auto badge is truncated").toBe(false);
    await expect(modelTrigger()).toHaveAccessibleName(/Auto routing is on; currently .+ · .+\. Auto chooses a model/u);
    await capture(testInfo, "routing-composer-badge-light", { around: [composer()] });

    await showChipTooltip();
    const pendingLines = await tooltipLines();
    expect(pendingLines).toHaveLength(3);
    expect(pendingLines[0]).toMatch(/^Auto routing → .+ · .+$/u);
    expect(pendingLines.slice(1)).toEqual(["Auto chooses a model when you send the next message.", OVERRIDE_HINT]);
    await captureChipTooltip(testInfo, "routing-composer-tooltip-light", [composer()]);
    await page.mouse.move(0, 0);
    await expect(tooltip()).toHaveCount(0);
  });

  await test.step("A routed turn records its decision", async () => {
    const editor = composer().getByRole("textbox", { name: "Message" });
    await editor.fill(routedPrompt);
    await composer().getByRole("button", { name: "Send message" }).click();
    const routedTurn = page.locator("[data-turn-id]").filter({ hasText: "TypeError: Cannot read properties of undefined" });
    await expect(routedTurn.locator('[data-turn-status="completed"]')).toBeVisible({ timeout: 30_000 });
    await expect(routedTurn.getByText(providerOutput, { exact: true })).toBeVisible();
    await expect(page.getByText(/^Capturing changes/u)).toHaveCount(0, { timeout: 30_000 });
    await expect(modelTrigger()).toHaveAttribute("data-routing-mode", "auto");
    await expect(chipLabel()).toHaveText("Auto · GPT-5.4 Pro");
    expect(await isClipped(chipLabel()), "Auto badge is truncated").toBe(false);
    await expect(composer().getByRole("button", { name: "Choose reasoning level. Current level: High." })).toBeVisible();
    await expect(modelTrigger()).toHaveAccessibleName(
      "Choose model. Auto routing is on; currently GPT-5.4 Pro · High. "
      + `Rules picker · Debugging · Heavy tier · 60% confidence · Switched model. ${OVERRIDE_HINT}`,
    );

    await showChipTooltip();
    expect(await tooltipLines()).toEqual([
      "Auto routing → GPT-5.4 Pro · High",
      "Rules picker · Debugging · Heavy tier · 60% confidence · Switched model",
      OVERRIDE_HINT,
    ]);
    await captureChipTooltip(testInfo, "routing-composer-decision-light", [routedTurn, composer()]);

    await page.mouse.move(0, 0);
    await expect(tooltip()).toHaveCount(0);
    await setAppearanceInPlace(app, "dark");
    await showChipTooltip();
    await expect(tooltip()).toContainText(/Rules picker · /u);
    await captureChipTooltip(testInfo, "routing-composer-decision-dark", [routedTurn, composer()]);
    await page.mouse.move(0, 0);
    await setAppearanceInPlace(app, "light");
  });

  expect(app.rendererErrors).toEqual([]);
});
