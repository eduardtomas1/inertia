// @inertia-e2e-resource primary-display
import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { RuntimeStore } from "../../src/server/database";
import { inspectProjectIdentity } from "../../src/server/project-identity";
import { ensureWorkspaceTools, closeWorkspaceTools } from "./support/workspace-tools";
import { COLOR_THEME_IDS } from "../../src/shared/contracts";
import {
  createAppFixture,
  type AppFixture,
} from "./support/app-fixture";

let app!: AppFixture;
let sourceConversationId = "";
let sourceWorkspace = "";
let targetWorkspace = "";

const THEME_CASES = COLOR_THEME_IDS
  .flatMap((colorTheme) => (["light", "dark"] as const)
    .map((theme) => ({ colorTheme, theme })));

function contrastRatio(foreground: string, background: string): number {
  const channels = (value: string): number[] => {
    const values = value.match(/[\d.]+/gu)?.map(Number) ?? [];
    return values.slice(0, 3).map((channel) => {
      const normalized = channel / 255;
      return normalized <= 0.04045
        ? normalized / 12.92
        : ((normalized + 0.055) / 1.055) ** 2.4;
    });
  };
  const luminance = (value: string): number => {
    const [red = 0, green = 0, blue = 0] = channels(value);
    return red * 0.2126 + green * 0.7152 + blue * 0.0722;
  };
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
    / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
}

test.beforeAll(async () => {
  app = await createAppFixture({
    name: "conversation-context",
    initialState: "conversation",
    windowDisplay: "primary",
    beforeLaunch: async ({ testDirectory, workspaceDirectory }) => {
      const store = new RuntimeStore(
        join(testDirectory, "data", "inertia.sqlite"),
        workspaceDirectory,
        { recoverInterruptedRuns: false },
      );
      const snapshot = store.shellSnapshot();
      if (!snapshot.activeConversationId || !snapshot.activeProjectId) {
        throw new Error("Context fixture requires an active target chat.");
      }
      const targetConversationId = snapshot.activeConversationId;
      const source = store.createConversation(
        snapshot.activeProjectId,
        `Architecture decisions — ${"cross-platform release context ".repeat(6)}`,
        { activate: false },
      );
      sourceConversationId = source.id;
      const historical = store.createMessage(
        source.id,
        "Provider continuation identity must never cross into another chat.",
        "assistant",
      );
      store.createMessage(
        source.id,
        "Carry only this reviewed retry decision into the implementation chat.",
        "user",
      );
      const sentPacket = store.contextPackets.create({
        sourceConversationId: source.id,
        targetConversationId,
        sourceMessageIds: [historical.id],
        acknowledgedWorkspaceDifference: false,
      });
      const requestedAt = "2026-08-19T09:30:00.000Z";
      const turn = store.beginAgentTurn({
        id: randomUUID(),
        conversationId: targetConversationId,
        runId: randomUUID(),
        content: "Preserve the reviewed provider boundary.",
        providerId: "codex",
        harnessId: "codex-app-server",
        backendProfileId: "builtin:openai",
        model: "gpt-test",
        reasoningEffort: "high",
        interactionMode: "build",
        accessMode: "supervised",
        configurationRevision: 0,
        association: "authoritative",
        requestedAt,
        conversationContextPacketIds: [sentPacket.id],
        contextRequestId: randomUUID(),
      });
      store.updateAgentTurnLifecycle(turn.turn.id, {
        status: "running",
        startedAt: requestedAt,
        updatedAt: requestedAt,
      });
      const answer = store.createMessage(
        targetConversationId,
        "The provider boundary remains explicit.",
        "assistant",
        [],
        turn.turn.id,
        "2026-08-19T09:30:03.000Z",
      );
      store.updateAgentTurnLifecycle(turn.turn.id, {
        status: "completed",
        completedAt: answer.createdAt,
        terminalAssistantMessageId: answer.id,
        terminalReason: "provider-completed",
        updatedAt: answer.createdAt,
      });
      targetWorkspace = snapshot.projects.find(({ id }) => id === snapshot.activeProjectId)!.normalizedPath;
      const otherPath = join(testDirectory, "reference-source");
      mkdirSync(otherPath, { recursive: true });
      // Seed the same canonical identity the runtime publishes on startup,
      // including Windows case folding and path separators.
      const otherProject = store.createProject("Another workspace", otherPath, await inspectProjectIdentity(otherPath));
      sourceWorkspace = otherProject.normalizedPath;
      const otherSource = store.createConversation(otherProject.id, "External research", { activate: false });
      store.createMessage(otherSource.id, "Share this note only after confirming the workspace boundary.", "assistant");
      const rollout = store.createConversation(snapshot.activeProjectId, "Importer rollout", { activate: false });
      const modules = ["accounts", "invoices", "payments", "ledgers", "customers", "orders"];
      let clock = Date.UTC(2026, 8, 20, 9, 0, 0);
      const at = (): string => new Date(clock += 45_000).toISOString();
      store.createMessage(rollout.id, "Plan the importer rollout: every module resumes from its last committed cursor, batches stay under 500 rows, and the nightly export is never blocked.", "user", [], null, at());
      for (let phase = 1; phase <= 36; phase += 1) {
        const module = modules[phase % modules.length]!;
        if (phase > 1) store.createMessage(rollout.id, `Continue with the ${module} importer, phase ${phase}.`, "user", [], null, at());
        for (let step = 1; step <= 3; step += 1) {
          store.createMessage(rollout.id, `Checking ${module} batch ${step}. ${"Reading the cursor table, validating row counts and comparing checksums against the export snapshot. ".repeat(24)}`, "assistant", [], null, at());
        }
        store.createMessage(rollout.id, `Phase ${phase} done: the ${module} importer resumes from its last committed cursor. ${"Verified resumable batches, idempotent writes and export compatibility. ".repeat(18)}`, "assistant", [], null, at());
      }
      const recoveryPackets = [targetConversationId, rollout.id].map((sourceConversationId) =>
        store.contextPackets.create({ sourceConversationId, targetConversationId, acknowledgedWorkspaceDifference: false }).id);
      const recoveredAt = "2026-08-19T10:15:00.000Z";
      const recovery = store.beginAgentTurn({
        id: randomUUID(),
        conversationId: targetConversationId,
        runId: randomUUID(),
        content: "Pick up the importer plan where we left it.",
        providerId: "codex",
        harnessId: "codex-app-server",
        backendProfileId: "builtin:openai",
        model: "gpt-test",
        reasoningEffort: "high",
        interactionMode: "build",
        accessMode: "supervised",
        configurationRevision: 0,
        association: "authoritative",
        requestedAt: recoveredAt,
        conversationContextPacketIds: recoveryPackets,
        contextRequestId: randomUUID(),
      });
      store.updateAgentTurnLifecycle(recovery.turn.id, {
        status: "running",
        startedAt: recoveredAt,
        updatedAt: recoveredAt,
      });
      const resumed = store.createMessage(
        targetConversationId,
        "Resuming phase 37 from the ledgers cursor; the provider boundary stays explicit.",
        "assistant",
        [],
        recovery.turn.id,
        "2026-08-19T10:15:04.000Z",
      );
      store.updateAgentTurnLifecycle(recovery.turn.id, {
        status: "completed",
        completedAt: resumed.createdAt,
        terminalAssistantMessageId: resumed.id,
        terminalReason: "provider-completed",
        updatedAt: resumed.createdAt,
      });
      store.selectConversation(targetConversationId);
      store.close();
    },
  });
});

