// @inertia-e2e-resource isolated
import { expect, test } from "@playwright/test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { RuntimeStore } from "../../src/server/database";
import { createAppFixture, type AppFixture } from "./support/app-fixture";

let app!: AppFixture;
let outsideFile: string;

test.beforeAll(async () => {
  app = await createAppFixture({
    name: "markdown-file-preview",
    initialState: "conversation",
    seedSecondProject: true,
    beforeLaunch: async ({
      testDirectory,
      workspaceDirectory,
      secondWorkspaceDirectory,
    }) => {
      outsideFile = join(testDirectory, "Workflow with spaces.json");
      await writeFile(outsideFile, "{}\n", { mode: 0o600 });
      await mkdir(join(workspaceDirectory, "docs", "nested"), {
        recursive: true,
      });
      await writeFile(
        join(workspaceDirectory, "docs", "guide.md"),
        [
          "# Guide",
          "",
          "The rendered Markdown preview opened from chat is working.",
          "",
          "[Jump to details](#details)",
          "",
          "[Open the nested guide](./nested/next.md#target)",
          "",
          "## Details",
          "",
          "The local heading is reachable.",
          "",
        ].join("\n"),
        "utf8",
      );
      await writeFile(
        join(workspaceDirectory, "docs", "nested", "next.md"),
        [
          "# Nested guide",
          "",
          "## Target",
          "",
          "A relative cross-file heading is reachable.",
          "",
          "[Back to the guide](../guide.md#details)",
          "",
        ].join("\n"),
        "utf8",
      );
      if (!secondWorkspaceDirectory) {
        throw new Error("Markdown fixture needs its split workspace.");
      }
      await mkdir(join(secondWorkspaceDirectory, "docs"), { recursive: true });
      await writeFile(
        join(secondWorkspaceDirectory, "docs", "guide.md"),
        [
          "# Companion guide",
          "",
          "## Companion details",
          "",
          "This preview belongs to the second chat.",
          "",
        ].join("\n"),
        "utf8",
      );
      const store = new RuntimeStore(
        join(testDirectory, "data", "inertia.sqlite"),
        workspaceDirectory,
        { recoverInterruptedRuns: false },
      );
      const conversationId = store.shellSnapshot().activeConversationId;
      if (!conversationId) throw new Error("Markdown fixture needs a conversation.");
      store.createMessage(
        conversationId,
        "Read the [project guide](docs/guide.md#details) before continuing.\n\n"
          + `[outside workflow](<${outsideFile.replace(/\\/gu, "/")}>)\n\n`
          + `[outside file URL](${pathToFileURL(outsideFile).href})\n\n`
          + `[outside source location](${pathToFileURL(outsideFile).href}:42)`,
        "assistant",
      );
      const companion = store.snapshot().conversations.find(
        ({ id }) => id !== conversationId,
      );
      if (!companion) throw new Error("Markdown fixture needs a companion chat.");
      store.createMessage(
        companion.id,
        "Read the [companion guide](docs/guide.md#companion-details).",
        "assistant",
      );
      store.close();
    },
  });
});

test.afterAll(async () => {
  await app.close();
});

