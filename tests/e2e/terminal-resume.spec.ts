import { expect, test, type Locator } from "@playwright/test";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { RuntimeStore } from "../../src/server/database";
import {
  continuationIdentityForSelection,
  nativeModelSelection,
} from "../../src/shared/model-routing";
import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { selectWorkspaceTool } from "./support/workspace-tools";

const primarySessionId = "11111111-1111-4111-8111-111111111111";
const secondarySessionId = "22222222-2222-4222-8222-222222222222";

const codexAppServerSource = `
if (process.argv[2] === "--help") {
  process.stdout.write("Usage: codex app-server [OPTIONS] - Run the app server\\n");
  process.exit(0);
}
setInterval(() => {}, 1000);
`;

const codexResumeSource = `
const fs = require("node:fs");
const path = require("node:path");
const sessionId = process.argv[2];
const exitPath = path.join(process.cwd(), ".terminal-resume-exit");
fs.writeFileSync(path.join(process.cwd(), ".terminal-resume-marker"), sessionId);
process.stdout.write("RESUMED_SESSION=" + sessionId + "\\r\\n");
process.stdout.write("RESUMED_CWD=" + process.cwd() + "\\r\\n");
const timer = setInterval(() => {
  if (!fs.existsSync(exitPath)) return;
  const parsed = Number.parseInt(fs.readFileSync(exitPath, "utf8").trim(), 10);
  fs.unlinkSync(exitPath);
  clearInterval(timer);
  process.exit(Number.isInteger(parsed) ? parsed : 1);
}, 25);
`;

let app!: AppFixture;
let page!: AppFixture["page"];

test.beforeAll(async () => {
  app = await createAppFixture({
    name: "terminal-resume",
    initialState: "conversation",
    seedSecondProject: true,
    codexAppServerSource,
    codexResumeSource,
    beforeLaunch: ({
      testDirectory,
      workspaceDirectory,
      secondWorkspaceDirectory,
    }) => {
      if (!secondWorkspaceDirectory) {
        throw new Error("Terminal resume fixture requires a second project.");
      }
      const store = new RuntimeStore(
        join(testDirectory, "data", "inertia.sqlite"),
        workspaceDirectory,
        { recoverInterruptedRuns: false },
      );
      const selection = nativeModelSelection({ providerId: "codex" });
      const identity = continuationIdentityForSelection(
        selection,
        null,
        false,
      );
      const snapshot = store.shellSnapshot();
      const secondProjectId = snapshot.projects.find(
        ({ path }) => path === secondWorkspaceDirectory,
      )?.id;
      for (const conversation of snapshot.conversations) {
        store.updateConversation(conversation.id, {
          modelSelection: selection,
          continuationIdentity: identity,
          providerSessionId: conversation.projectId === secondProjectId
            ? secondarySessionId
            : primarySessionId,
        });
      }
      store.close();
    },
  });
  page = app.page;
});

test.afterAll(async () => {
  await app.close();
});

async function openTerminal(
  pane: Locator,
  title: string,
): Promise<Locator> {
  const tools = pane.getByRole("complementary", { name: "Workspace tools" });
  if (!await tools.isVisible().catch(() => false)) {
    await pane.getByRole("button", { name: `Open tools for ${title}` }).click();
  }
  await selectWorkspaceTool(tools, "Terminal");
  return tools;
}

test("resumes the selected provider session only in its owning split pane", async () => {
  await app.resizeWindow(1440, 920);
  const primaryTitle = "terminal-resume fixture";
  const secondaryTitle = "terminal-resume companion";
  const sidebar = page.getByRole("complementary", {
    name: "Project navigation",
  });
  await sidebar.getByRole("button", { name: "Expand Companion" }).click();
  await sidebar.getByRole("button", {
    name: `Thread actions for ${secondaryTitle}`,
  }).click();
  await sidebar.getByRole("menuitem", {
    name: "Add this chat to split view",
  }).click();

  const primary = page.getByRole("region", {
    name: `Primary chat: Inertia · ${primaryTitle}`,
  });
  const secondary = page.getByRole("region", {
    name: `Second chat: Companion · ${secondaryTitle}`,
  });
  const primaryTools = await openTerminal(primary, primaryTitle);
  const secondaryTools = await openTerminal(secondary, secondaryTitle);
  await expect(primaryTools.getByText(primarySessionId, { exact: true }))
    .toBeVisible({ timeout: 20_000 });
  await expect(secondaryTools.getByText(secondarySessionId, { exact: true }))
    .toBeVisible({ timeout: 20_000 });

  const primaryPanel = primaryTools.locator(".terminal-panel");
  const secondaryPanel = secondaryTools.locator(".terminal-panel");
  const primaryTerminal = primaryTools.locator(
    ".terminal-panel[data-terminal-id]",
  );
  const secondaryTerminal = secondaryTools.locator(
    ".terminal-panel[data-terminal-id]",
  );
  const primaryTerminalId = await primaryTerminal.getAttribute(
    "data-terminal-id",
  );
  const secondaryTerminalId = await secondaryTerminal.getAttribute(
    "data-terminal-id",
  );
  await secondaryTools.getByRole("button", {
    name: "Resume Codex session in Companion",
  }).click();

  await expect(secondaryTerminal).toHaveAttribute(
    "data-terminal-id",
    /.+/u,
  );
  await expect.poll(
    () => secondaryTerminal.getAttribute("data-terminal-id"),
    { timeout: 10_000 },
  ).not.toBe(secondaryTerminalId);
  await expect.poll(
    () => readFile(
      join(app.secondWorkspaceDirectory!, ".terminal-resume-marker"),
      "utf8",
    ).catch(() => null),
  ).toBe(secondarySessionId);
  await expect(readFile(
    join(app.workspaceDirectory, ".terminal-resume-marker"),
    "utf8",
  )).rejects.toThrow();
  expect(await primaryTerminal.getAttribute("data-terminal-id"))
    .toBe(primaryTerminalId);
  await expect(primaryTools.getByRole("button", {
    name: "Resume Codex session in Inertia",
  }))
    .toBeEnabled();
  await expect(secondaryTools.getByRole("button", {
    name: "Codex session is resumed in Companion",
  }))
    .toBeDisabled();

  const exitPath = join(
    app.secondWorkspaceDirectory!,
    ".terminal-resume-exit",
  );
  const pendingExitPath = `${exitPath}.pending`;
  await writeFile(pendingExitPath, "0", "utf8");
  await rename(pendingExitPath, exitPath);
  await expect(secondaryPanel).not.toHaveAttribute("data-terminal-id", /.+/u);
  await expect(secondaryPanel.getByText(
    `Codex session ${secondarySessionId} ended.`,
    { exact: true },
  )).toBeVisible();
  expect(await primaryPanel.getAttribute("data-terminal-id"))
    .toBe(primaryTerminalId);

  await secondaryPanel.getByRole("button", { name: "Start again" }).click();
  await expect(secondaryPanel).toHaveAttribute("data-terminal-id", /.+/u);
  await expect(secondaryPanel.getByRole("button", {
    name: "Resume Codex session in Companion",
  })).toBeEnabled();
  expect(app.rendererErrors).toEqual([]);
});
