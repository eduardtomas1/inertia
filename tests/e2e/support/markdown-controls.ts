import {
  expect,
  type ElectronApplication,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";

const TARGET_REVEAL_TIMEOUT_MS = 5_000;
const MINIMAP_REVEAL_TIMEOUT_MS = 750;
const TARGET_REVEAL_RETRY_INTERVAL_MS = 50;

type TargetRevealEvidence = {
  mounted: boolean;
  visible: boolean;
  intersectsTranscript: boolean;
};

function targetIsRevealed(evidence: TargetRevealEvidence): boolean {
  return evidence.mounted
    && evidence.visible
    && evidence.intersectsTranscript;
}

function waitForRetry(): Promise<void> {
  return new Promise<void>((resolve) =>
    setTimeout(resolve, TARGET_REVEAL_RETRY_INTERVAL_MS));
}

async function scrollFreshTargetIntoView(
  target: Locator,
): Promise<TargetRevealEvidence> {
  return target.evaluateAll((elements) => {
    const element = elements.length === 1 ? elements[0] : undefined;
    if (!(element instanceof HTMLElement) || !element.isConnected) {
      return { mounted: false, visible: false, intersectsTranscript: false };
    }
    element.scrollIntoView({ block: "center", inline: "nearest" });
    if (!element.isConnected) {
      return { mounted: false, visible: false, intersectsTranscript: false };
    }
    const transcript = element.closest<HTMLElement>(".message-scroll");
    if (!transcript?.isConnected) {
      return { mounted: true, visible: false, intersectsTranscript: false };
    }
    const bounds = element.getBoundingClientRect();
    const transcriptBounds = transcript.getBoundingClientRect();
    const styles = getComputedStyle(element);
    return {
      mounted: true,
      visible: element.getClientRects().length > 0
        && bounds.width > 0
        && bounds.height > 0
        && styles.display !== "none"
        && styles.visibility !== "hidden",
      intersectsTranscript: Math.min(bounds.right, transcriptBounds.right)
          > Math.max(bounds.left, transcriptBounds.left)
        && Math.min(bounds.bottom, transcriptBounds.bottom)
          > Math.max(bounds.top, transcriptBounds.top),
    };
  });
}

async function tryMinimapReveal(input: {
  minimap: Locator;
  index: number;
  expectedMarkerCount: number;
  timeoutMs: number;
}): Promise<boolean> {
  const { minimap, index, expectedMarkerCount, timeoutMs } = input;
  const markers = minimap.getByRole("button");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const clicked = await markers.evaluateAll((buttons, request) => {
      if (buttons.length !== request.expectedMarkerCount) return false;
      const marker = buttons[request.index];
      if (!(marker instanceof HTMLButtonElement) || !marker.isConnected) {
        return false;
      }
      const bounds = marker.getBoundingClientRect();
      const styles = getComputedStyle(marker);
      if (bounds.width <= 0 || bounds.height <= 0
        || styles.display === "none" || styles.visibility === "hidden") {
        return false;
      }
      marker.click();
      return true;
    }, { expectedMarkerCount, index });
    if (clicked) return true;
    await waitForRetry();
  }
  return false;
}

export async function revealVirtualizedTimelineTurn(input: {
  page: Page;
  target: Locator;
  index: number;
  lastIndex: number;
}): Promise<void> {
  const { page, target, index, lastIndex } = input;
  const virtualRows = page.locator(".response-virtual-item");
  await expect.poll(() => virtualRows.count()).toBeGreaterThan(0);
  const revealDeadline = Date.now() + TARGET_REVEAL_TIMEOUT_MS;
  const initiallyRevealed = targetIsRevealed(
    await scrollFreshTargetIntoView(target),
  );

  if (!initiallyRevealed) {
    const minimap = page.getByRole("navigation", {
      name: "Conversation minimap",
    });
    await tryMinimapReveal({
      minimap,
      index,
      expectedMarkerCount: lastIndex + 1,
      timeoutMs: Math.min(
        MINIMAP_REVEAL_TIMEOUT_MS,
        Math.max(0, revealDeadline - Date.now()),
      ),
    });
  }

  const transcript = page.locator(".message-scroll");
  let consecutiveRevealedSamples = 0;
  let positionedByRatio = false;
  await expect.poll(async () => {
    const revealed = targetIsRevealed(
      await scrollFreshTargetIntoView(target),
    );
    consecutiveRevealedSamples = revealed
      ? consecutiveRevealedSamples + 1
      : 0;
    if (consecutiveRevealedSamples >= 2) return true;
    if (revealed) return false;

    const mounted = await virtualRows
      .evaluateAll((items) => items.map((item) =>
        Number((item as HTMLElement).dataset.index))
        .filter(Number.isFinite));
    await transcript.evaluate((element, request) => {
      if (!request.positionedByRatio) {
        const maximum = element.scrollHeight - element.clientHeight;
        element.scrollTop = maximum * request.position;
        return;
      }
      if (request.mounted.length === 0) return;
      const step = Math.max(100, element.clientHeight * 0.75);
      element.scrollTop += request.index < Math.min(...request.mounted)
        ? -step
        : step;
    }, {
      index,
      mounted,
      positionedByRatio,
      position: index / Math.max(1, lastIndex),
    });
    positionedByRatio = true;
    return false;
  }, {
    intervals: [TARGET_REVEAL_RETRY_INTERVAL_MS],
    timeout: Math.max(1, revealDeadline - Date.now()),
  }).toBe(true);
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
  await firstWrap.evaluate((button) => {
    button.scrollIntoView({ block: "center", inline: "nearest" });
  });
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
