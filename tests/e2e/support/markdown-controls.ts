import {
  expect,
  type ElectronApplication,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";

export async function revealVirtualizedTimelineTurn(input: {
  page: Page;
  target: Locator;
  index: number;
  lastIndex: number;
}): Promise<void> {
  const { page, target, index, lastIndex } = input;
  const virtualRows = page.locator(".response-virtual-item");
  await expect.poll(() => virtualRows.count()).toBeGreaterThan(0);
  if (await target.count() === 0) {
    const minimap = page.getByRole("navigation", {
      name: "Conversation minimap",
    });
    if (await minimap.isVisible().catch(() => false)) {
      const markers = minimap.getByRole("button");
      await expect(markers).toHaveCount(lastIndex + 1);
      await markers.nth(index).click();
      await expect(target).toHaveCount(1);
    }
    if (await target.count() === 0) {
      const transcript = page.locator(".message-scroll");
      await transcript.evaluate((element, position) => {
        const maximum = element.scrollHeight - element.clientHeight;
        element.scrollTop = maximum * position;
      }, index / lastIndex);
      await expect.poll(async () => {
        if (await target.count() === 1) return true;
        const mounted = await virtualRows
          .evaluateAll((items) => items.map((item) =>
            Number((item as HTMLElement).dataset.index)));
        if (mounted.length === 0) return false;
        await transcript.evaluate((element, direction) => {
          const step = Math.max(100, element.clientHeight * 0.75);
          element.scrollTop += direction * step;
        }, index < Math.min(...mounted) ? -1 : 1);
        return false;
      }).toBe(true);
    }
    await expect(target).toHaveCount(1);
  }
  await target.scrollIntoViewIfNeeded();
}

export async function verifyDesktopMarkdownControls(input: {
  page: Page;
  electronApp: ElectronApplication;
  completedTurn: Locator;
  testInfo: TestInfo;
}): Promise<void> {
  const { page, electronApp, completedTurn, testInfo } = input;
  const codeBlocks = completedTurn.locator(".response-code-block");
  await expect(codeBlocks).toHaveCount(2);
  const firstWrap = codeBlocks.nth(0).getByRole("button", { name: "Wrap" });
  const firstCopy = codeBlocks.nth(0).locator('button[title="Copy code"]');
  const secondCopy = codeBlocks.nth(1).locator('button[title="Copy code"]');
  const wrapHitTest = await firstWrap.evaluate((button) => {
    const bounds = button.getBoundingClientRect();
    const x = bounds.left + bounds.width / 2;
    const y = bounds.top + bounds.height / 2;
    const target = document.elementFromPoint(x, y);
    const styles = getComputedStyle(button);
    const virtualRow = button.closest<HTMLElement>(".response-virtual-item");
    const overlappingRows = [...document.querySelectorAll<HTMLElement>(
      ".response-virtual-item",
    )].filter((row) => {
      const rowBounds = row.getBoundingClientRect();
      return x >= rowBounds.left && x <= rowBounds.right
        && y >= rowBounds.top && y <= rowBounds.bottom;
    });
    button.dataset.e2eControlOwner = "desktop-wrap-owner";
    for (const eventName of ["pointerdown", "focus", "click"]) {
      button.addEventListener(eventName, () => {
        button.dataset.e2eControlEvents = [
          button.dataset.e2eControlEvents ?? "",
          eventName,
        ].filter(Boolean).join(",");
      }, { once: true });
    }
    return {
      ownsTarget: Boolean(target && button.contains(target)),
      targetTag: target?.tagName ?? null,
      targetClass: target instanceof HTMLElement ? target.className : null,
      stack: document.elementsFromPoint(x, y).map((element) => ({
        tag: element.tagName,
        className: element instanceof HTMLElement ? element.className : null,
      })),
      bounds: {
        left: bounds.left,
        top: bounds.top,
        width: bounds.width,
        height: bounds.height,
      },
      inertAncestor: button.closest("[inert]")?.tagName ?? null,
      pointerEvents: styles.pointerEvents,
      visibility: styles.visibility,
      display: styles.display,
      opacity: styles.opacity,
      appRegion: styles.getPropertyValue("-webkit-app-region"),
      virtualRow: virtualRow
        ? {
            index: virtualRow.dataset.index ?? null,
            bounds: virtualRow.getBoundingClientRect().toJSON(),
          }
        : null,
      overlappingVirtualRows: overlappingRows.map((row) =>
        row.dataset.index ?? null),
    };
  });
  await testInfo.attach("markdown-control-hit-test", {
    body: JSON.stringify(wrapHitTest, null, 2),
    contentType: "application/json",
  });
  expect(wrapHitTest.ownsTarget).toBe(true);
  expect(wrapHitTest.pointerEvents).toBe("auto");
  expect(wrapHitTest.inertAncestor).toBeNull();
  expect(wrapHitTest.virtualRow).not.toBeNull();
  expect(wrapHitTest.overlappingVirtualRows).toHaveLength(1);
  const firstPre = codeBlocks.nth(0).locator("pre");
  const beforeWrap = await firstPre.evaluate((element) => {
    const code = element.querySelector("code");
    const bounds = element.getBoundingClientRect();
    return {
      top: bounds.top,
      height: bounds.height,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      whiteSpace: code ? getComputedStyle(code).whiteSpace : null,
    };
  });
  expect(beforeWrap.whiteSpace).toBe("pre");
  expect(beforeWrap.scrollWidth).toBeGreaterThan(beforeWrap.clientWidth);
  await firstWrap.click();
  await expect(firstWrap).toBeFocused();
  await expect(firstWrap).toHaveAttribute(
    "data-e2e-control-events",
    "pointerdown,focus,click",
  );
  await expect(firstWrap).toHaveAttribute(
    "data-e2e-control-owner",
    "desktop-wrap-owner",
  );
  await expect(firstPre).toHaveClass(/wraps/u);
  await expect(codeBlocks.nth(1).locator("pre")).not.toHaveClass(/wraps/u);
  const afterWrap = await firstPre.evaluate((element) => {
    const code = element.querySelector("code");
    const bounds = element.getBoundingClientRect();
    return {
      top: bounds.top,
      height: bounds.height,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      whiteSpace: code ? getComputedStyle(code).whiteSpace : null,
    };
  });
  expect(afterWrap.whiteSpace).toBe("pre-wrap");
  expect(afterWrap.scrollWidth).toBeLessThan(beforeWrap.scrollWidth);
  expect(afterWrap.height).toBeGreaterThan(beforeWrap.height);
  expect(Math.abs(afterWrap.top - beforeWrap.top)).toBeLessThanOrEqual(2);
  await firstWrap.press("Space");
  await expect(firstWrap).toHaveAttribute("aria-pressed", "false");
  await firstWrap.press("Enter");
  await expect(firstWrap).toHaveAttribute("aria-pressed", "true");
  const clipboardBridgeProbe = await page.evaluate(async () => {
    try {
      return {
        bridgeType: typeof window.inertia.copyText,
        result: await window.inertia.copyText("direct-clipboard-probe"),
        error: null,
      };
    } catch (error) {
      return {
        bridgeType: typeof window.inertia.copyText,
        result: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
  await testInfo.attach("clipboard-bridge-probe", {
    body: JSON.stringify(clipboardBridgeProbe, null, 2),
    contentType: "application/json",
  });
  expect({
    ...clipboardBridgeProbe,
    clipboard: await electronApp.evaluate(({ clipboard }) =>
      clipboard.readText()),
  }).toEqual({
    bridgeType: "function",
    result: true,
    error: null,
    clipboard: "direct-clipboard-probe",
  });
  await electronApp.evaluate(({ clipboard }) =>
    clipboard.writeText("clipboard-sentinel"));
  await secondCopy.click();
  await expect(secondCopy).toHaveText("Copied");
  await expect(firstCopy).toHaveText("Copy");
  await expect.poll(() => electronApp.evaluate(({ clipboard }) =>
    clipboard.readText())).toBe('{"route":"secondary","verified":true}');
}

export async function verifyNarrowDesktopMarkdownControls(input: {
  electronApp: ElectronApplication;
  completedTurn: Locator;
}): Promise<void> {
  const { electronApp, completedTurn } = input;
  const codeBlocks = completedTurn.locator(".response-code-block");
  const narrowWrap = codeBlocks.nth(0).getByRole("button", { name: "Wrap" });
  const narrowWrapBefore = await narrowWrap.getAttribute("aria-pressed");
  await narrowWrap.click();
  await expect(narrowWrap).toHaveAttribute(
    "aria-pressed",
    narrowWrapBefore === "true" ? "false" : "true",
  );
  await electronApp.evaluate(({ clipboard }) =>
    clipboard.writeText("narrow-sentinel"));
  await codeBlocks.nth(1).locator('button[title="Copy code"]').click();
  await expect.poll(() => electronApp.evaluate(({ clipboard }) =>
    clipboard.readText())).toBe('{"route":"secondary","verified":true}');
  const tableToolbar = completedTurn.locator(".response-table-toolbar").first();
  const markdownCopy = tableToolbar.locator("button").nth(0);
  const csvCopy = tableToolbar.locator("button").nth(1);
  await markdownCopy.click();
  await expect(markdownCopy).toHaveText("Copied Markdown");
  await expect(csvCopy).toHaveText("CSV");
  await expect.poll(() => electronApp.evaluate(({ clipboard }) =>
    clipboard.readText())).toContain("| Surface | Presentation |");
  await csvCopy.click();
  await expect(csvCopy).toHaveText("Copied CSV");
  await expect.poll(() => electronApp.evaluate(({ clipboard }) =>
    clipboard.readText())).toContain("Surface,Presentation,");
}
