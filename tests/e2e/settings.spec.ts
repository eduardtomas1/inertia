import { expect, test } from "@playwright/test";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Database from "better-sqlite3";

import { RuntimeStore } from "../../src/server/database";
import {
  expectComposerEndsAtDock,
} from "./support/layout-assertions";
import { createAppFixture, type AppFixture } from "./support/app-fixture";

let app!: AppFixture;
let electronApp!: AppFixture["electronApp"];
let page!: AppFixture["page"];
let testDirectory!: AppFixture["testDirectory"];
let workspaceDirectory!: AppFixture["workspaceDirectory"];
let rendererErrors!: AppFixture["rendererErrors"];
let previewUrl!: AppFixture["previewUrl"];
let resizeWindow!: AppFixture["resizeWindow"];
let expectNoViewportOverflow!: AppFixture["expectNoViewportOverflow"];

test.beforeAll(async () => {
  app = await createAppFixture({
    name: "settings",
    initialState: "conversation",
    seedAssistantCodeBlock: true,
  });
  electronApp = app.electronApp;
  page = app.page;
  testDirectory = app.testDirectory;
  workspaceDirectory = app.workspaceDirectory;
  rendererErrors = app.rendererErrors;
  previewUrl = app.previewUrl;
  resizeWindow = app.resizeWindow;
  expectNoViewportOverflow = app.expectNoViewportOverflow;
});

test.afterAll(async () => {
  await app.close();
});

async function ensureTerminalTools(): Promise<void> {
  if (!await page.locator(".workspace-panel").isVisible().catch(() => false)) {
    await page.getByRole("button", { name: "Open workspace tools" }).click();
  }
  await page.getByRole("tab", { name: "Terminal", exact: true }).click();
}