test.afterAll(async () => {
  await app.close();
});

test("references a whole chat from the composer and preserves its provenance", async ({
  browserName: _browserName,
}, testInfo) => {
  const { electronApp, page, rendererErrors, resizeWindow } = app;
  const capture = async (name: string): Promise<void> => {
    const path = testInfo.outputPath(`${name}.png`);
    await page.screenshot({ animations: "disabled", path });
    await testInfo.attach(name, { path, contentType: "image/png" });
  };

  await resizeWindow(1280, 820);
  await expect(page.getByText("Context from Architecture decisions"))
    .toBeVisible();

  const editor = page.getByRole("textbox", { name: "Message" });
  await editor.click();
  await editor.fill("@Architecture");
  const suggestions = page.getByRole("listbox", {
    name: "Chats and project files",
  });
  await expect(suggestions).toBeVisible();
  await expect(suggestions.getByText("Reference a chat")).toBeVisible();
  await capture("conversation-context-mention-1280x820");

  await suggestions.getByRole("option", { name: /Architecture decisions/u })
    .click();

  const chip = page.getByRole("button", {
    name: /From Architecture decisions/u,
  });
  await expect(chip).toBeVisible();
  await expect(editor).toHaveValue("");
  const expectContextInsideComposer = async (): Promise<void> => {
    const geometry = await chip.evaluate((element) => {
      const card = element.closest("article")!.getBoundingClientRect();
      const input = element.closest(".composer")!.querySelector(".composer-input-zone")!;
      const rect = input.getBoundingClientRect();
      const style = getComputedStyle(input);
      return {
        card: { left: card.left, right: card.right, top: card.top, bottom: card.bottom },
        input: {
          left: rect.left + parseFloat(style.paddingLeft),
          right: rect.right - parseFloat(style.paddingRight),
          top: rect.top + parseFloat(style.paddingTop), bottom: rect.bottom,
        },
      };
    });
    expect(geometry.card.left).toBeGreaterThanOrEqual(geometry.input.left - 1);
    expect(geometry.card.right).toBeLessThanOrEqual(geometry.input.right + 1);
    expect(geometry.card.top).toBeGreaterThanOrEqual(geometry.input.top - 1);
    expect(geometry.card.bottom).toBeLessThanOrEqual(geometry.input.bottom + 1);
  };
  await expectContextInsideComposer();

  await chip.click();
  const preview = page.getByRole("region", { name: "Shared chat context" });
  await expect(preview).toBeVisible();
  await expect(preview.getByText(
    "Carry only this reviewed retry decision into the implementation chat.",
  )).toBeVisible();
  await preview.getByRole("button", { name: "Close preview" }).click();
  await expect(preview).toHaveCount(0);
  await chip.click();
  await expect(preview.getByText(
    "Carry only this reviewed retry decision into the implementation chat.",
  )).toBeVisible();

  const excerpt = preview.locator("p").first();
  for (const appearance of THEME_CASES) {
    await page.locator("html").evaluate((element, nextAppearance) => {
      const root = element as HTMLElement;
      root.dataset.theme = nextAppearance.theme;
      root.dataset.colorTheme = nextAppearance.colorTheme;
      root.style.colorScheme = nextAppearance.theme;
    }, appearance);
    const metric = await excerpt.evaluate((element) => {
      const styles = getComputedStyle(element);
      const surface = getComputedStyle(element.closest("section")!);
      return { color: styles.color, background: surface.backgroundColor };
    });
    expect(
      metric.background,
      `${appearance.colorTheme} ${appearance.theme} preview fill`,
    ).not.toBe("rgba(0, 0, 0, 0)");
    expect(
      contrastRatio(metric.color, metric.background),
      `${appearance.colorTheme} ${appearance.theme} preview excerpt`,
    ).toBeGreaterThanOrEqual(4.5);
  }
  await page.locator("html").evaluate((element) => {
    const root = element as HTMLElement;
    root.dataset.theme = "light";
    root.dataset.colorTheme = "inertia";
    root.style.colorScheme = "light";
  });
  await capture("conversation-context-preview-1280x820");

  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(1.25);
  });
  await page.waitForTimeout(200);
  await expect(preview).toBeInViewport();
  const boundsAt125 = await preview.boundingBox();
  const viewportAt125 = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  expect(boundsAt125).not.toBeNull();
  expect(boundsAt125!.x).toBeGreaterThanOrEqual(0);
  expect(boundsAt125!.x + boundsAt125!.width).toBeLessThanOrEqual(
    viewportAt125.width,
  );
  await expectContextInsideComposer();
  await capture("conversation-context-scale-125");

  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(1);
  });
  await resizeWindow(600, 760);
  await expect(chip).toBeVisible();
  await expectContextInsideComposer();
  await capture("conversation-context-narrow-600x760");
  await resizeWindow(1200, 820);
  await ensureWorkspaceTools(page);
  await expectContextInsideComposer();
  const previewBounds = await preview.boundingBox();
  const inputBounds = await page.locator(".composer-input-zone").boundingBox();
  const titleBounds = await preview.locator("header strong").boundingBox();
  expect(previewBounds!.x).toBeGreaterThanOrEqual(inputBounds!.x);
  expect(previewBounds!.x + previewBounds!.width).toBeLessThanOrEqual(inputBounds!.x + inputBounds!.width);
  expect(titleBounds!.x + titleBounds!.width).toBeLessThanOrEqual(previewBounds!.x + previewBounds!.width);
  await capture("conversation-context-with-panel");
  await closeWorkspaceTools(page);

  await page.emulateMedia({ forcedColors: "active" });
  await expect(chip).toBeVisible();
  await page.emulateMedia({ forcedColors: "none" });

  await capture("conversation-context-attached-provenance");
  expect(rendererErrors).toEqual([]);
  expect(sourceConversationId).not.toBe("");
});

