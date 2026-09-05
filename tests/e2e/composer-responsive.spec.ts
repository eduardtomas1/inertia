import { openLocalProjectFromDialog } from "./support/add-project";
import { expect, test, type Locator } from "@playwright/test";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { expectComposerEndsAtDock, expectComposerReadinessContained } from "./support/layout-assertions";
import { createAppFixture, type AppFixture } from "./support/app-fixture";
import {
  createComposerResponsiveHelpers,
  exerciseComposerQueue,
  fixtureCheckoutLabel,
  inspectLongComposerHeading,
  loadComposerResponsiveFixture,
} from "./support/composer-responsive";
let app!: AppFixture;
let electronApp!: AppFixture["electronApp"];
let page!: AppFixture["page"];
let testDirectory!: AppFixture["testDirectory"];
let workspaceDirectory!: AppFixture["workspaceDirectory"];
let attachmentImagePath!: AppFixture["attachmentImagePath"];
let attachmentDocumentPath!: AppFixture["attachmentDocumentPath"];
let rendererErrors!: AppFixture["rendererErrors"];
let runtimeSnapshot!: AppFixture["runtimeSnapshot"];
let resizeWindow!: AppFixture["resizeWindow"];
let expectNoViewportOverflow!: AppFixture["expectNoViewportOverflow"];

