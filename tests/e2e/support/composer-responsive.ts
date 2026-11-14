import { expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { RuntimeStore } from "../../../src/server/database";
import { providerNativeMetadataScope } from "../../../src/server/provider/metadata";
import { providerNativeModelSelection } from "../../../src/shared/model-routing";
import type { AppFixture } from "./app-fixture";

const execFileAsync = promisify(execFile);

export async function expectHoverBackground(page: Page, button: Locator): Promise<string> {
  await page.mouse.move(0, 0);
  await expect.poll(() => button.evaluate((element) => element.matches(":hover"))).toBe(false);
  const idleBackground = await button.evaluate((element) => getComputedStyle(element).backgroundColor);
  await expect.poll(async () => {
    await page.mouse.move(0, 0);
    await button.hover();
    return button.evaluate((element, idle) =>
      element.matches(":hover") && getComputedStyle(element).backgroundColor !== idle,
    idleBackground);
  }).toBe(true);
  return idleBackground;
}

async function paintedSurface(layer: Locator): Promise<{ filter: string; paint: number[]; raised: number[] }> {
  return await layer.evaluate((element) => {
    const style = getComputedStyle(element);
    const probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
    const paint = (color: string): number[] => {
      probe.clearRect(0, 0, 1, 1);
      probe.fillStyle = color;
      probe.fillRect(0, 0, 1, 1);
      return [...probe.getImageData(0, 0, 1, 1).data];
    };
    return {
      filter: style.backdropFilter,
      paint: paint(style.backgroundColor),
      raised: paint(style.getPropertyValue("--surface-raised").trim()),
    };
  });
}

export async function expectGlassLayer(layer: Locator, alpha: number, filter: string): Promise<void> {
  const page = layer.page();
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-transparency", value: "no-preference" }],
  });
  let sample: Awaited<ReturnType<typeof paintedSurface>>;
  try {
    sample = await paintedSurface(layer);
  } finally {
    await session.detach();
  }
  expect(sample.filter).toBe(filter);
  sample.paint.slice(0, 3).forEach((channel, index) => {
    expect(Math.abs(channel - sample.raised[index]!)).toBeLessThanOrEqual(2);
  });
  expect(Math.abs(sample.paint[3]! - Math.round(alpha * 255))).toBeLessThanOrEqual(2);
}

export async function expectSolidRow(row: Locator): Promise<void> {
  const alpha = await row.evaluate((element) => {
    const probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
    probe.fillStyle = getComputedStyle(element).backgroundColor;
    probe.fillRect(0, 0, 1, 1);
    return probe.getImageData(0, 0, 1, 1).data[3];
  });
  expect(alpha).toBe(255);
}

export async function expectSolidComposerSurface(dock: Locator): Promise<void> {
  const sample = await paintedSurface(dock.locator(".composer-surface"));
  expect(sample.filter).toBe("none");
  expect(sample.paint).toEqual(sample.raised);
  expect(sample.paint[3]).toBe(255);
}

export async function expectRoundSendScalesOnHover(page: Page, send: Locator): Promise<void> {
  const face = () => send.evaluate((button: HTMLElement) => ({
    width: button.offsetWidth,
    height: button.offsetHeight,
    radius: getComputedStyle(button).borderTopLeftRadius,
    transform: getComputedStyle(button).transform,
    icon: Math.round(button.querySelector("svg")!.getBoundingClientRect().width),
    visualWidth: Math.round(button.getBoundingClientRect().width * 100) / 100,
  }));
  expect(await face()).toMatchObject({ width: 32, height: 32, radius: "50%", transform: "none", icon: 16 });
  await send.hover();
  await expect.poll(async () => (await face()).visualWidth).toBeCloseTo(33.6, 1);
  await page.mouse.move(4, 4);
  await expect.poll(async () => (await face()).transform).toBe("none");
}