test("requires native confirmation before attaching a chat from another workspace", async () => {
  const { page } = app;
  await app.resizeWindow(1280, 820);
  const closePreview = page.getByRole("button", { name: "Close preview" });
  if (await closePreview.isVisible()) await closePreview.click();
  // Its role changes to combobox while the retained mention menu is open.
  const editor = page.getByLabel("Message", { exact: true });
  const reference = async (accept: boolean): Promise<void> => {
    await editor.fill("Explain @External");
    const option = page.getByRole("option", { name: /External research/u });
    await expect(option).toBeVisible();
    await expect(option).toContainText("Another workspace");
    await expect(option).toContainText("different workspace");
    await Promise.all([
      page.waitForEvent("dialog").then(async (dialog) => {
        expect(dialog.type()).toBe("confirm");
        expect(dialog.message()).toContain(sourceWorkspace);
        expect(dialog.message()).toContain(targetWorkspace);
        if (accept) await dialog.accept(); else await dialog.dismiss();
      }),
      option.click(),
    ]);
  };
  await reference(false);
  await expect(editor).toHaveValue("Explain @External");
  const chip = page.getByRole("button", { name: /From External research/u });
  await expect(chip).toHaveCount(0);
  await reference(true);
  await expect(chip).toBeVisible();
  await expect(editor).toHaveValue("Explain ");
  await chip.click();
  await expect(page.getByRole("region", { name: "Shared chat context" })).toContainText(
    "Share this note only after confirming the workspace boundary.",
  );
  expect(app.rendererErrors).toEqual([]);
});

