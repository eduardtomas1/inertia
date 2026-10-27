// @inertia-e2e-resource isolated
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page, type TestInfo, type WebSocketRoute } from "@playwright/test";

import type {
  AppSnapshot,
  ChatMessage,
  ClientCommand,
  ConversationCompactAndSendResult,
  ProviderInfo,
  ServerEvent,
  ThreadUsageSnapshot,
} from "../../src/shared/contracts";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import { RuntimeStore } from "../../src/server/database";
import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { setAppearance } from "./support/appearance";

const evidenceDirectory = join(process.cwd(), "docs", "pr-evidence", "compact-on-return");
const CLAUDE_SELECTION = providerNativeModelSelection({
  providerId: "claude",
  modelId: "provider-default",
  reasoningEffort: null,
});
const DRAFT = "Pick up the billing migration where we left off and finish the invoice exporter.";
const MINUTE_MS = 60_000;

type Phase = "stale" | "compacted";

let app!: AppFixture;
let page!: Page;
let conversationId = "";
let seededTurnId: string | null = null;
let phase: Phase = "stale";
let staleSince = "";
let compactedAt = "";
let releaseCompaction: (() => void) | null = null;
let compactRequests: Extract<ClientCommand, { type: "conversation.compact-and-send" }>[] = [];

function claudeProvider(provider: ProviderInfo): ProviderInfo {
  const fresh = {
    freshness: "fresh" as const,
    provenance: "provider" as const,
    updatedAt: new Date().toISOString(),
    lastAttemptedAt: new Date().toISOString(),
    refreshing: false,
  };
  return {
    ...provider,
    available: true,
    installState: "installed",
    authState: "authenticated",
    accountKind: "Console API key",
    canRun: true,
    statusMessage: null,
    models: provider.models.length > 0 ? provider.models : [{
      id: "claude-opus-5-5",
      label: "Claude Opus 5.5",
      description: "",
      isDefault: true,
      inputModalities: ["text"],
      reasoningOptions: [],
      defaultReasoningEffort: "",
    }],
    metadataState: { models: fresh, rateLimits: provider.metadataState.rateLimits },
  };
}

function withFixtureProviders(snapshot: AppSnapshot): AppSnapshot {
  return {
    ...snapshot,
    providers: snapshot.providers.map((provider) =>
      provider.id === "claude" ? claudeProvider(provider) : provider),
  };
}

function fixtureUsage(): ThreadUsageSnapshot {
  const compacted = phase === "compacted";
  return {
    conversationId,
    turnId: seededTurnId,
    usedTokens: compacted ? 18_300 : 252_000,
    totalProcessedTokens: null,
    totalProcessedScope: null,
    maxTokens: 1_000_000,
    inputTokens: null,
    cachedInputTokens: null,
    cacheWriteInputTokens: null,
    outputTokens: null,
    reasoningOutputTokens: null,
    compactsAutomatically: null,
    promptCache: {
      lastRequestStartedAt: compacted ? compactedAt : staleSince,
      lifetimeMs: 5 * MINUTE_MS,
      source: "reported",
    },
    updatedAt: new Date().toISOString(),
  };
}

function compactionReceipt(): ChatMessage {
  return {
    id: "compact-on-return-receipt",
    conversationId,
    turnId: null,
    role: "system",
    content: "",
    attachments: [],
    createdAt: compactedAt,
    compaction: {
      providerId: "claude",
      beforeTokens: 252_000,
      afterTokens: 18_300,
      instructionForwarded: false,
      trigger: "on-return",
    },
  };
}

function rewrite(event: ServerEvent): ServerEvent {
  if (event.type === "server.welcome" || event.type === "snapshot.updated") {
    return { ...event, snapshot: withFixtureProviders(event.snapshot) };
  }
  if (event.type === "runtime.event" && event.event.type === "snapshot.updated") {
    return { ...event, event: { ...event.event, snapshot: withFixtureProviders(event.event.snapshot) } };
  }
  if (event.type === "runtime.event" && event.event.type === "agent.usage" && event.event.usage.conversationId === conversationId) {
    return { ...event, event: { ...event.event, usage: fixtureUsage() } };
  }
  if (
    event.type === "request.result"
    && event.result.kind === "conversation.detail"
    && event.result.state === "ready"
    && event.result.conversationId === conversationId
  ) {
    const detail = event.result.detail;
    return {
      ...event,
      result: {
        ...event.result,
        detail: {
          ...detail,
          usage: [fixtureUsage(), ...detail.usage.filter((usage) => usage.conversationId !== conversationId)],
          messages: phase === "compacted"
            ? [...detail.messages.filter(({ id }) => id !== "compact-on-return-receipt"), compactionReceipt()]
            : detail.messages,
        },
      },
    };
  }
  return event;
}