export async function expectSettingChips(settingFamily: Locator): Promise<void> {
  const settingGeometry = await settingFamily.evaluate((element) => {
    const textColor = (scope: Element): string => {
      const probe = document.createElement("span");
      probe.style.color = "var(--text)";
      scope.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    };
    const style = getComputedStyle(element);
    const controls = [...element.querySelectorAll<HTMLButtonElement>(
      "button[data-composer-setting]",
    )];
    return {
      borderLeft: style.borderLeftWidth,
      borderRight: style.borderRightWidth,
      gap: style.columnGap,
      settings: controls.map((control) => control.dataset.composerSetting),
      anatomy: controls.map((control) => [...control.children].map((child) =>
        child.classList.contains("composer-setting-icon")
          ? `icon ${Math.round(child.getBoundingClientRect().width)}`
          : child.classList.contains("composer-setting-chevron")
            ? `chevron ${Math.round(child.getBoundingClientRect().width)} at ${getComputedStyle(child).opacity}`
            : "label").join(" + ")),
      fontWeights: controls.map((control) => getComputedStyle(control).fontWeight),
      labelInk: controls.map((control) => getComputedStyle(control.querySelector(".composer-setting-value")!).color === textColor(element)),
      separators: [...element.querySelectorAll(".composer-setting-control")].map((control) =>
        getComputedStyle(control, "::before").content),
      heights: controls.map((control) =>
        control.getBoundingClientRect().height),
      borders: controls.map((control) =>
        getComputedStyle(control).borderTopWidth),
      fontSizes: controls.map((control) =>
        getComputedStyle(control).fontSize),
      accessSvgs: element.querySelectorAll(
        '[data-composer-setting="access"] svg:not(.composer-setting-chevron)',
      ).length,
      shownIcons: controls.flatMap((control) => {
        const icon = control.querySelector<SVGElement>(".composer-setting-icon");
        return icon && getComputedStyle(icon).display !== "none"
          ? [control.dataset.composerSetting]
          : [];
      }),
    };
  });
  expect(settingGeometry.borderLeft).toBe("0px");
  expect(settingGeometry.borderRight).toBe("0px");
  expect(Math.max(...settingGeometry.heights)
    - Math.min(...settingGeometry.heights)).toBeLessThanOrEqual(1);
  expect(new Set(settingGeometry.borders)).toEqual(new Set(["0px"]));
  expect(new Set(settingGeometry.fontSizes).size).toBe(1);
  expect(settingGeometry.gap).toBe("4px");
  expect(settingGeometry.anatomy).toEqual(settingGeometry.settings.map((setting) =>
    setting === "reasoning" ? "icon 16 + label + chevron 12 at 0.7" : "label + chevron 12 at 0.7"));
  expect(new Set(settingGeometry.fontWeights)).toEqual(new Set(["600"]));
  expect(new Set(settingGeometry.labelInk)).toEqual(new Set([true]));
  expect(new Set(settingGeometry.separators)).toEqual(new Set(["none"]));
  expect(settingGeometry.accessSvgs).toBe(0);
  expect(settingGeometry.shownIcons).toEqual(settingGeometry.settings.filter((setting) => setting === "reasoning"));
}

export async function fixtureCheckoutLabel(
  workspaceDirectory: string,
): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["rev-parse", "--abbrev-ref", "HEAD"],
    { cwd: workspaceDirectory },
  );
  const branch = stdout.trim();
  if (!branch) throw new Error("Composer fixture checkout is unavailable.");
  return branch === "HEAD" ? "Detached HEAD" : branch;
}

export function loadComposerResponsiveFixture(
  databasePath: string,
  workspaceDirectory: string,
): {
  originalProject: ReturnType<RuntimeStore["shellSnapshot"]>["projects"][number];
  restore: () => void;
} {
  const store = new RuntimeStore(databasePath, workspaceDirectory, {
    recoverInterruptedRuns: false,
  });
  const snapshot = store.shellSnapshot();
  const originalProject = snapshot.projects.find(
    ({ id }) => id === snapshot.activeProjectId,
  );
  store.close();
  if (!originalProject) throw new Error("Composer project fixture is unavailable.");
  return {
    originalProject,
    restore: () => {
      const cleanup = new RuntimeStore(databasePath, workspaceDirectory, {
        recoverInterruptedRuns: false,
      });
      cleanup.updateSettings({
        theme: snapshot.settings.theme,
        interfaceScale: snapshot.settings.interfaceScale,
        responseDensity: snapshot.settings.responseDensity,
      });
      cleanup.updateProject(originalProject.id, { name: originalProject.name });
      cleanup.close();
    },
  };
}

