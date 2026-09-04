import { expect, test } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { RuntimeStore } from "../../src/server/database";
import { createAppFixture, type AppFixture } from "./support/app-fixture";

let app!: AppFixture;

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
        "Read the [project guide](docs/guide.md#details) before continuing.",
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
    name: "Thread actions for markdown-file-preview companion",
  }).click();
  await sidebar.getByRole("menuitem", {
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
