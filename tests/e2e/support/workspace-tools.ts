import { expect, type Locator, type Page } from "@playwright/test";

export function rightPanelToggle(page: Page): Locator {
  return page.locator("[data-panel-layout-controls] [data-right-panel-toggle]");
}

export async function ensureWorkspaceTools(page: Page): Promise<Locator> {
  const panel = page.locator(".workspace-panel");
  if (!await panel.isVisible({ timeout: 500 }).catch(() => false)) {
    const opener = rightPanelToggle(page);
    await expect.poll(async () =>
      await panel.isVisible({ timeout: 500 }).catch(() => false)
      || await opener.isEnabled({ timeout: 500 }).catch(() => false),
    ).toBe(true);
    if (!await panel.isVisible({ timeout: 500 }).catch(() => false)) {
      await opener.click();
    }
  }
  await panel.waitFor({ state: "visible" });
  return panel;
}

export async function closeWorkspaceTools(page: Page): Promise<void> {
  const toggle = rightPanelToggle(page);
  if (await toggle.getAttribute("aria-pressed") === "true") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
}

/** Opens the terminal docked under the primary chat. */
export async function openTerminalDock(page: Page): Promise<Locator> {
  const dock = page.locator(".workspace-chat-column > .terminal-dock");
  const toggle = page.locator("[data-panel-layout-controls]")
    .getByRole("button", { name: /^Toggle terminal/u });
  await expect(toggle).toBeEnabled();
  // A retained open dock can still be loading its lazy renderer after reload.
  // Its toolbar owns visibility; toggling an absent DOM node would close it.
  if (await toggle.getAttribute("aria-pressed") === "false") await toggle.click();
  await expect(dock).toBeVisible();
  return dock;
}

/** Opens the terminal docked under one split pane's chat. */
export async function openPaneTerminal(
  pane: Locator,
  chatTitle: string,
): Promise<Locator> {
  const dock = pane.locator(".conversation-pane-chat > .terminal-dock");
  if (!await dock.isVisible().catch(() => false)) {
    await pane.getByRole("button", { name: `Open terminal for ${chatTitle}` }).click();
  }
  await expect(dock).toBeVisible();
  return dock;
}

export async function selectWorkspaceTool(
  panel: Locator,
  name: string,
): Promise<void> {
  const tabId = name === "Browser" ? "preview" : name.toLowerCase();
  const tab = panel.locator(`[data-workspace-tab="${tabId}"]`);
  if (await tab.isVisible().catch(() => false)) {
    await tab.click();
    return;
  }

  const launcher = panel.getByRole("group", { name: "Open a surface" });
  if (await launcher.isVisible().catch(() => false)) {
    await launcher.getByRole("button", { name: new RegExp(`^${name}`, "u") }).click();
  } else {
    await panel.getByRole("button", { name: "Add panel surface" }).click();
    await panel.page().getByRole("menu", { name: "Add panel surface" })
      .getByRole("menuitem", { name: new RegExp(`^${name}`, "u") })
      .click();
  }
  await expect(tab).toHaveAttribute("aria-selected", "true");
}

export async function openConversationPaneTool(
  pane: Locator,
  chatTitle: string,
  tab: "Changes" | "Files" | "Goal" | "Browser" | "Terminal" | "Attachments",
): Promise<Locator> {
  const tools = pane.getByRole("complementary", { name: "Workspace tools" });
  if (!await tools.isVisible().catch(() => false)) {
    await pane.getByRole("button", {
      name: `Open tools for ${chatTitle}`,
    }).click();
  }
  await selectWorkspaceTool(tools, tab);
  return tools;
}

async function centreHitsItself(target: Locator): Promise<boolean> {
  return await target.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const hit = document.elementFromPoint(
      bounds.left + bounds.width / 2,
      bounds.top + bounds.height / 2,
    );
    return hit !== null && element.contains(hit);
  });
}

export async function expectPaneComposerClearOfTerminalHandle(pane: Locator): Promise<void> {
  const attach = pane.getByRole("button", {
    name: "Attach images, documents, or spreadsheets",
  });
  const handle = pane.getByRole("separator", { name: "Resize terminal" });
  await expect(attach).toBeVisible();
  await expect(handle).toBeVisible();
  await expect.poll(() => centreHitsItself(attach)).toBe(true);
  await expect.poll(() => centreHitsItself(handle)).toBe(true);
  // Zoom and scale changes settle over several frames; keep retrying the
  // geometry read instead of trusting a single sample taken right after them.
  await expect.poll(async () => {
    const handleTop = await handle.evaluate((element) => element.getBoundingClientRect().top);
    const lowestControl = await pane.locator(".composer-region").evaluate((region) =>
      Math.max(...Array.from(region.querySelectorAll("button, textarea, input, [role='button']"))
        .map((control) => control.getBoundingClientRect())
        .filter((bounds) => bounds.width > 0 && bounds.height > 0)
        .map((bounds) => bounds.bottom)));
    return lowestControl - handleTop;
  }).toBeLessThanOrEqual(0);
}