interface ComposerResponsiveHelpersInput {
  databasePath: string;
  workspaceDirectory: string;
  projectId: string;
  page: Page;
  testInfo: TestInfo;
}

export function createComposerResponsiveHelpers({
  databasePath,
  workspaceDirectory,
  projectId,
  page,
  testInfo,
}: ComposerResponsiveHelpersInput): {
  updateAppearance: (
    theme: "light" | "dark",
    interfaceScale: "compact" | "default" | "large",
    responseDensity: "compact" | "comfortable",
  ) => void;
  updateProjectName: (name: string) => void;
  setWorkspaceTools: (open: boolean) => Promise<void>;
  capture: (label: string) => Promise<void>;
} {
  return {
    updateAppearance: (theme, interfaceScale, responseDensity) => {
      const store = new RuntimeStore(databasePath, workspaceDirectory, {
        recoverInterruptedRuns: false,
      });
      store.updateSettings({ theme, interfaceScale, responseDensity });
      store.close();
    },
    updateProjectName: (name) => {
      const store = new RuntimeStore(databasePath, workspaceDirectory, {
        recoverInterruptedRuns: false,
      });
      store.updateProject(projectId, { name });
      store.close();
    },
    setWorkspaceTools: async (open) => {
      const visiblePanel = page.locator(".workspace-panel:visible").first();
      const panelIsVisible = await visiblePanel.count() > 0;
      if (panelIsVisible === open) return;
      await page.locator(
        "[data-panel-layout-controls] [data-right-panel-toggle]",
      ).click();
      if (open) {
        await page.locator(".workspace-panel:visible").first()
          .waitFor({ state: "visible" });
        return;
      }
      await page.locator(".workspace-panel:visible")
        .waitFor({ state: "hidden" });
    },
    capture: async (label) => {
      const screenshot = testInfo.outputPath(`${label}.png`);
      await page.screenshot({
        animations: "disabled",
        path: screenshot,
        scale: "device",
      });
      await testInfo.attach(label, {
        path: screenshot,
        contentType: "image/png",
      });
    },
  };
}

export async function exerciseComposerQueue({
  databasePath,
  workspaceDirectory,
  page,
  capture,
}: {
  databasePath: string;
  workspaceDirectory: string;
  page: Page;
  capture: (label: string) => Promise<void>;
}): Promise<void> {
  const store = new RuntimeStore(databasePath, workspaceDirectory, {
    recoverInterruptedRuns: false,
  });
  const conversationId = store.shellSnapshot().activeConversationId;
  if (!conversationId) {
    store.close();
    throw new Error("Composer queue fixture has no active conversation.");
  }
  const originalStatus = store.conversation(conversationId).status;
  store.updateConversation(conversationId, { status: "running" });
  store.close();
  await page.evaluate(({ targetId }) => {
    window.localStorage.setItem(
      `inertia:queued-prompts:v2:${targetId}`,
      JSON.stringify([{
        id: "queued-responsive-proof",
        content: "After this pass, update the release notes and run the full gate",
        createdAt: "2026-08-21T10:00:00.000Z",
        attachments: [],
      }]),
    );
  }, { targetId: conversationId });
  await page.reload();
  try {
    const dock = page.getByRole("region", { name: "Message composer" });
    await expect(dock.getByRole("list", { name: "Queued messages" }))
      .toBeVisible();
    await expect(dock.getByRole("button", { name: "Stop agent" })).toBeVisible();
    expect(await dock.evaluate((element) => {
      const dockBounds = element.getBoundingClientRect();
      const queueBounds = element.querySelector<HTMLElement>(".composer-queue")
        ?.getBoundingClientRect();
      return {
        queueAboveDock: Boolean(queueBounds && queueBounds.bottom <= dockBounds.top),
        queueFitsDock: Boolean(queueBounds
          && queueBounds.left >= dockBounds.left - 1
          && queueBounds.right <= dockBounds.right + 1),
        dockFits: element.scrollWidth <= element.clientWidth + 1,
      };
    })).toEqual({ queueAboveDock: true, queueFitsDock: true, dockFits: true });
    await capture("composer-queue-light-default-1440x920");
  } finally {
    const cleanup = new RuntimeStore(databasePath, workspaceDirectory, {
      recoverInterruptedRuns: false,
    });
    cleanup.updateConversation(conversationId, { status: originalStatus });
    cleanup.close();
    await page.evaluate(({ targetId }) => {
      window.localStorage.removeItem(`inertia:queued-prompts:v2:${targetId}`);
    }, { targetId: conversationId });
    await page.reload();
  }
  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();
}

