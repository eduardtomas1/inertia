import type { Locator, Page, TestInfo } from "@playwright/test";
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