test("navigates settings, changes theme, and returns to chat", async () => {
  await ensureTerminalTools();
  const terminalPanel = page.locator("aside.terminal-panel").first();
  const terminalFontSize = await terminalPanel.getAttribute("data-terminal-font-size");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("button", { name: "General", exact: true }))
    .toHaveAttribute("aria-current", "page");
  await page.getByRole("radio", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect.poll(async () => {
    try {
      return JSON.parse(await readFile(join(testDirectory, "electron-profile", "window-appearance.json"), "utf8"));
    } catch {
      return null;
    }
  }).toEqual({ theme: "dark" });
  const nativeAppearance = await electronApp.evaluate(({ BrowserWindow, nativeTheme }) => ({
    background: BrowserWindow.getAllWindows()[0]?.getBackgroundColor() ?? "",
    themeSource: nativeTheme.themeSource,
  }));
  expect(nativeAppearance.themeSource).toBe("dark");
  expect(nativeAppearance.background).toMatch(/^#101013(?:ff)?$/iu);
  await page.getByRole("radiogroup", { name: "Interface scale" }).getByRole("radio", { name: "Comfortable" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-interface-scale", "comfortable");
  await page.getByRole("radiogroup", { name: "Response density" }).getByRole("radio", { name: "Comfortable" }).click();
  await page.getByRole("switch", { name: "Wrap code by default" }).click();
  await expect(page.getByRole("switch", { name: "Wrap code by default" })).toHaveAttribute("aria-checked", "true");
  const providers = page.getByRole("button", { name: "Providers", exact: true });
  await providers.click();
  await expect(providers).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { name: "Agent accounts" })).toBeVisible();
  await page.getByRole("button", { name: "Keybindings", exact: true }).click();
  await expect(page.getByText("Toggle project navigation", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Go to workspace" }).click();
  await expect(page.locator("aside.terminal-panel").first()).toHaveAttribute("data-terminal-font-size", terminalFontSize ?? "13");
  await expect(page.locator(".chat-workspace")).toHaveClass(/response-density-comfortable/u);
  await expect(page.locator(".response-code-block pre").first()).toHaveClass(/wraps/u);
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
  await page.getByRole("textbox", { name: "Message" }).fill("Keep this V1 clear and calm.");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(
    page.getByLabel("Thread transcript").getByText("Keep this V1 clear and calm.", { exact: true }),
  ).toBeVisible();
  expect(rendererErrors).toEqual([]);
});

test("manages backend profiles across the responsive theme and scale matrix", async ({ browserName: _browserName }, testInfo) => {
  const openBackends = async (): Promise<void> => {
    const backends = page.getByRole("button", { name: "Model backends", exact: true });
    await backends.click();
    await expect(backends).toHaveAttribute("aria-current", "page");
    await expect(page.getByLabel("Model backend profiles")).toBeVisible();
  };
  const setAppearance = async (
    theme: "Light" | "Dark" | "System",
    scale: "Compact" | "Default" | "Large",
  ): Promise<void> => {
    await page.getByRole("button", { name: "General", exact: true }).click();
    await page.getByRole("radio", { name: theme, exact: true }).click();
    await page.getByRole("radiogroup", { name: "Interface scale" })
      .getByRole("radio", { name: scale, exact: true })
      .click();
    await openBackends();
  };
  const expectBackendLayoutContained = async (): Promise<void> => {
    await expectNoViewportOverflow();
    const containment = await page.locator(".backend-settings-grid").evaluate((grid) => {
      const editor = grid.querySelector(".backend-profile-editor");
      const editorBounds = editor?.getBoundingClientRect();
      const gridBounds = grid.getBoundingClientRect();
      const workspaceHeader = document.querySelector(".workspace-header")
        ?.getBoundingClientRect();
      const newProfile = document.querySelector<HTMLButtonElement>(
        ".backend-settings-toolbar > button",
      );
      const textNode = [...(newProfile?.childNodes ?? [])].find(
        (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
      );
      const textRange = textNode ? document.createRange() : null;
      if (textNode && textRange) textRange.selectNodeContents(textNode);
      return {
        gridWidth: gridBounds.width,
        gridRight: gridBounds.right,
        viewportRight: window.innerWidth,
        editorWidth: editorBounds?.width ?? 0,
        editorRight: editorBounds?.right ?? 0,
        workspaceHeader: workspaceHeader
          ? {
              top: workspaceHeader.top,
              bottom: workspaceHeader.bottom,
              width: workspaceHeader.width,
            }
          : null,
        newProfileTextLines: textRange?.getClientRects().length ?? 0,
        newProfileRight: newProfile?.getBoundingClientRect().right ?? 0,
      };
    });
    expect(containment.gridRight).toBeLessThanOrEqual(containment.viewportRight + 1);
    expect(containment.editorRight).toBeLessThanOrEqual(containment.gridRight + 1);
    expect(containment.editorWidth).toBeGreaterThan(0);
    expect(containment.workspaceHeader).not.toBeNull();
    expect(containment.workspaceHeader?.top).toBeGreaterThanOrEqual(0);
    expect(containment.workspaceHeader?.bottom).toBeGreaterThan(20);
    expect(containment.workspaceHeader?.width).toBeGreaterThan(200);
    expect(containment.newProfileTextLines).toBe(1);
    expect(containment.newProfileRight).toBeLessThanOrEqual(
      containment.gridRight + 1,
    );
  };

  await resizeWindow(1440, 920);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await openBackends();
  const profileRail = page.getByLabel("Backend profiles");
  await expect(profileRail.getByText("OpenAI", { exact: true })).toBeVisible();
  await expect(profileRail.getByText("Anthropic", { exact: true })).toBeVisible();
  await expect(profileRail.getByText("Cursor", { exact: true })).toBeVisible();
  await expect(profileRail.getByText("OpenCode", { exact: true })).toBeVisible();
  await expect(profileRail.getByText("Kimi", { exact: true })).toBeVisible();
  await expect(profileRail.locator(".backend-profile-rail-item").filter({
    hasText: /^OpenAI/u,
  }).locator(".backend-profile-dot")).toHaveClass(/is-ready/u);
  await expect(profileRail.locator(".backend-profile-rail-item").filter({
    hasText: /^Kimi/u,
  }).locator(".backend-profile-dot")).not.toHaveClass(/is-ready/u);
  await profileRail.getByText("Kimi", { exact: true }).click();
  await expect(page.getByText("Backend credential", { exact: true })).toBeVisible();
  await expect(page.getByPlaceholder("Add credential")).toBeVisible();

  const appearances = [
    { theme: "Light", scale: "Compact", slug: "light-compact" },
    { theme: "Dark", scale: "Default", slug: "dark-default" },
    { theme: "System", scale: "Large", slug: "system-large" },
  ] as const;
  const layouts = [
    { width: 1440, height: 920, slug: "wide" },
    { width: 900, height: 760, slug: "medium" },
    { width: 760, height: 760, slug: "narrow-760" },
  ] as const;
  for (const appearance of appearances) {
    await setAppearance(appearance.theme, appearance.scale);
    for (const layout of layouts) {
      await resizeWindow(layout.width, layout.height);
      const viewport = await page.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
      }));
      expect(viewport.width).toBeGreaterThanOrEqual(layout.width - 32);
      expect(viewport.width).toBeLessThanOrEqual(layout.width);
      expect(viewport.height).toBeGreaterThanOrEqual(600);
      expect(viewport.height).toBeLessThanOrEqual(layout.height);
      await expectBackendLayoutContained();
      await page.screenshot({
        path: testInfo.outputPath(
          `model-backends-${appearance.slug}-${layout.slug}-${viewport.width}x${viewport.height}.png`,
        ),
      });
    }
  }

  await resizeWindow(760, 760);
  await page.getByRole("button", { name: "New profile" }).click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill(
    "Visual gateway with an intentionally long profile name for truncation",
  );
  await page.locator(".backend-form-section").nth(1).locator("select").selectOption("none");
  await page.getByLabel("Base URL", { exact: true }).fill(`${previewUrl}backend-probe`);
  await page.getByRole("switch", { name: "Allow localhost HTTP" }).click();
  const modelId = page.getByLabel("Model ID", { exact: true });
  await modelId.first().fill(
    "visual-primary-model-with-a-deliberately-long-identifier",
  );
  await page.getByLabel("Display name", { exact: true }).first().fill(
    "Visual primary model with a deliberately long readable name",
  );
  await page.getByRole("button", { name: "Add model" }).click();
  await modelId.nth(1).fill(
    "visual-secondary-model-with-an-even-longer-deliberately-overflowing-identifier",
  );
  await page.getByLabel("Display name", { exact: true }).nth(1).fill(
    "Visual secondary model with a very long readable name",
  );
  await page.getByRole("button", {
    name: "Remove Visual secondary model with a very long readable name",
  }).click();
  await expect(modelId).toHaveCount(1);
  await page.getByRole("button", { name: "Add model" }).click();
  await modelId.nth(1).fill(
    "visual-secondary-model-with-an-even-longer-deliberately-overflowing-identifier",
  );
  await page.getByLabel("Display name", { exact: true }).nth(1).fill(
    "Visual secondary model with a very long readable name",
  );
  await page.getByRole("button", { name: "Advanced", exact: true }).click();
  await page.locator(".backend-tier-grid:not(.backend-primary-model) select")
    .first()
    .selectOption(
    "visual-secondary-model-with-an-even-longer-deliberately-overflowing-identifier",
    );
  await expectBackendLayoutContained();
  await page.screenshot({
    path: testInfo.outputPath("model-backends-narrow-editor-long-values.png"),
  });
  await page.getByRole("button", { name: "Create profile" }).click();
  await expect(page.getByText("Visual gateway with an intentionally long profile name for truncation", { exact: true }).first()).toBeVisible();
  const enable = page.getByRole("switch", {
    name: "Enable Visual gateway with an intentionally long profile name for truncation",
  });
  await expect(enable).toHaveAttribute("aria-checked", "false");

  const probe = page.getByRole("button", { name: "Test connection" });
  await probe.click();
  await expect(page.getByRole("button", { name: "Testing…" })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("model-backends-narrow-probe-loading.png"),
  });
  await expect(page.locator(".backend-status-strip").getByText("limited", {
    exact: true,
  })).toBeVisible();
  await expect(probe).toBeVisible();
  await enable.click();
  await expect(enable).toHaveAttribute("aria-checked", "true");
  await expect(page.getByText("Partial", { exact: true }).first()).toBeVisible();
  const globalDefault = page.getByRole("combobox", {
    name: "Global default",
    exact: true,
  });
  await globalDefault.selectOption({
    label: "Claude harness · Visual gateway with an intentionally long profile name for truncation · Visual primary model with a deliberately long readable name",
  });
  await expect.poll(() => {
    const database = new Database(join(testDirectory, "data", "inertia.sqlite"), {
      readonly: true,
    });
    const count = (database.prepare(`
      SELECT COUNT(*) AS count
      FROM model_backend_defaults
      WHERE scope = 'global'
    `).get() as { count: number }).count;
    database.close();
    return count;
  }).toBe(1);
  await page.screenshot({
    path: testInfo.outputPath("model-backends-narrow-probe-success-enabled.png"),
  });

  await page.getByRole("button", { name: "Edit configuration" }).click();
  await page.getByLabel("Base URL", { exact: true }).fill("http://127.0.0.1:1/backend-probe");
  await page.getByRole("button", { name: "Save configuration" }).click();
  await expect(enable).toHaveAttribute("aria-checked", "false");
  await expect(globalDefault).toHaveValue("");
  await probe.click();
  await expect(page.locator(".backend-status-strip").getByText("failed", {
    exact: true,
  })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("model-backends-narrow-probe-failure-disabled.png"),
  });

  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("button", { name: "Delete permanently" })).toBeVisible();
  await page.getByRole("button", { name: "Delete permanently" }).click();
  await expect(profileRail.getByText(
    "Visual gateway with an intentionally long profile name for truncation",
    { exact: true },
  )).toHaveCount(0);
  await expectBackendLayoutContained();
  await resizeWindow(1440, 920);
  await page.getByRole("button", { name: "Go to workspace" }).click();
  expect(rendererErrors).toEqual([]);
});