export async function inspectLongComposerHeading(
  heading: Locator,
): Promise<{
  contained: boolean;
  fits: boolean;
  fontSize: number;
  wraps: boolean;
  projectDecoration: string;
  projectDecorationStyle: string;
}> {
  return await heading.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const transcript = element.closest<HTMLElement>(".message-scroll")
      ?.getBoundingClientRect();
    const projectName = element.querySelector<HTMLElement>(
      ".empty-thread-project",
    );
    const headingStyle = getComputedStyle(element);
    const projectStyle = projectName ? getComputedStyle(projectName) : null;
    return {
      contained: Boolean(
        transcript
        && bounds.left >= transcript.left - 1
        && bounds.right <= transcript.right + 1
      ),
      fits: element.scrollWidth <= element.clientWidth + 1,
      fontSize: Number.parseFloat(headingStyle.fontSize),
      wraps: bounds.height > Number.parseFloat(headingStyle.lineHeight) * 1.5,
      projectDecoration: projectStyle?.textDecorationLine ?? "",
      projectDecorationStyle: projectStyle?.textDecorationStyle ?? "",
    };
  });
}

export function seedLongestComposerLabels(databasePath: string, workspaceDirectory: string): () => void {
  const store = new RuntimeStore(databasePath, workspaceDirectory, { recoverInterruptedRuns: false });
  const cachedAt = new Date().toISOString();
  try {
    const conversationId = store.shellSnapshot().activeConversationId;
    if (!conversationId) throw new Error("Composer conversation fixture is unavailable.");
    const original = store.conversation(conversationId);
    store.saveProviderMetadata({
      scope: providerNativeMetadataScope("codex"),
      models: [{
        id: "gpt-5.6-sol",
        label: "Sol",
        description: "Model with the longest composer chip labels.",
        isDefault: true,
        inputModalities: ["text"],
        reasoningOptions: [
          { value: "high", label: "High", description: "Thorough reasoning." },
          { value: "xhigh", label: "Extra high", description: "Maximum reasoning." },
        ],
        defaultReasoningEffort: "high",
        fastMode: { providerValue: "priority", label: "Fast", description: "Faster replies.", isDefault: false },
      }],
      modelsUpdatedAt: cachedAt,
      modelsLastAttemptedAt: cachedAt,
      modelsProvenance: "provider",
      modelsStale: false,
      rateLimits: [],
      rateLimitsUpdatedAt: null,
      rateLimitsLastAttemptedAt: null,
      rateLimitsProvenance: null,
      rateLimitsStale: false,
    });
    store.updateConversation(conversationId, {
      providerId: "codex",
      modelSelection: providerNativeModelSelection({ providerId: "codex", modelId: "gpt-5.6-sol", alias: "Sol", reasoningEffort: "xhigh" }),
      accessMode: "auto-edit",
    });
    return () => {
      const cleanup = new RuntimeStore(databasePath, workspaceDirectory, { recoverInterruptedRuns: false });
      cleanup.updateConversation(conversationId, {
        providerId: original.providerId,
        modelSelection: original.modelSelection,
        accessMode: original.accessMode,
      });
      cleanup.close();
    };
  } finally {
    store.close();
  }
}