test("opens a rendered project Markdown file directly from the chat", async () => {
  const { page, rendererErrors } = app;
  const workspacePanel = page.locator(".workspace-panel:visible").first();
  await expect(workspacePanel).toBeVisible();
  await page.locator(
    'button[aria-label="Close workspace tools"]:visible',
  ).first().click();
  await expect(page.locator(".workspace-panel:visible")).toHaveCount(0);

  await page.getByRole("link", { name: "project guide" }).click();

  await expect(workspacePanel).toBeVisible();
  await expect(workspacePanel.getByRole("tab", { name: "Files" }))
    .toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("document", {
    name: "Preview of docs/guide.md",
  })).toBeVisible();
  const details = page.getByRole("heading", { name: "Details" });
  await expect(details).toBeVisible();
  await expect(details).toBeFocused();

  await workspacePanel.getByRole("button", { name: "Source" }).click();
  await expect(workspacePanel.getByLabel("Contents of docs/guide.md"))
    .toBeVisible();
  await page.getByRole("link", { name: "project guide" }).click();
  await expect(workspacePanel.getByRole("button", { name: "Preview" }))
    .toHaveAttribute("aria-pressed", "true");
  await expect(details).toBeFocused();

  await page.getByRole("link", { name: "Jump to details" }).click();
  await expect(details).toBeFocused();

  await page.getByRole("link", { name: "Open the nested guide" }).click();
  await expect(page.getByRole("document", {
    name: "Preview of docs/nested/next.md",
  })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Target" })).toBeFocused();

  await page.getByRole("link", { name: "Back to the guide" }).click();
  await expect(page.getByRole("document", {
    name: "Preview of docs/guide.md",
  })).toBeVisible();
  await expect(details).toBeFocused();

  const sidebar = page.getByRole("complementary", {
    name: "Project navigation",
  });
  await sidebar.getByRole("button", {
    name: /^markdown-file-preview companion,/u,
  }).click({ button: "right" });
  await page.getByRole("menuitem", {
    name: "Add this chat to split view",
  }).click();
  const primary = page.getByRole("region", {
    name: "Primary chat: Inertia · markdown-file-preview fixture",
  });
  const secondary = page.getByRole("region", {
    name: "Second chat: Companion · markdown-file-preview companion",
  });
  await primary.getByRole("link", { name: "project guide" }).click();
  const primaryTools = primary.getByRole("complementary", {
    name: "Workspace tools",
  });
  await expect(primaryTools.getByRole("document", {
    name: "Preview of docs/guide.md",
  })).toBeVisible();
  // Finish the first pane's asynchronous heading handoff before issuing the
  // second. Otherwise a slower first render can legitimately steal focus back
  // after the later click and make the split-pane assertion order-dependent.
  await expect(primaryTools.getByRole("heading", { name: "Details" }))
    .toBeFocused();
  await secondary.getByRole("link", { name: "companion guide" }).click();
  const secondaryTools = secondary.getByRole("complementary", {
    name: "Workspace tools",
  });
  await expect(secondaryTools.getByRole("document", {
    name: "Preview of docs/guide.md",
  })).toBeVisible();
  await expect(secondaryTools.getByRole("heading", {
    name: "Companion details",
  })).toBeFocused();
  await expect(primaryTools.getByRole("document", {
    name: "Preview of docs/guide.md",
  })).toBeVisible();
  expect(rendererErrors).toEqual([]);
});

test("opens outside-project links through the trusted desktop bridge and reports missing files", async () => {
  const { page, electronApp, rendererErrors } = app;
  await electronApp.evaluate(({ shell }) => {
    Reflect.set(globalThis, "__openedLocalFilePaths", []);
    Reflect.set(shell, "openPath", async (path: string) => {
      (Reflect.get(globalThis, "__openedLocalFilePaths") as string[]).push(path);
      return "";
    });
  });
  const opened = () => electronApp.evaluate(() => Reflect.get(globalThis, "__openedLocalFilePaths") as string[]);
  expect(await opened()).toEqual([]);
  await page.getByRole("link", { name: "outside workflow", exact: true }).click();
  await expect.poll(opened).toEqual([outsideFile]);
  await page.getByRole("link", { name: "outside file URL", exact: true }).click();
  await expect.poll(opened).toEqual([outsideFile, outsideFile]);
  await page.getByRole("link", { name: "outside source location", exact: true }).click();
  await expect.poll(opened).toEqual([outsideFile, outsideFile, outsideFile]);
  await rm(outsideFile);
  await page.getByRole("link", { name: "outside workflow", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "The local file could not be opened." })).toBeVisible();
  expect(await opened()).toEqual([outsideFile, outsideFile, outsideFile]);
  expect(rendererErrors).toEqual([]);
});