test("references this chat beside two other chats and keeps what was sent", async ({
  browserName: _browserName,
}, testInfo) => {
  const { page } = app;
  const capture = async (name: string): Promise<void> => {
    const path = testInfo.outputPath(`${name}.png`);
    await page.screenshot({ animations: "disabled", path });
    await testInfo.attach(name, { path, contentType: "image/png" });
  };
  await app.resizeWindow(1280, 820);
  const preview = page.getByRole("region", { name: "Shared chat context" });
  const closePreview = preview.getByRole("button", { name: "Close preview" });
  if (await closePreview.isVisible()) await closePreview.click();
  await page.getByRole("button", { name: "Remove context from External research" }).click();
  await expect(page.getByRole("button", { name: /From External research/u })).toHaveCount(0);

  const editor = page.getByLabel("Message", { exact: true });
  await editor.fill("Pick up the importer plan @this");
  const thisChat = page.getByRole("option", { name: /This chat/u });
  await expect(thisChat).toBeVisible();
  await expect(thisChat).toContainText("Earlier messages");
  await capture("this-chat-mention");
  await thisChat.click();
  const ownChip = page.getByRole("button", { name: /^This chat/u });
  await expect(ownChip).toBeVisible();
  await expect(editor).toHaveValue("Pick up the importer plan ");

  await editor.fill("Pick up the importer plan @Importer");
  await page.getByRole("option", { name: /Importer rollout/u }).click();
  const importerChip = page.getByRole("button", { name: /From Importer rollout/u });
  await expect(importerChip).toBeVisible();
  await expect(importerChip).toContainText("omitted");
  await expect(editor).toHaveValue("Pick up the importer plan ");
  await editor.fill("Pick up the importer plan @Arch");
  await expect(page.getByRole("option", { name: /Architecture decisions/u })).toHaveCount(0);
  await editor.fill("Pick up the importer plan");
  await capture("three-references");

  await importerChip.click();
  await expect(preview.getByText(/earlier messages omitted/u)).toBeVisible();
  await expect(preview.getByText(/intermediate agent updates left out so more turns fit/u)).toBeVisible();
  await expect(preview.locator("li").first()).toContainText("Plan the importer rollout");
  await capture("importer-preview");
  await closePreview.click();
  await ownChip.click();
  await expect(preview).toContainText("The provider boundary remains explicit.");
  await capture("this-chat-preview");
  await closePreview.click();

  await page.getByRole("button", { name: "Send message" }).click();
  await expect(ownChip).toHaveCount(0);
  await expect(importerChip).toHaveCount(0);
  await expect(page.getByText("Pick up the importer plan", { exact: true })).toBeVisible();

  const receipts = page.getByRole("article", { name: "Your request" })
    .filter({ hasText: "Pick up the importer plan where we left it." })
    .getByLabel("Shared chat context");
  await expect(receipts).toContainText("Earlier messages from this chat");
  await expect(receipts).toContainText("Context from Importer rollout");
  await expect(receipts).toContainText(/omitted/u);
  await receipts.scrollIntoViewIfNeeded();
  await capture("sent-receipts");
  expect(app.rendererErrors).toEqual([]);
});