export async function recycleRuntimeAndWait(app: AppFixture): Promise<void> {
  const before = await app.runtimeSnapshot();
  await app.recycleRuntime();
  await expect.poll(async () => {
    const current = await app.runtimeSnapshot();
    return current.phase === "ready" && current.generation > before.generation;
  }, { timeout: 10_000 }).toBe(true);
  await expect(app.page.locator(".app-shell")).toHaveAttribute("data-connection-status", "online", { timeout: 10_000 });
}

async function resizeToComposerWidth(
  page: Page,
  resizeWindow: AppFixture["resizeWindow"],
  dock: Locator,
  target: number,
): Promise<number> {
  const width = async (): Promise<number> => Math.round(await dock.evaluate((element) => element.getBoundingClientRect().width));
  let low = 900;
  let high = 1600;
  let measured = 0;
  while (low <= high) {
    const windowWidth = Math.floor((low + high) / 2);
    await resizeWindow(windowWidth, 820);
    await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
    measured = await width();
    if (measured === target) return measured;
    if (measured < target) low = windowWidth + 1;
    else high = windowWidth - 1;
  }
  return measured;
}

const FOLD_ORDER = ["branch", "mode", "access", "speed", "reasoning"] as const;

async function inspectComposerChipRow(dock: Locator): Promise<{
  folded: string[];
  overflow: boolean;
  labels: string[];
  branch: boolean;
  clipped: string[];
  wrapped: string[];
  railFits: boolean;
  controlsInsideRail: boolean;
}> {
  return await dock.evaluate((element, order) => {
    const shown = (node: Element | null): node is HTMLElement => node instanceof HTMLElement
      && getComputedStyle(node).display !== "none" && node.getBoundingClientRect().width > 0;
    const rail = element.querySelector<HTMLElement>(".composer-primary-rail")!;
    const railBounds = rail.getBoundingClientRect();
    const controls = [...rail.querySelectorAll<HTMLElement>("button")].filter(shown);
    const describe = (node: HTMLElement): string => node.getAttribute("aria-label") ?? node.className;
    return {
      folded: [...element.querySelectorAll<HTMLElement>('[data-composer-fold][data-folded="true"]')]
        .map((node) => node.dataset.composerFold ?? "")
        .sort((first, second) => order.indexOf(first) - order.indexOf(second)),
      overflow: shown(element.querySelector(".composer-more-control")),
      labels: [...element.querySelectorAll<HTMLElement>(".composer-setting-value")].filter(shown).map((label) => label.textContent ?? ""),
      branch: shown(element.querySelector(".composer-branch-control")),
      clipped: [...rail.querySelectorAll<HTMLElement>("*")]
        .filter((node) => shown(node) && getComputedStyle(node).overflowX !== "visible" && node.scrollWidth > node.clientWidth + 1)
        .map(describe),
      wrapped: controls
        .filter((control) => control.getBoundingClientRect().height > rail.clientHeight + 1
          || [...control.querySelectorAll<HTMLElement>("span")].some((span) =>
            span.getClientRects().length > 1))
        .map(describe),
      railFits: rail.scrollWidth <= rail.clientWidth + 1,
      controlsInsideRail: controls.every((control) => {
        const bounds = control.getBoundingClientRect();
        return bounds.left >= railBounds.left - 1 && bounds.right <= railBounds.right + 1;
      }),
    };
  }, [...FOLD_ORDER] as string[]);
}