async function expectHoverBackground(button: Locator): Promise<string> {
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

test.beforeAll(async () => {
  app = await createAppFixture({ name: "composer-responsive", initialState: "conversation", windowDisplay: "primary" });
  electronApp = app.electronApp;
  page = app.page;
  testDirectory = app.testDirectory;
  workspaceDirectory = app.workspaceDirectory;
  attachmentImagePath = app.attachmentImagePath;
  attachmentDocumentPath = app.attachmentDocumentPath;
  rendererErrors = app.rendererErrors;
  runtimeSnapshot = app.runtimeSnapshot;
  resizeWindow = app.resizeWindow;
  expectNoViewportOverflow = app.expectNoViewportOverflow;
});

test.afterAll(async () => {
  await app.close();
});

test("keeps the composer as one cohesive dock across themes and responsive splits", async ({ browserName: _browserName }, testInfo) => {
  if (await page.getByRole("textbox", { name: "Message" }).count() === 0) {
    await expect.poll(
      async () => (await runtimeSnapshot()).phase,
      { timeout: 10_000 },
    ).toBe("ready");
    await expect(
      page.getByRole("complementary", {
        name: "Project navigation",
        exact: true,
      }).getByRole("button", { name: "Add project", exact: true }),
    ).toBeEnabled({ timeout: 10_000 });
    await electronApp.evaluate(({ dialog }, directory) => {
      Reflect.set(dialog, "showOpenDialog", async () => ({
        canceled: false,
        filePaths: [directory],
        bookmarks: [],
      }));
    }, workspaceDirectory);
    const addProject = page.getByRole("button", {
      name: "Add your first project",
    });
    await expect(addProject).toBeEnabled();
    await addProject.click();
    await openLocalProjectFromDialog(page);
    await expect(page.getByRole("heading", {
      name: /^What should we build in .+\?$/u,
      level: 3,
    })).toBeVisible();
    await page.getByRole("complementary", {
      name: "Project navigation",
      exact: true,
    })
      .getByRole("button", { name: "New chat", exact: true })
      .click();
    await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
  }
  const databasePath = join(testDirectory, "data", "inertia.sqlite");
  const expectedCheckoutLabel = await fixtureCheckoutLabel(workspaceDirectory);
  const { originalProject, restore } = loadComposerResponsiveFixture(databasePath, workspaceDirectory);
  const navigation = page.getByRole("complementary", {
    name: "Project navigation",
    exact: true,
  });
  const navigationWasVisible = await navigation.isVisible();
  const workspacePanelWasVisible = await page.locator(
    ".workspace-panel:visible",
  ).count() > 0;
  const {
    updateAppearance,
    updateProjectName,
    setWorkspaceTools,
    capture,
  } = createComposerResponsiveHelpers({
    databasePath,
    workspaceDirectory,
    projectId: originalProject.id,
    page,
    testInfo,
  });
  try {
    updateAppearance("light", "default", "compact");
    await resizeWindow(1440, 920);
    await page.reload();
    const textbox = page.getByRole("textbox", { name: "Message" });
    await expect(textbox).toBeVisible();
    await expect(page.getByRole("heading", {
      name: "What should we build in Inertia?",
      level: 3,
    })).toBeVisible();
    await expect(page.locator(".empty-thread-icon")).toHaveCount(0);
    await expect(page.getByText(
      "Describe the outcome you want. The details can take shape together.",
      { exact: true },
    )).toHaveCount(0);
    await setWorkspaceTools(false);

    const longProjectName =
      "A deliberately long project identity that still wraps safely inside the canvas";
    updateProjectName(longProjectName);
    await page.reload();
    await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
    await setWorkspaceTools(false);
    const longHeading = page.getByRole("heading", {
      name: `What should we build in ${longProjectName}?`,
      level: 3,
    });
    await expect(longHeading).toBeVisible();
    const longHeadingGeometry = await inspectLongComposerHeading(longHeading);
    expect(longHeadingGeometry).toMatchObject({
      contained: true,
      fits: true,
      wraps: true,
      projectDecoration: "none",
      projectDecorationStyle: "solid",
    });
    expect(longHeadingGeometry.fontSize).toBeGreaterThanOrEqual(26);
    expect(longHeadingGeometry.fontSize).toBeLessThanOrEqual(34);
    updateProjectName(originalProject.name);
    await page.reload();
    await expect(page.getByRole("heading", {
      name: `What should we build in ${originalProject.name}?`,
      level: 3,
    })).toBeVisible();
    await setWorkspaceTools(false);

    const dock = page.getByRole("region", { name: "Message composer" });
    await expect(dock.getByRole("group", { name: "Chat checkout context" }))
      .toContainText(expectedCheckoutLabel);
    await expectComposerEndsAtDock(dock);
    await expectComposerReadinessContained(dock);
    const model = dock.getByRole("button", { name: /^Choose model\./u });
    const usage = dock.getByRole("region", { name: "Usage and context" });
    const send = dock.getByRole("button", { name: "Send message" });
    await expect(dock).toHaveAttribute("aria-busy", "false");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(page.locator("html")).toHaveAttribute(
      "data-interface-scale",
      "default",
    );
    await expect(page.locator(".chat-workspace")).toHaveClass(
      /response-density-compact/u,
    );
    await expect(model).toBeVisible();
    await expect(usage).toBeVisible();
    await expect(send).toBeVisible();
    await expect(dock.getByRole("button", { name: "Choose project access" }))
      .toBeVisible();
    await expect(dock.getByRole("button", { name: "Choose work mode" }))
      .toBeVisible();

    const wideGeometry = await dock.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const shellBounds = element.parentElement?.getBoundingClientRect();
      const computed = getComputedStyle(element);
      const inputZone = element.querySelector<HTMLElement>(
        '[data-composer-zone="input"]',
      );
      const toolbarElement = element.querySelector<HTMLElement>(".composer-toolbar");
      const textarea = element.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Message"]',
      );
      const inputStyle = inputZone ? getComputedStyle(inputZone) : null;
      const toolbarStyle = toolbarElement ? getComputedStyle(toolbarElement) : null;
      const textareaStyle = textarea ? getComputedStyle(textarea) : null;
      const visibleControlHeights = [...element.querySelectorAll<HTMLElement>(
        '.composer-primary-rail button, .composer-primary-rail [role="region"] > button',
      )].filter((control) => {
        const style = getComputedStyle(control);
        const bounds = control.getBoundingClientRect();
        return style.display !== "none"
          && style.visibility !== "hidden"
          && bounds.width > 0
          && bounds.height > 0;
      }).map((control) => control.getBoundingClientRect().height);
      const optionMarkers = [...element.querySelectorAll<HTMLElement>(
        ".composer-options > *, .composer-setting-family > *, .composer-actions > *",
      )].map((control) => {
        if (control.classList.contains("model-chooser-anchor")) return "model";
        if (control.classList.contains("composer-reasoning-control")) return "reasoning";
        if (control.classList.contains("composer-access-control")) return "access";
        if (control.classList.contains("composer-mode-control")) return "mode";
        if (control.matches('[data-composer-control="usage"]')) return "usage";
        if (control.matches('[aria-label="Send message"]')) return "send";
        return null;
      }).filter(Boolean);
      return {
        width: bounds.width,
        centerDelta: shellBounds
          ? Math.abs(
              (bounds.left + bounds.right) / 2
              - (shellBounds.left + shellBounds.right) / 2,
            )
          : Number.POSITIVE_INFINITY,
        backdropFilter: computed.backdropFilter,
        webkitBackdropFilter: computed.getPropertyValue("-webkit-backdrop-filter"),
        backgroundColor: inputStyle?.backgroundColor,
        shellOrder: [...(element.parentElement?.children ?? [])].map((child) =>
          child === element
            ? "dock"
            : child.classList.contains("chat-goal-control")
              ? "goal"
              : "unexpected"),
        readinessOutside: document.querySelectorAll(
          ".composer-shell > .provider-readiness",
        ).length,
        permanentFooter: document.querySelectorAll(
          ".composer-footer, .composer-note",
        ).length,
        detachedUsage: document.querySelectorAll(
          ".composer-shell > [data-composer-control='usage']",
        ).length,
        dockFits: element.scrollWidth <= element.clientWidth + 1,
        toolbarFits: toolbarElement
          ? toolbarElement.scrollWidth <= toolbarElement.clientWidth + 1
          : false,
        zoneOrder: [...element.children].flatMap((child) =>
          child.classList.contains("composer-input-zone")
            ? ["input"]
            : child.classList.contains("composer-toolbar") ? ["controls"] : []),
        inputPaddingInline: inputStyle?.paddingInline,
        inputPaddingBlock: inputStyle?.paddingBlock,
        toolbarBorderTop: toolbarStyle?.borderTopWidth,
        toolbarBackground: toolbarStyle?.backgroundColor,
        toolbarGroups: [...(toolbarElement?.querySelectorAll<HTMLElement>(
          ":scope > .composer-primary-rail > .composer-options, :scope > .composer-primary-rail > .composer-tools, :scope > .composer-primary-rail > .composer-actions",
        ) ?? [])].map((group) => group.className.replace("composer-", "")),
        checkoutText: toolbarElement
          ?.querySelector<HTMLElement>(".composer-checkout-strip")
          ?.innerText ?? "",
        textareaBorder: textareaStyle?.borderTopWidth,
        textareaBackground: textareaStyle?.backgroundColor,
        controlHeightDelta: visibleControlHeights.length > 0
          ? Math.max(...visibleControlHeights) - Math.min(...visibleControlHeights)
          : Number.POSITIVE_INFINITY,
        optionMarkers,
      };
    });
    expect(wideGeometry.width).toBeGreaterThanOrEqual(858);
    expect(wideGeometry.width).toBeLessThanOrEqual(862);
    expect(wideGeometry.centerDelta).toBeLessThanOrEqual(1);
    expect(wideGeometry.backdropFilter).toBe("none");
    expect(["", "none"]).toContain(wideGeometry.webkitBackdropFilter);
    expect(wideGeometry.backgroundColor).not.toMatch(/rgba\([^)]*,\s*0(?:\.0+)?\)/u);
    expect(wideGeometry.shellOrder).toEqual(["dock"]);
    expect(wideGeometry.readinessOutside).toBe(0);
    expect(wideGeometry.permanentFooter).toBe(0);
    expect(wideGeometry.detachedUsage).toBe(0);
    expect(wideGeometry.dockFits).toBe(true);
    expect(wideGeometry.toolbarFits).toBe(true);
    expect(wideGeometry.zoneOrder).toEqual(["input", "controls"]);
    expect(wideGeometry.inputPaddingInline).toBe("18px 105px");
    expect(wideGeometry.inputPaddingBlock).toBe("16px 15px");
    expect(wideGeometry.toolbarBorderTop).toBe("1px");
    expect(wideGeometry.toolbarBackground)
      .not.toBe(wideGeometry.textareaBackground);
    expect(wideGeometry.toolbarGroups).toEqual(["options", "tools", "actions"]);
    expect(wideGeometry.checkoutText).toContain("Current checkout");
    expect(wideGeometry.checkoutText).toContain(expectedCheckoutLabel);
    expect(wideGeometry.textareaBorder).toBe("0px");
    expect(wideGeometry.textareaBackground).toBe("rgba(0, 0, 0, 0)");
    expect(wideGeometry.controlHeightDelta).toBeLessThanOrEqual(1);
    expect(wideGeometry.optionMarkers.filter((marker) => marker !== "reasoning"))
      .toEqual([
      "model",
      "access",
      "mode",
      "usage",
    ]);
    if (wideGeometry.optionMarkers.includes("reasoning")) {
      expect(wideGeometry.optionMarkers.indexOf("reasoning")).toBe(1);
    }
    await expect(send).toBeDisabled();
    await expectHoverBackground(model);
    await model.focus();
    await expect(model).toBeFocused();
    expect(await model.evaluate(
      (button) => Number.parseFloat(getComputedStyle(button).outlineWidth),
    )).toBeGreaterThanOrEqual(2);
    await model.click();
    await expect(model).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Escape");
    await expect(model).toHaveAttribute("aria-expanded", "false");

    const settingFamily = dock.getByRole("group", {
      name: "Composer settings",
    });
    const accessTrigger = dock.locator('[data-composer-setting="access"]');
    const modeTrigger = dock.locator('[data-composer-setting="mode"]');
    const reasoningTrigger = dock.locator(
      '[data-composer-setting="reasoning"]',
    );
    await expect(settingFamily).toBeVisible();
    const settingGeometry = await settingFamily.evaluate((element) => {
      const style = getComputedStyle(element);
      const controls = [...element.querySelectorAll<HTMLButtonElement>(
        "button[data-composer-setting]",
      )];
      return {
        borderLeft: style.borderLeftWidth,
        borderRight: style.borderRightWidth,
        heights: controls.map((control) =>
          control.getBoundingClientRect().height),
        borders: controls.map((control) =>
          getComputedStyle(control).borderTopWidth),
        fontSizes: controls.map((control) =>
          getComputedStyle(control).fontSize),
        iconSizes: controls.map((control) => {
          const icon = control.querySelector<SVGElement>(
            ".composer-setting-icon",
          );
          const bounds = icon?.getBoundingClientRect();
          return bounds
            ? { width: bounds.width, height: bounds.height }
            : null;
        }),
      };
    });
    expect(settingGeometry.borderLeft).toBe("0px");
    expect(settingGeometry.borderRight).toBe("0px");
    expect(Math.max(...settingGeometry.heights)
      - Math.min(...settingGeometry.heights)).toBeLessThanOrEqual(1);
    expect(new Set(settingGeometry.borders)).toEqual(new Set(["0px"]));
    expect(new Set(settingGeometry.fontSizes).size).toBe(1);
    expect(settingGeometry.iconSizes).toEqual(
      settingGeometry.iconSizes.map(() => ({ width: 13, height: 13 })),
    );
    const accessIdleBackground = await expectHoverBackground(accessTrigger);
    await accessTrigger.focus();
    expect(await accessTrigger.evaluate(
      (button) => Number.parseFloat(getComputedStyle(button).outlineWidth),
    )).toBeGreaterThanOrEqual(2);
    await accessTrigger.click();
    expect(await accessTrigger.evaluate(
      (button) => getComputedStyle(button).backgroundColor,
    )).not.toBe(accessIdleBackground);
    await page.keyboard.press("Escape");

    const directSettings = [
      {
        trigger: accessTrigger,
        menu: page.getByRole("menu", { name: "Project access" }),
      },
      {
        trigger: modeTrigger,
        menu: page.getByRole("menu", { name: "Work mode" }),
      },
      ...(await reasoningTrigger.count() > 0
        ? [{
            trigger: reasoningTrigger,
            menu: page.getByRole("menu", { name: "Reasoning level" }),
          }]
        : []),
    ];
    for (const setting of directSettings) {
      await setting.trigger.focus();
      await setting.trigger.press("ArrowDown");
      await expect(setting.menu).toBeVisible();
      const options = setting.menu.getByRole("menuitemradio");
      await expect(options.first()).toBeFocused();
      await page.keyboard.press("End");
      await expect(options.last()).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(setting.menu).toBeHidden();
      await expect(setting.trigger).toBeFocused();

      await setting.trigger.click();
      await expect(setting.menu).toBeVisible();
      await page.locator(".workspace-header").click({
        position: { x: 12, y: 12 },
      });
      await expect(setting.menu).toBeHidden();
      await expect(setting.trigger).toBeFocused();

      await setting.trigger.click();
      await setting.menu.locator(
        '[role="menuitemradio"][aria-checked="true"]',
      ).click();
      await expect(setting.menu).toBeHidden();
      await expect(setting.trigger).toBeFocused();
    }

    await accessTrigger.click();
    await expect(page.getByRole("menu", { name: "Project access" }))
      .toBeVisible();
    await modeTrigger.click();
    await expect(page.getByRole("menu", { name: "Project access" }))
      .toBeHidden();
    await expect(page.getByRole("menu", { name: "Work mode" })).toBeVisible();
    await expect(modeTrigger).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(modeTrigger).toBeFocused();

    await accessTrigger.click();
    await expect(page.getByRole("menu", { name: "Project access" }))
      .toBeVisible();
    await capture("composer-controls-access-light-default-1440x920");
    await page.keyboard.press("Escape");

    const initialTextareaHeight = await textbox.evaluate(
      (element) => element.getBoundingClientRect().height,
    );
    await textbox.fill(
      [
        "Plan a focused composer pass.",
        "Keep previews inside the dock.",
        "Preserve route boundaries.",
        "Keep controls aligned.",
      ].join("\n"),
    );
    await page.waitForTimeout(200);
    const grownTextareaHeight = await textbox.evaluate(
      (element) => element.getBoundingClientRect().height,
    );
    expect(grownTextareaHeight).toBeGreaterThan(initialTextareaHeight);
    expect(grownTextareaHeight).toBeLessThanOrEqual(176);
    await textbox.fill("");
    await capture("composer-dock-light-default-1440x920");
    await exerciseComposerQueue({
      databasePath, workspaceDirectory, page, capture,
    });

    await electronApp.evaluate(({ dialog }, paths) => {
      Reflect.set(dialog, "showOpenDialog", async () => ({
        canceled: false,
        filePaths: paths,
        bookmarks: [],
      }));
    }, [attachmentImagePath, attachmentDocumentPath]);
    await dock.getByRole("button", {
      name: "Attach images, documents, or spreadsheets",
    }).click();
    const attachmentList = dock.getByRole("list", { name: "Attachments" });
    const attachmentImage = attachmentList.locator("img");
    await expect(attachmentImage).toHaveCount(1);
    await expect.poll(async () => await attachmentImage.evaluate((element) => {
      const image = element as HTMLImageElement;
      return {
        complete: image.complete,
        decoded: image.naturalHeight > 0 && image.naturalWidth > 0,
      };
    })).toEqual({
      complete: true,
      decoded: true,
    });
    await expect(attachmentList.getByText("PNG image · 68 B", {
      exact: true,
    })).toBeVisible();
    await expect(attachmentList.getByText(
      `PDF document · ${(await stat(attachmentDocumentPath)).size} B`, { exact: true },
    )).toBeVisible();
    await expect(dock.getByText(
      "Document preview is available, but this route cannot read documents. Remove it before sending.",
      { exact: true },
    )).toHaveCount(0);
    await textbox.fill("Summarize the attached document.");
    await expect(dock.getByRole("button", { name: "Send message" }))
      .toBeEnabled();
    await textbox.fill("");
    await expectComposerEndsAtDock(dock);
    const attachmentGeometry = await attachmentList.evaluate((list) => {
      const items = [...list.querySelectorAll<HTMLElement>(
        ".composer-attachment",
      )];
      const thumbnails = [...list.querySelectorAll<HTMLElement>(
        ".composer-attachment-preview",
      )];
      return {
        listHeight: list.getBoundingClientRect().height,
        itemHeights: items.map((item) => item.getBoundingClientRect().height),
        itemBorders: items.map((item) => getComputedStyle(item).borderTopWidth),
        itemBackgrounds: items.map(
          (item) => getComputedStyle(item).backgroundColor,
        ),
        thumbnailSizes: thumbnails.map((thumbnail) => {
          const bounds = thumbnail.getBoundingClientRect();
          return { width: bounds.width, height: bounds.height };
        }),
      };
    });
    expect(attachmentGeometry.listHeight).toBeLessThanOrEqual(80);
    expect(Math.max(...attachmentGeometry.itemHeights)).toBeLessThanOrEqual(38);
    expect(attachmentGeometry.itemBorders).toEqual(["0px", "0px"]);
    expect(attachmentGeometry.itemBackgrounds).toEqual([
      "rgba(0, 0, 0, 0)",
      "rgba(0, 0, 0, 0)",
    ]);
    expect(attachmentGeometry.thumbnailSizes).toHaveLength(2);
    for (const size of attachmentGeometry.thumbnailSizes) {
      expect(size.width).toBeCloseTo(32, 2);
      expect(size.height).toBeCloseTo(32, 2);
    }
    await capture("composer-zones-attachment-light-1440x920");
    await attachmentList.getByRole("button", {
      name: "Remove attachment preview.png",
    }).click();
    await attachmentList.getByRole("button", {
      name: "Remove attachment notes.pdf",
    }).click();
    await expect(attachmentList).toHaveCount(0);

    updateAppearance("dark", "large", "comfortable");
    await page.reload();
    await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.locator("html")).toHaveAttribute(
      "data-interface-scale",
      "large",
    );
    await expect(page.locator(".chat-workspace")).toHaveClass(
      /response-density-comfortable/u,
    );
    await expectComposerEndsAtDock(dock);
    await expectComposerReadinessContained(dock);
    await setWorkspaceTools(false);
    await capture("composer-dock-dark-large-1440x920");
    const darkModeTrigger = page.locator(
      '[data-composer-setting="mode"]',
    );
    await darkModeTrigger.click();
    await expect(page.getByRole("menu", { name: "Work mode" })).toBeVisible();
    await capture("composer-controls-mode-dark-large-1440x920");
    await page.keyboard.press("Escape");

    await setWorkspaceTools(true);
    await resizeWindow(1180, 720);
    const splitDock = page.getByRole("region", { name: "Message composer" });
    await expectComposerEndsAtDock(splitDock);
    await expectComposerReadinessContained(splitDock);
    await expect(splitDock.getByRole("button", { name: /^Choose model\./u }))
      .toBeVisible();
    await expect(splitDock.getByRole("region", { name: "Usage and context" }))
      .toBeVisible();
    await expect(splitDock.getByRole("button", { name: "Send message" }))
      .toBeVisible();
    await expect(splitDock.getByRole("button", {
      name: "More composer options",
    })).toBeVisible();
    await expect(splitDock.getByRole("group", {
      name: "Composer settings",
    })).toBeHidden();
    const splitFits = await splitDock.evaluate((element) => {
      const toolbarElement = element.querySelector<HTMLElement>(".composer-toolbar");
      return element.scrollWidth <= element.clientWidth + 1
        && Boolean(
          toolbarElement
          && toolbarElement.scrollWidth <= toolbarElement.clientWidth + 1,
        );
    });
    expect(splitFits).toBe(true);
    expect(await splitDock.getByRole("textbox", { name: "Message" }).evaluate(
      (element) => getComputedStyle(element).overflowY,
    )).toBe("hidden");
    const splitMore = splitDock.getByRole("button", {
      name: "More composer options",
    });
    await splitMore.focus();
    await splitMore.press("ArrowDown");
    const splitMoreMenu = page.getByRole("menu", {
      name: "More composer options",
    });
    await expect(splitMoreMenu).toBeVisible();
    await expect(splitMoreMenu.locator("button:not(:disabled)").first())
      .toBeFocused();
    const splitAccessItem = splitMoreMenu.getByRole("menuitem", {
      name: /^Access\b/u,
    });
    await splitAccessItem.focus();
    await splitAccessItem.press("ArrowRight");
    const splitAccessMenu = page.getByRole("menu", {
      name: "Access options",
    });
    await expect(splitAccessMenu).toBeVisible();
    await expect(splitAccessMenu.getByRole("menuitemradio").first())
      .toBeFocused();
    await expect(splitDock.locator(".composer-more-submenu")).toHaveCount(0);
    const splitPopoverGeometry = await splitDock.evaluate((element) => {
      const workspace = element.closest<HTMLElement>(".workspace-body");
      const rootMenu = element.querySelector<HTMLElement>(
        "#composer-more-menu",
      );
      const workspaceBounds = workspace?.getBoundingClientRect();
      const rootBounds = rootMenu?.getBoundingClientRect();
      return {
        workspaceLeft: workspaceBounds?.left ?? Number.POSITIVE_INFINITY,
        workspaceRight: workspaceBounds?.right ?? Number.NEGATIVE_INFINITY,
        rootLeft: rootBounds?.left ?? Number.NEGATIVE_INFINITY,
        rootRight: rootBounds?.right ?? Number.POSITIVE_INFINITY,
      };
    });
    expect(splitPopoverGeometry.rootLeft)
      .toBeGreaterThanOrEqual(splitPopoverGeometry.workspaceLeft);
    expect(splitPopoverGeometry.rootRight)
      .toBeLessThanOrEqual(splitPopoverGeometry.workspaceRight);
    await capture("composer-controls-more-access-dark-split-1180x720");
    await page.keyboard.press("Escape");
    await expect(splitMoreMenu).toBeHidden();
    await expect(splitMore).toBeFocused();
    await splitMore.click();
    await expect(splitMoreMenu).toBeVisible();
    await page.locator(".workspace-header").click({
      position: { x: 12, y: 12 },
    });
    await expect(splitMoreMenu).toBeHidden();
    await expect(splitMore).toBeFocused();
    await expectNoViewportOverflow();
    await capture("composer-dock-dark-split-1180x720");

    await resizeWindow(1024, 760);
    const stackedDock = page.getByRole("region", {
      name: "Message composer",
    });
    const stackedModel = stackedDock.getByRole("button", {
      name: /^Choose model\./u,
    });
    await expect(stackedModel).toBeVisible();
    await stackedModel.click();
    const stackedModelChooser = page.getByRole("dialog", {
      name: "Choose model",
    });
    await expect(stackedModelChooser).toBeVisible();
    const stackedModelChooserGeometry = await page.evaluate(() => {
      const viewport = {
        top: 0,
        right: window.innerWidth,
        bottom: window.innerHeight,
        left: 0,
      };
      const workspace = document.querySelector<HTMLElement>(".workspace-frame")
        ?.getBoundingClientRect();
      const chat = document.querySelector<HTMLElement>(".chat-workspace")
        ?.getBoundingClientRect();
      const tools = document.querySelector<HTMLElement>(".workspace-panel")
        ?.getBoundingClientRect();
      const chooser = document.querySelector<HTMLElement>(
        ".model-chooser-palette",
      )?.getBoundingClientRect();
      const toolbar = document.querySelector<HTMLElement>(
        ".composer-toolbar",
      );
      if (!workspace || !chat || !tools || !chooser || !toolbar) return null;
      return {
        horizontalSplit: chat.bottom <= tools.top + 1,
        chooserBounds: {
          top: chooser.top,
          right: chooser.right,
          bottom: chooser.bottom,
          left: chooser.left,
        },
        workspaceBounds: {
          top: workspace.top,
          right: workspace.right,
          bottom: workspace.bottom,
          left: workspace.left,
        },
        viewport,
        chooserInsideViewport:
          chooser.top >= viewport.top - 1
          && chooser.right <= viewport.right + 1
          && chooser.bottom <= viewport.bottom + 1
          && chooser.left >= viewport.left - 1,
        chooserInsideWorkspace:
          chooser.top >= workspace.top - 1
          && chooser.right <= workspace.right + 1
          && chooser.bottom <= workspace.bottom + 1
          && chooser.left >= workspace.left - 1,
        toolbarFits: toolbar.scrollWidth <= toolbar.clientWidth + 1,
      };
    });
    await capture("composer-model-chooser-dark-stacked-1024x760");
    expect(
      stackedModelChooserGeometry,
      JSON.stringify(stackedModelChooserGeometry),
    ).toMatchObject({
      horizontalSplit: true,
      chooserInsideViewport: true,
      chooserInsideWorkspace: true,
      toolbarFits: true,
    });
    await page.keyboard.press("Escape");
    const stackedUsageTrigger = stackedDock.locator(
      ".usage-popover-trigger",
    );
    await stackedUsageTrigger.click();
    const stackedUsagePopover = page.getByRole("dialog", {
      name: "Usage & context",
    });
    await expect(stackedUsagePopover).toBeVisible();
    const stackedUsageGeometry = await stackedUsagePopover.evaluate(
      (element) => {
        const bounds = element.getBoundingClientRect();
        const workspace = element.closest<HTMLElement>(".workspace-frame")
          ?.getBoundingClientRect();
        return {
          insideViewport:
            bounds.top >= -1
            && bounds.right <= window.innerWidth + 1
            && bounds.bottom <= window.innerHeight + 1
            && bounds.left >= -1,
          insideWorkspace: Boolean(
            workspace
            && bounds.top >= workspace.top - 1
            && bounds.right <= workspace.right + 1
            && bounds.bottom <= workspace.bottom + 1
            && bounds.left >= workspace.left - 1,
          ),
        };
      },
    );
    expect(stackedUsageGeometry).toEqual({
      insideViewport: true,
      insideWorkspace: true,
    });
    await capture("composer-context-popover-dark-stacked-1024x760");
    await page.keyboard.press("Escape");

    await setWorkspaceTools(false);
    await resizeWindow(760, 680);
    const closeNavigation = navigation.getByRole("button", { name: "Close navigation" });
    if (await closeNavigation.isVisible()) await closeNavigation.click();
    await expect(navigation).toBeHidden();
    const narrowDock = page.getByRole("region", { name: "Message composer" });
    await expectComposerEndsAtDock(narrowDock);
    await expectComposerReadinessContained(narrowDock);
    await expect(narrowDock.getByRole("button", { name: /^Choose model\./u }))
      .toBeVisible();
    await expect(narrowDock.getByRole("region", { name: "Usage and context" }))
      .toBeVisible();
    await expect(narrowDock.getByRole("button", { name: "Send message" }))
      .toBeVisible();
    const narrowMore = narrowDock.locator(".composer-more-control");
    if (await narrowMore.isVisible()) {
      await expect(narrowMore.getByRole("button", {
        name: "More composer options",
      })).toBeVisible();
    } else {
      await expect(narrowDock.getByRole("button", {
        name: "Choose project access",
      })).toBeVisible();
      await expect(narrowDock.getByRole("button", {
        name: "Choose work mode",
      })).toBeVisible();
    }
    await expectNoViewportOverflow();
    expect(await narrowDock.evaluate((element) =>
      element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await capture("composer-zones-dark-narrow-760x680");
  } finally {
    restore();
    await resizeWindow(1440, 920);
    await page.reload();
    await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible({
      timeout: 10_000,
    });
    if (await navigation.isVisible() !== navigationWasVisible) {
      await page.getByRole("button", { name: "Toggle project navigation" }).click();
    }
    await setWorkspaceTools(workspacePanelWasVisible);
  }
  expect(rendererErrors).toEqual([]);
});