test("changes the visible theme on every quick-toggle click", async () => {
  const html = page.locator("html");
  const themeTrigger = page.getByRole("button", { name: /^Change theme \(current:/ });

  for (let click = 0; click < 3; click += 1) {
    const before = await html.getAttribute("data-theme");
    await themeTrigger.click();
    await expect.poll(() => html.getAttribute("data-theme")).not.toBe(before);
  }

  expect(rendererErrors).toEqual([]);
});

test("keeps runtime support and application update checks explicit in settings", async () => {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Archive & data", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Local data" })).toBeVisible();
  const exportPath = join(testDirectory, "settings-recovery-export.json");
  await electronApp.evaluate(({ dialog }, path) => {
    Reflect.set(dialog, "showSaveDialog", async () => ({
      canceled: false,
      filePath: path,
    }));
  }, exportPath);
  await page.getByRole("button", { name: "Export recovery file" }).click();
  await expect(page.getByText("Recovery file exported.", { exact: false }))
    .toBeVisible();
  const exported = JSON.parse(await readFile(exportPath, "utf8")) as {
    format: string;
    projects: Array<{
      conversations: Array<{ messages: unknown[] }>;
    }>;
  };
  expect(exported.format).toBe("inertia-recovery-export");
  expect(exported.projects.length).toBeGreaterThan(0);
  expect(exported.projects[0]?.conversations[0]?.messages.length)
    .toBeGreaterThan(0);
  expect(JSON.stringify(exported)).not.toMatch(
    /attachments|credential|providerSession|secretReference|vault/iu,
  );

  const emptyImportPath = join(testDirectory, "empty-recovery-import.json");
  await writeFile(emptyImportPath, JSON.stringify({
    format: "inertia-recovery-export",
    version: 1,
    exportedAt: "2026-08-01T00:00:00.000Z",
    projects: [],
  }));
  await electronApp.evaluate(({ dialog }, paths) => {
    let request = 0;
    Reflect.set(dialog, "showOpenDialog", async () => ({
      canceled: false,
      filePaths: [request++ === 0 ? paths.importPath : paths.targetDirectory],
    }));
  }, { importPath: emptyImportPath, targetDirectory: testDirectory });
  await page.getByRole("button", { name: "Import recovery file" }).click();
  await expect(page.getByText(
    "Imported 0 projects, 0 conversations, and 0 messages under new identities with supervised access.",
    { exact: true },
  )).toBeVisible();
  await expect(page.getByText("Local-only lifecycle and failure metadata.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Copy support summary" }).click();
  await expect(page.getByText("Private support summary copied", { exact: false })).toBeVisible();
  const supportSummary = await electronApp.evaluate(({ clipboard }) => clipboard.readText());
  expect(supportSummary).toContain("Inertia support summary");
  expect(supportSummary).toContain("Privacy: prompts, source, project paths");
  expect(supportSummary).not.toContain(workspaceDirectory);
  expect(supportSummary).not.toContain("sample.ts");
  await page.getByRole("button", { name: "Reveal log folder" }).click();
  await expect(page.getByText("Runtime log folder opened.", { exact: true })).toBeVisible();

  const logDirectory = join(testDirectory, "electron-profile", "logs", "runtime");
  await expect.poll(async () => (await stat(logDirectory)).isDirectory()).toBe(true);
  if (process.platform !== "win32") {
    expect((await stat(logDirectory)).mode & 0o777).toBe(0o700);
  }
  await page.getByRole("button", { name: "General", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Application updates" })).toBeVisible();
  await page.getByRole("button", { name: "Check now" }).click();
  await expect(page.getByText("Inertia is up to date.", { exact: true })).toBeVisible();
  await expect(page.getByText("Install", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Go to workspace" }).click();
  expect(rendererErrors).toEqual([]);
});

test("persists composer usage modes without losing the followed transcript", async ({ browserName: _browserName }, testInfo) => {
  const databasePath = join(testDirectory, "data", "inertia.sqlite");
  const usageDatabase = new Database(databasePath, { readonly: true });
  const usageState = usageDatabase.prepare(
    "SELECT active_conversation_id FROM app_state WHERE id = 1",
  ).get() as { active_conversation_id: string };
  usageDatabase.close();
  const usageStore = new RuntimeStore(databasePath, workspaceDirectory, { recoverInterruptedRuns: false });
  usageStore.upsertUsage({
    conversationId: usageState.active_conversation_id,
    usedTokens: 85,
    totalProcessedTokens: 1_250,
    totalProcessedScope: "session",
    maxTokens: 100,
    inputTokens: 80,
    cachedInputTokens: 10,
    cacheWriteInputTokens: null,
    outputTokens: 5,
    reasoningOutputTokens: null,
    compactsAutomatically: null,
  });
  usageStore.updateSettings({
    theme: "light",
    interfaceScale: "default",
    responseDensity: "default",
  });
  usageStore.close();
  await page.reload();
  await page.getByRole("textbox", { name: "Message" }).waitFor();
  await resizeWindow(1440, 920);
  const transcript = page.getByLabel("Thread transcript");
  const compact = page.getByRole("region", { name: "Usage and context" });
  await expect(compact).toHaveAttribute("data-mode", "compact");
  await expectComposerEndsAtDock(page.getByRole("region", {
    name: "Message composer",
  }));
  await expect(compact).toHaveAttribute("data-context-state", "near-limit");
  await expect(compact.locator(".usage-context-ring")).toHaveAttribute("data-context-ring-state", "near-limit");
  const toolbarIntegration = await compact.evaluate((control) => {
    const toolbar = control.closest(".composer-toolbar");
    const options = control.parentElement;
    const next = control.nextElementSibling;
    return {
      inComposer: Boolean(control.closest(".composer")),
      inToolbar: Boolean(toolbar),
      parentClass: options?.className ?? "",
      nextLabel: next?.getAttribute("aria-label"),
      detachedUsageRows: document.querySelectorAll(".composer-shell > .composer-usage").length,
      toolbarUsageControls: toolbar?.querySelectorAll('[data-composer-control="usage"]').length ?? 0,
    };
  });
  expect(toolbarIntegration).toEqual({
    inComposer: true,
    inToolbar: true,
    parentClass: "composer-options",
    nextLabel: "Send message",
    detachedUsageRows: 0,
    toolbarUsageControls: 1,
  });
  const compactTrigger = compact.locator(".usage-popover-trigger");
  await expect(compactTrigger).toHaveAccessibleName(
    "Open usage and context. Context window 15% remaining, near limit.",
  );
  await expect(compactTrigger).toHaveAttribute(
    "title",
    "Context window 15% remaining, near limit.",
  );
  await expect(compactTrigger).toHaveAttribute("aria-expanded", "false");
  const ringGeometry = await compact.locator(".usage-context-ring").evaluate((ring) => {
    const bounds = ring.getBoundingClientRect();
    const value = ring.querySelector<SVGCircleElement>(".usage-context-ring-value");
    return {
      width: bounds.width,
      height: bounds.height,
      animations: ring.getAnimations({ subtree: true }).length,
      strokeWidth: value ? getComputedStyle(value).strokeWidth : null,
    };
  });
  expect(ringGeometry.width).toBeGreaterThanOrEqual(23);
  expect(ringGeometry.width).toBeLessThanOrEqual(31);
  expect(ringGeometry.height).toBe(ringGeometry.width);
  expect(ringGeometry.animations).toBe(0);
  expect(ringGeometry.strokeWidth).toBe("1.65px");
  const sendWidth = await page.getByRole("button", { name: "Send message" }).evaluate(
    (button) => button.getBoundingClientRect().width,
  );
  expect(ringGeometry.width).toBeLessThan(sendWidth);
  const contextRingScreenshot = testInfo.outputPath(
    "context-ring-near-limit-1440x920.png",
  );
  await page.screenshot({
    animations: "disabled",
    path: contextRingScreenshot,
    scale: "device",
  });
  await testInfo.attach("context-ring-near-limit-1440x920", {
    path: contextRingScreenshot,
    contentType: "image/png",
  });
  const compactControls = await compactTrigger.getAttribute("aria-controls");
  expect(compactControls).toBeTruthy();
  await expect(page.locator(`#${compactControls}`)).toBeHidden();
  await expect.poll(() => {
    const database = new Database(join(testDirectory, "data", "inertia.sqlite"), { readonly: true });
    const row = database.prepare("SELECT usage_display_mode FROM app_state WHERE id = 1").get() as { usage_display_mode: string };
    database.close();
    return row.usage_display_mode;
  }).toBe("compact");
  await transcript.evaluate((element) => { element.scrollTop = element.scrollHeight; });

  await compactTrigger.focus();
  await compactTrigger.press("Space");
  await expect(compact).toHaveAttribute("data-mode", "compact");
  await expect(compactTrigger).toHaveAttribute("aria-expanded", "true");
  await expect(compactTrigger).toHaveAccessibleName(/^Close usage and context\./u);
  const compactPopover = page.getByRole("dialog", { name: "Usage & context" });
  await expect(compactPopover).toBeVisible();
  await expect(compactPopover.getByText("Context", { exact: true })).toBeVisible();
  await expect(compactPopover.getByText("Provider quota", { exact: true })).toBeVisible();
  const compactPopoverAx = await compactPopover.ariaSnapshot();
  expect(compactPopoverAx).toContain('- dialog "Usage & context"');
  expect(compactPopoverAx).toContain('- button "Close usage and context"');
  await expect.poll(() => {
    const database = new Database(join(testDirectory, "data", "inertia.sqlite"), { readonly: true });
    const row = database.prepare("SELECT usage_display_mode FROM app_state WHERE id = 1").get() as { usage_display_mode: string };
    database.close();
    return row.usage_display_mode;
  }).toBe("compact");

  const closeCompactUsage = compactPopover.getByRole("button", {
    name: "Close usage and context",
  });
  await closeCompactUsage.focus();
  await page.locator(".workspace-header").click({ position: { x: 12, y: 12 } });
  await expect(compactPopover).toBeHidden();
  await expect(compactTrigger).toHaveAttribute("aria-expanded", "false");
  await expect(compactTrigger).toBeFocused();

  await compactTrigger.click();
  await expect(compactPopover).toBeVisible();
  await closeCompactUsage.focus();
  await page.keyboard.press("Escape");
  await expect(compactPopover).toBeHidden();
  await expect(compactTrigger).toHaveAttribute("aria-expanded", "false");
  await expect(compactTrigger).toBeFocused();
  await expect.poll(() => transcript.evaluate((element) =>
    Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop),
  )).toBeLessThanOrEqual(2);

  await compactTrigger.click();
  const composerHeightWithUsage = await page.locator(".composer").evaluate(
    (composer) => composer.getBoundingClientRect().height,
  );
  await compactPopover.getByRole("button", { name: "Hide usage" }).click();
  await expect(page.getByRole("region", { name: "Usage and context" })).toHaveCount(0);
  await expect(page.locator('.composer [data-composer-control="usage"]')).toHaveCount(0);
  await expectComposerEndsAtDock(page.getByRole("region", {
    name: "Message composer",
  }));
  const composerHeightWithoutUsage = await page.locator(".composer").evaluate(
    (composer) => composer.getBoundingClientRect().height,
  );
  expect(Math.abs(composerHeightWithUsage - composerHeightWithoutUsage)).toBeLessThanOrEqual(1);
  await expect.poll(() => {
    const database = new Database(join(testDirectory, "data", "inertia.sqlite"), { readonly: true });
    const row = database.prepare("SELECT usage_display_mode FROM app_state WHERE id = 1").get() as { usage_display_mode: string };
    database.close();
    return row.usage_display_mode;
  }).toBe("hidden");

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const usageModes = page.getByRole("radiogroup", { name: "Usage and context display" });
  await expect(usageModes.getByRole("radio", { name: "Hidden" })).toHaveAttribute("aria-checked", "true");
  await usageModes.getByRole("radio", { name: "Expanded" }).click();
  await page.getByRole("button", { name: "Go to workspace" }).click();
  const expanded = page.getByRole("region", { name: "Usage and context" });
  await expect(expanded).toHaveAttribute("data-mode", "expanded");
  await expectComposerEndsAtDock(page.getByRole("region", {
    name: "Message composer",
  }));
  await expect(expanded.locator(".usage-trigger-value")).toBeVisible();
  const expandedTrigger = expanded.locator(".usage-popover-trigger");
  await expect(expandedTrigger).toHaveAccessibleName(/^Open usage and context\./u);
  await expandedTrigger.click();
  await expect(page.getByRole("dialog", { name: "Usage & context" })).toBeVisible();
  const lightScreenshot = testInfo.outputPath("composer-usage-expanded-light-1440x920.png");
  await page.screenshot({ animations: "disabled", path: lightScreenshot });
  await testInfo.attach("composer-usage-expanded-light-1440x920", {
    path: lightScreenshot,
    contentType: "image/png",
  });
  await page.keyboard.press("Escape");

  const darkStore = new RuntimeStore(databasePath, workspaceDirectory, { recoverInterruptedRuns: false });
  darkStore.updateSettings({
    theme: "dark",
    interfaceScale: "large",
    responseDensity: "comfortable",
  });
  darkStore.close();
  await page.reload();
  await page.getByRole("textbox", { name: "Message" }).waitFor();
  await resizeWindow(760, 680);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("html")).toHaveAttribute("data-interface-scale", "large");
  await expect(page.locator(".chat-workspace")).toHaveClass(/response-density-comfortable/u);
  const narrowUsage = page.getByRole("region", { name: "Usage and context" });
  await expect(narrowUsage).toHaveAttribute("data-mode", "expanded");
  await expectComposerEndsAtDock(page.getByRole("region", {
    name: "Message composer",
  }));
  const narrowGeometry = await narrowUsage.evaluate((control) => {
    const controlBounds = control.getBoundingClientRect();
    const toolbar = control.closest<HTMLElement>(".composer-toolbar");
    const toolbarBounds = toolbar?.getBoundingClientRect();
    const send = toolbar?.querySelector<HTMLElement>('[aria-label="Send message"]');
    const sendBounds = send?.getBoundingClientRect();
    return {
      inToolbar: Boolean(toolbar),
      controlRight: controlBounds.right,
      toolbarRight: toolbarBounds?.right ?? 0,
      centerDelta: sendBounds
        ? Math.abs(
            (controlBounds.top + controlBounds.height / 2)
            - (sendBounds.top + sendBounds.height / 2),
          )
        : Number.POSITIVE_INFINITY,
    };
  });
  expect(narrowGeometry.inToolbar).toBe(true);
  expect(narrowGeometry.controlRight).toBeLessThanOrEqual(narrowGeometry.toolbarRight + 1);
  expect(narrowGeometry.centerDelta).toBeLessThanOrEqual(1);
  await expectNoViewportOverflow();
  const darkNarrowScreenshot = testInfo.outputPath("composer-usage-expanded-dark-large-760x680.png");
  await page.screenshot({ animations: "disabled", path: darkNarrowScreenshot });
  await testInfo.attach("composer-usage-expanded-dark-large-760x680", {
    path: darkNarrowScreenshot,
    contentType: "image/png",
  });
  expect(rendererErrors).toEqual([]);
});