async function inspectComposerAnatomy(dock: Locator): Promise<{
  rows: number;
  toolbarRowHeight: number;
  toolbarPaddingBottom: string;
  textareaMinHeight: string;
  rightCluster: string[];
  rightGaps: number[];
  iconButtons: number[];
  sendSize: number;
  centersAligned: boolean;
  sendAtRest: { ariaDisabled: string | null; disabled: boolean; accentFill: boolean; accentArrow: boolean };
}> {
  return await dock.evaluate((element) => {
    const shown = (node: Element | null): node is HTMLElement => node instanceof HTMLElement
      && getComputedStyle(node).display !== "none" && node.getBoundingClientRect().width > 0;
    const paint = (property: "color" | "background-color", token: string): string => {
      const probe = document.createElement("span");
      probe.style.setProperty(property, `var(${token})`);
      element.append(probe);
      const value = getComputedStyle(probe).getPropertyValue(property);
      probe.remove();
      return value;
    };
    const toolbar = element.querySelector<HTMLElement>(".composer-toolbar")!;
    const rail = toolbar.querySelector<HTMLElement>(".composer-primary-rail")!;
    const send = toolbar.querySelector<HTMLButtonElement>(".composer-input-actions .send-button")!;
    const textarea = element.querySelector<HTMLTextAreaElement>("textarea")!;
    const cluster = [...rail.children].filter((child) => shown(child) && !child.matches(".composer-options"));
    const usage = rail.querySelector<HTMLElement>(".usage-popover-trigger")!;
    const tools = rail.querySelector<HTMLElement>(".composer-tools-toggle")!;
    const attach = rail.querySelector<HTMLElement>(".composer-attach-actions .icon-button")!;
    const attachGroup = rail.querySelector<HTMLElement>(".composer-attach-actions")!;
    const edges = [usage, tools, attachGroup, send].map((node) => node.getBoundingClientRect());
    const centers = [...toolbar.querySelectorAll<HTMLElement>("button")].filter(shown).map((button) => {
      const bounds = button.getBoundingClientRect();
      return bounds.top + bounds.height / 2;
    });
    const sendStyle = getComputedStyle(send);
    return {
      rows: [...element.children].filter((child) => shown(child) && !child.matches(".composer-surface, .composer-ultra-glow")).length,
      toolbarRowHeight: Number.parseFloat(getComputedStyle(toolbar).gridTemplateRows),
      toolbarPaddingBottom: getComputedStyle(toolbar).paddingBottom,
      textareaMinHeight: getComputedStyle(textarea).minHeight,
      rightCluster: [
        ...cluster.map((child) => child.matches(".composer-actions")
          ? "usage"
          : child.matches(".composer-tools-toggle")
            ? "tools"
            : child.matches(".composer-attach-actions") ? "attach" : child.className),
        "send",
      ],
      rightGaps: edges.slice(1).map((bounds, index) => Math.round(bounds.left - edges[index]!.right)),
      iconButtons: [usage, tools, attach].map((node) => Math.round(node.getBoundingClientRect().width)),
      sendSize: send.offsetWidth,
      centersAligned: Math.max(...centers) - Math.min(...centers) <= 1,
      sendAtRest: {
        ariaDisabled: send.getAttribute("aria-disabled"),
        disabled: send.disabled,
        accentFill: sendStyle.backgroundColor === paint("background-color", "--accent"),
        accentArrow: sendStyle.color === paint("color", "--accent-text"),
      },
    };
  });
}

async function expectBranchChip(dock: Locator, branch: string): Promise<void> {
  const checkout = dock.getByRole("group", { name: "Chat checkout context" });
  const chip = checkout.getByRole("button", { name: `Branch ${branch}`, exact: true });
  await expect(chip).toBeVisible();
  await expect(chip).toHaveAttribute("title", branch);
  expect(await chip.evaluate((button) => {
    const options = button.closest(".composer-options")!;
    const chips = [...options.querySelectorAll<HTMLElement>("button.composer-chip")]
      .filter((node) => getComputedStyle(node).display !== "none" && node.getBoundingClientRect().width > 0);
    const icon = button.querySelector(".composer-setting-icon")!.getBoundingClientRect();
    const chevron = button.querySelector(".composer-setting-chevron")!;
    return {
      last: chips.at(-1) === button,
      icon: Math.round(icon.width),
      chevron: `${Math.round(chevron.getBoundingClientRect().width)} at ${getComputedStyle(chevron).opacity}`,
      weight: getComputedStyle(button).fontWeight,
      heights: new Set(chips.map((node) => Math.round(node.getBoundingClientRect().height))).size,
    };
  })).toEqual({ last: true, icon: 16, chevron: "12 at 0.7", weight: "600", heights: 1 });
  await chip.click();
  await expect(dock.page().getByRole("menu", { name: "Branches" })).toBeVisible();
  await dock.page().keyboard.press("Escape");
  await expect(dock.page().getByRole("menu", { name: "Branches" })).toBeHidden();
}

