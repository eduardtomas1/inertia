import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { RuntimeStore } from "../../src/server/database";
import { COLOR_THEME_IDS } from "../../src/shared/contracts";
import {
  createAppFixture,
  type AppFixture,
} from "./support/app-fixture";

let app!: AppFixture;
let sourceConversationId = "";

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
    beforeLaunch: ({ testDirectory, workspaceDirectory }) => {
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
        "Architecture decisions",
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
      store.close();
    },
  });
});

test.afterAll(async () => {
  await app.close();
});

test("chooses, previews, and preserves bounded cross-chat provenance", async ({
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
  await page.getByRole("button", { name: "Add context from another chat" })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Bring context from another chat",
  });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(
    "Redaction is a safeguard, not a guarantee. Review every excerpt.",
  )).toBeVisible();
  await expect(dialog.getByText(
    "Carry only this reviewed retry decision into the implementation chat.",
  )).toBeVisible();

  await dialog.getByRole("button", {
    name: /Carry only this reviewed retry decision/u,
  }).click();
  await expect(dialog.getByLabel("Context preview").getByText(
    "Carry only this reviewed retry decision into the implementation chat.",
  )).toBeVisible();

  const selectedCheck = dialog.locator('.c-x[aria-pressed="true"] .c-xk');
  const search = dialog.getByRole("searchbox");
  const note = dialog.getByPlaceholder("Optional context note");
  for (const appearance of THEME_CASES) {
    await page.locator("html").evaluate((element, nextAppearance) => {
      const root = element as HTMLElement;
      root.dataset.theme = nextAppearance.theme;
      root.dataset.colorTheme = nextAppearance.colorTheme;
      root.style.colorScheme = nextAppearance.theme;
    }, appearance);
    const metrics = await Promise.all([selectedCheck, search, note].map(
      async (target) => target.evaluate((element) => {
        const styles = getComputedStyle(element);
        return {
          color: styles.color,
          background: styles.backgroundColor,
        };
      }),
    ));
    for (const [surface, metric] of ["selected checkmark", "search input", "note input"]
      .map((surface, index) => [surface, metrics[index]!] as const)) {
      expect(metric.background, `${appearance.colorTheme} ${appearance.theme} ${surface} fill`)
        .not.toBe("rgba(0, 0, 0, 0)");
      expect(
        contrastRatio(metric.color, metric.background),
        `${appearance.colorTheme} ${appearance.theme} ${surface}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  }
  await page.locator("html").evaluate((element) => {
    const root = element as HTMLElement;
    root.dataset.theme = "light";
    root.dataset.colorTheme = "inertia";
    root.style.colorScheme = "light";
  });
  await capture("conversation-context-default-1280x820");

  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(1.25);
  });
  await page.waitForTimeout(200);
  await expect(dialog).toBeInViewport();
  const boundsAt125 = await dialog.boundingBox();
  const viewportAt125 = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  expect(boundsAt125).not.toBeNull();
  expect(boundsAt125!.x).toBeGreaterThanOrEqual(0);
  expect(boundsAt125!.x + boundsAt125!.width).toBeLessThanOrEqual(
    viewportAt125.width,
  );
  await capture("conversation-context-scale-125");

  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(1);
  });
  await resizeWindow(600, 760);
  await expect(dialog.getByLabel("Context preview")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Attach context" }))
    .toBeVisible();
  await capture("conversation-context-narrow-600x760");

  await page.emulateMedia({ forcedColors: "active" });
  await expect(dialog).toBeVisible();
  expect(await dialog.locator(".c-x").first().evaluate((element) =>
    getComputedStyle(element).borderTopStyle)).not.toBe("none");
  await page.emulateMedia({ forcedColors: "none" });

  await dialog.getByRole("button", { name: "Attach context" }).click();
  await expect(page.getByRole("button", { name: /From Architecture decisions/u }))
    .toBeVisible();
  await capture("conversation-context-attached-provenance");
  expect(rendererErrors).toEqual([]);
  expect(sourceConversationId).not.toBe("");
});