test("applies every interface scale live and remains usable at common Linux display scales", async ({ browserName: _browserName }, testInfo) => {
  await resizeWindow(1440, 920);
  await ensureTerminalTools();
  const terminalFontSize = await page.locator("aside.terminal-panel").first().getAttribute("data-terminal-font-size");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const scaleGroup = page.getByRole("radiogroup", { name: "Interface scale" });
  const expected = [
    ["Compact", "compact", "13px", "30px"],
    ["Default", "default", "14px", "32px"],
    ["Comfortable", "comfortable", "15px", "35px"],
    ["Large", "large", "16.5px", "38px"],
  ] as const;

  for (const [label, value, fontSize, controlHeight] of expected) {
    await scaleGroup.getByRole("radio", { name: label, exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-interface-scale", value);
    const measurements = await page.locator(".app-shell").evaluate((shell) => ({
      fontSize: getComputedStyle(shell).fontSize,
      controlHeight: getComputedStyle(document.documentElement).getPropertyValue("--ui-control-height").trim(),
    }));
    expect(measurements).toEqual({ fontSize, controlHeight });
  }

  for (const zoomFactor of [1, 1.25, 1.5]) {
    await electronApp.evaluate(({ BrowserWindow }, factor) => {
      BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(factor);
    }, zoomFactor);
    await resizeWindow(1920, 1080);
    await expectNoViewportOverflow();
  }

  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(1);
  });
  await resizeWindow(900, 720);
  await expectNoViewportOverflow();
  await expect(page.getByRole("button", { name: "Go to workspace" })).toBeVisible();
  await scaleGroup.getByRole("radio", { name: "Comfortable", exact: true }).click();
  await page.getByRole("button", { name: "Go to workspace" }).click();
  await expect(page.locator("aside.terminal-panel").first()).toHaveAttribute("data-terminal-font-size", terminalFontSize ?? "13");
  await expectNoViewportOverflow();
  const scaledDock = page.getByRole("region", { name: "Message composer" });
  for (const zoomFactor of [1, 1.25, 1.5]) {
    await electronApp.evaluate(({ BrowserWindow }, factor) => {
      BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(factor);
    }, zoomFactor);
    await resizeWindow(1920, 1080);
    await expect(scaledDock.getByRole("button", {
      name: /^Choose model\./u,
    })).toBeVisible();
    await expect(scaledDock.getByRole("region", {
      name: "Usage and context",
    })).toBeVisible();
    await expect(scaledDock.getByRole("button", {
      name: "Send message",
    })).toBeVisible();
    const scaledGeometry = await scaledDock.evaluate((element) => {
      const toolbar = element.querySelector<HTMLElement>(".composer-toolbar");
      const model = element.querySelector<HTMLElement>(".selected-model-chip");
      const label = element.querySelector<HTMLElement>(
        ".selected-model-chip-label",
      );
      const send = element.querySelector<HTMLElement>(
        '[aria-label="Send message"]',
      );
      const toolbarBounds = toolbar?.getBoundingClientRect();
      const modelBounds = model?.getBoundingClientRect();
      const labelBounds = label?.getBoundingClientRect();
      const sendBounds = send?.getBoundingClientRect();
      return {
        dockFits: element.scrollWidth <= element.clientWidth + 1,
        toolbarFits: Boolean(
          toolbar
          && toolbar.scrollWidth <= toolbar.clientWidth + 1,
        ),
        modelLabelContained: Boolean(
          modelBounds
          && labelBounds
          && labelBounds.left >= modelBounds.left - 1
          && labelBounds.right <= modelBounds.right + 1,
        ),
        modelLabelOverflow: label
          ? getComputedStyle(label).overflow
          : "",
        sendContained: Boolean(
          toolbarBounds
          && sendBounds
          && sendBounds.left >= toolbarBounds.left - 1
          && sendBounds.right <= toolbarBounds.right + 1,
        ),
      };
    });
    expect(scaledGeometry).toEqual({
      dockFits: true,
      toolbarFits: true,
      modelLabelContained: true,
      modelLabelOverflow: "hidden",
      sendContained: true,
    });
    await expectNoViewportOverflow();
    if (zoomFactor === 1.25) {
      const shell = page.locator(".app-shell");
      const originalClassName = await shell.getAttribute("class") ?? "";
      await shell.evaluate((element) => {
        for (const className of element.classList) {
          if (className.startsWith("platform-")) {
            element.classList.remove(className);
          }
        }
        element.classList.add("platform-linux");
      });
      await expect(shell).toHaveClass(/platform-linux/u);
      await expectNoViewportOverflow();
      const linuxScaleScreenshot = testInfo.outputPath(
        "linux-platform-scale-125-1920x1080.png",
      );
      await page.screenshot({
        animations: "disabled",
        path: linuxScaleScreenshot,
        scale: "device",
      });
      await testInfo.attach("linux-platform-scale-125-1920x1080", {
        path: linuxScaleScreenshot,
        contentType: "image/png",
      });
      await shell.evaluate((element, className) => {
        element.setAttribute("class", className);
      }, originalClassName);
    }
  }
  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(1);
  });
  await resizeWindow(1440, 920);
  expect(rendererErrors).toEqual([]);
});