export async function expectRestingComposerAnatomy(dock: Locator, branch: string): Promise<void> {
  expect(await inspectComposerAnatomy(dock)).toEqual({
    rows: 2,
    toolbarRowHeight: 40,
    toolbarPaddingBottom: "12px",
    textareaMinHeight: "44px",
    rightCluster: ["usage", "tools", "attach", "send"],
    rightGaps: [4, 4, 4],
    iconButtons: [28, 28, 28],
    sendSize: 32,
    centersAligned: true,
    sendAtRest: { ariaDisabled: "true", disabled: false, accentFill: true, accentArrow: true },
  });
  await expectBranchChip(dock, branch);
  const page = dock.page();
  const send = dock.getByRole("button", { name: "Send message" });
  const textbox = dock.getByRole("textbox", { name: "Message" });
  await send.hover({ force: true });
  expect(await send.evaluate((button) => getComputedStyle(button).transform)).toBe("none");
  await textbox.blur();
  await send.focus();
  await page.keyboard.press("Enter");
  await expect(textbox).toBeFocused();
  await expect(textbox).toHaveValue("");
}

export async function expectLongestChipsFoldAtLarge(
  page: Page,
  resizeWindow: AppFixture["resizeWindow"],
  { setWorkspaceTools, capture }: Pick<ReturnType<typeof createComposerResponsiveHelpers>, "setWorkspaceTools" | "capture">,
): Promise<void> {
  await resizeWindow(1440, 920);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-interface-scale", "large");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await setWorkspaceTools(false);
  const dock = page.getByRole("region", { name: "Message composer" });
  await expectSolidComposerSurface(dock);
  expect(await dock.evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(900);
  const longest = ["Extra high", "Standard", "Auto-accept edits", "Build"];
  const screenshotControl = await dock.locator(".composer-attach-actions button").count() > 1;
  await expect.poll(async () => JSON.stringify((await inspectComposerChipRow(dock)).folded))
    .toMatch(screenshotControl ? /^\[(?:"branch")?\]$/u : /^\[\]$/u);
  const fullWidth = await inspectComposerChipRow(dock);
  const branchFolded = fullWidth.folded.length > 0;
  expect(fullWidth).toEqual({
    folded: fullWidth.folded,
    overflow: branchFolded,
    labels: longest,
    branch: !branchFolded,
    clipped: [],
    wrapped: [],
    railFits: true,
    controlsInsideRail: true,
  });
  await capture("composer-longest-chips-dark-large-1440x920");
  const settingsByFold: Record<string, string> = { mode: "Build", access: "Auto-accept edits", speed: "Standard", reasoning: "Extra high" };
  for (const target of [724, 754, 784]) {
    const width = await resizeToComposerWidth(page, resizeWindow, dock, target);
    expect(Math.abs(width - target), `composer width for ${target}`).toBeLessThanOrEqual(4);
    const row = await inspectComposerChipRow(dock);
    expect(row.folded.length, `composer at ${width}px folds`).toBeGreaterThan(0);
    expect(row.folded, `composer at ${width}px folds in order`).toEqual(FOLD_ORDER.slice(0, row.folded.length));
    expect(row, `composer at ${width}px`).toEqual({
      folded: row.folded,
      overflow: true,
      labels: longest.filter((label) => !row.folded.some((key) => settingsByFold[key] === label)),
      branch: false,
      clipped: [],
      wrapped: [],
      railFits: true,
      controlsInsideRail: true,
    });
  }
  await capture("composer-longest-chips-folded-dark-large");
}
