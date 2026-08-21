import { expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { RuntimeStore } from "../../../src/server/database";

const execFileAsync = promisify(execFile);

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
      if (open) {
        await page.locator(
          'button[aria-label="Open workspace tools"]:visible',
        ).first().click();
        await page.locator(".workspace-panel:visible").first()
          .waitFor({ state: "visible" });
        return;
      }
      await page.locator(
        'button[aria-label="Close workspace tools"]:visible',
      ).first().click();
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
      `inertia:queued-prompts:${targetId}`,
      JSON.stringify([{
        id: "queued-responsive-proof",
        content: "After this pass, update the release notes and run the full gate",
        createdAt: "2026-08-21T10:00:00.000Z",
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
      window.localStorage.removeItem(`inertia:queued-prompts:${targetId}`);
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