function answerCompactAndSend(route: WebSocketRoute, command: Extract<ClientCommand, { type: "conversation.compact-and-send" }>): void {
  compactRequests.push(command);
  const result: ConversationCompactAndSendResult = {
    kind: "conversation.compact-and-send",
    outcome: "sent",
    conversationId: command.payload.conversationId,
    turnId: "33333333-3333-4333-8333-333333333333",
    userMessageId: "44444444-4444-4444-8444-444444444444",
    disposition: "new-turn",
    compaction: compactionReceipt().compaction!,
  };
  releaseCompaction = () => {
    route.send(JSON.stringify({ type: "request.result", requestId: command.requestId, result }));
  };
}

async function routeRuntime(target: Page): Promise<void> {
  await target.routeWebSocket(/.*/u, (route) => {
    const server = route.connectToServer();
    route.onMessage((message) => {
      const command = JSON.parse(message.toString()) as ClientCommand;
      if (command.type === "conversation.compact-and-send") {
        answerCompactAndSend(route, command);
        return;
      }
      server.send(message);
    });
    server.onMessage((data) => {
      route.send(JSON.stringify(rewrite(JSON.parse(data.toString()) as ServerEvent)));
    });
  });
}

async function capture(testInfo: TestInfo, name: string): Promise<void> {
  await page.mouse.move(0, 0);
  const path = join(evidenceDirectory, `${name}.png`);
  await page.screenshot({ animations: "disabled", path });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

test.beforeAll(async () => {
  mkdirSync(evidenceDirectory, { recursive: true });
  staleSince = new Date(Date.now() - 47 * MINUTE_MS).toISOString();
  app = await createAppFixture({
    name: "compact-on-return",
    initialState: "conversation",
    beforeLaunch: ({ testDirectory, workspaceDirectory }) => {
      const store = new RuntimeStore(join(testDirectory, "data", "inertia.sqlite"), workspaceDirectory, { recoverInterruptedRuns: false });
      try {
        const conversation = store.shellSnapshot().conversations[0]!;
        conversationId = conversation.id;
        store.updateConversation(conversationId, {
          title: "Billing service migration",
          providerId: "claude",
          modelSelection: CLAUDE_SELECTION,
          model: "",
        });
        const requestedAt = new Date(Date.now() - 52 * MINUTE_MS).toISOString();
        const completedAt = new Date(Date.now() - 48 * MINUTE_MS).toISOString();
        const { turn } = store.beginAgentTurn({
          conversationId,
          runId: "compact-on-return-run",
          content: "Move the invoice tables to the new billing schema and keep the old exporter running.",
          providerId: "claude",
          modelSelection: CLAUDE_SELECTION,
          reasoningEffort: "",
          interactionMode: "build",
          accessMode: "supervised",
          configurationRevision: CLAUDE_SELECTION.backendConfigurationRevision,
          association: "authoritative",
          requestedAt,
        });
        seededTurnId = turn.id;
        store.updateAgentTurnLifecycle(turn.id, { status: "running", startedAt: requestedAt, updatedAt: requestedAt });
        const answer = store.createMessage(
          conversationId,
          "The invoice tables now live in the billing schema. The old exporter still reads through a compatibility view, so nothing downstream changed yet.",
          "assistant",
          [],
          turn.id,
          completedAt,
        );
        store.updateAgentTurnLifecycle(turn.id, {
          status: "completed",
          completedAt,
          updatedAt: completedAt,
          terminalAssistantMessageId: answer.id,
          terminalReason: "provider-completed",
        });
        store.createTurnGitArtifact({ turnId: turn.id, branch: "main", createdAt: completedAt });
        store.completeTurnGitArtifact(turn.id, {
          files: [],
          insertions: 0,
          deletions: 0,
          status: "ready",
          completeness: "complete",
          patchState: "none",
          capturedAt: completedAt,
          terminalAssistantMessageId: answer.id,
          updatedAt: completedAt,
        });
        store.updateSettings({ theme: "light" });
      } finally {
        store.close();
      }
    },
  });
  page = app.page;
  await routeRuntime(page);
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
});

test.afterAll(async () => {
  await app?.close();
});

test("offers Compact and send on a stale API-key chat, then shows the compaction on return", async ({ browserName: _browserName }, testInfo) => {
  test.setTimeout(180_000);
  await app.resizeWindow(1280, 820);
  const message = page.getByRole("textbox", { name: "Message" });

  for (const theme of ["light", "dark"] as const) {
    await setAppearance(page, theme);
    await message.fill(DRAFT);
    const offer = page.getByRole("button", { name: "Compact and send" });
    await expect(offer).toBeVisible();
    await expect(offer).toHaveAccessibleDescription("Summarize 252K tokens of history, then send");
    await expect(page.getByRole("button", { name: "Full history" })).toHaveAttribute("aria-pressed", "false");
    await app.expectNoViewportOverflow();
    await capture(testInfo, `compact-and-send-offer-${theme}`);
  }

  const usageTrigger = page.getByRole("button", { name: /^Open usage and context\./u });
  await usageTrigger.click();
  const meter = page.getByRole("dialog", { name: "Usage & context" });
  await expect(meter.getByText(/^Prompt cache expired \d+ min ago$/u)).toBeVisible();
  await capture(testInfo, "usage-meter-cache-expired-dark");
  await page.keyboard.press("Escape");
  await expect(meter).toBeHidden();
  await expect(usageTrigger).toBeFocused();

  const fullHistory = page.getByRole("button", { name: "Full history" });
  await fullHistory.focus();
  await page.keyboard.press("Space");
  await expect(fullHistory).toBeFocused();
  await expect(fullHistory).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  await capture(testInfo, "full-history-chosen-dark");
  await page.keyboard.press("Space");
  await expect(fullHistory).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("button", { name: "Compact and send" })).toBeVisible();

  await setAppearance(page, "light");
  await message.fill(DRAFT);
  await message.press("Enter");
  await expect.poll(() => compactRequests.length).toBe(1);
  expect(compactRequests[0]!.payload).toEqual({
    conversationId,
    content: DRAFT,
    attachments: [],
    activate: false,
    reason: "on-return",
  });
  await expect(page.getByRole("status").filter({ hasText: "Compacting before sending…" })).toBeVisible();
  await expect(page.getByRole("separator", { name: "Compacting before sending" })).toBeVisible();
  await expect(message).toHaveValue(DRAFT);
  await capture(testInfo, "compacting-before-sending-light");

  compactedAt = new Date().toISOString();
  phase = "compacted";
  releaseCompaction?.();
  await expect(message).toHaveValue("");
  await page.reload();
  const row = page.getByRole("separator", { name: "Compacted on return 252K → 18.3K tokens" });
  await expect(row).toBeVisible();
  await expect(page.getByText("/compact", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Compact and send" })).toHaveCount(0);
  for (const theme of ["light", "dark"] as const) {
    await setAppearance(page, theme);
    await expect(row).toBeVisible();
    await app.expectNoViewportOverflow();
    await capture(testInfo, `compacted-on-return-${theme}`);
  }

  await setAppearance(page, "light", null);
  const sections = page.getByRole("navigation", { name: "Settings sections" });
  await sections.getByRole("button", { name: "Chats", exact: true }).click();
  const setting = page.getByRole("radiogroup", { name: "Compact large API chats when you return" });
  await setting.scrollIntoViewIfNeeded();
  await expect(setting.getByRole("radio", { name: "Offer" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByText("Offers Compact and send when you return to a chat of 200K tokens or more on an Anthropic or OpenAI API key after its prompt cache has expired. Later turns then cost less. Enter follows the button.")).toBeVisible();
  await capture(testInfo, "chats-setting-light");

  await sections.getByRole("button", { name: "Agents", exact: true }).click();
  const add = page.getByRole("region", { name: "Claude Code" }).getByRole("button", { name: "Add API key for Claude Code" });
  await add.click();
  const dialog = page.getByRole("dialog", { name: "Add Anthropic API key" });
  const cache = dialog.getByRole("group", { name: "Prompt cache" });
  await expect(cache.getByRole("radio", { name: "5 minutes (default)" })).toBeChecked();
  await cache.scrollIntoViewIfNeeded();
  await capture(testInfo, "add-api-key-prompt-cache-light");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(add).toBeFocused();

  expect(app.rendererErrors).toEqual([]);
});
