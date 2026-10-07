// @inertia-e2e-resource isolated
import { expect, test, type TestInfo } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { RuntimeStore } from "../../src/server/database";
import { providerNativeBackendProfile, providerNativeModelSelection } from "../../src/shared/model-routing";
import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { setAppearanceInPlace } from "./support/appearance";
import { focusAppWindow } from "./support/window-focus";

const TITLE = "Fix the release parser";
const REQUEST = "Make the release parser accept dotted versions.";
const ANSWER = "The parser now accepts dotted versions, and the tests cover 1.2.3 and 1.2.3.4.";
const FOLLOW_UP = "Also accept a leading v in the version.";
const CODEX_REPLY = "The parser now strips a leading v before it splits the version.";
const PROMPT_RECEIPT = "handoff-prompt.txt";

const handoffAppServer = `
const fs = require("node:fs");
const path = require("node:path");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
if (process.argv[2] === "--help") {
  process.stdout.write("Usage: codex app-server [OPTIONS] - Run the app server\\n");
  process.exit(0);
}
let threadId = "handoff-thread";
let turnSequence = 0;
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ id: message.id, result: { userAgent: "handoff-fixture" } });
  if (message.method === "model/list") return send({ id: message.id, result: { data: [], nextCursor: null } });
  if (message.method === "account/rateLimits/read") {
    return send({ id: message.id, result: { rateLimits: null, rateLimitsByLimitId: null } });
  }
  if (message.method === "thread/goal/get") return send({ id: message.id, result: { goal: null } });
  if (message.method === "thread/start" || message.method === "thread/resume") {
    threadId = message.params.threadId || threadId;
    return send({ id: message.id, result: { thread: { id: threadId }, model: "fixture" } });
  }
  if (message.method !== "turn/start") return;
  const prompt = (message.params.input || []).filter((item) => item.type === "text").map((item) => item.text).join("\\n");
  const receipt = path.join(process.cwd(), ".git", ${JSON.stringify(PROMPT_RECEIPT)});
  fs.writeFileSync(receipt + ".tmp", prompt);
  fs.renameSync(receipt + ".tmp", receipt);
  const turn = { id: "handoff-turn-" + (++turnSequence), status: "inProgress", items: [], error: null };
  send({ id: message.id, result: { turn } });
  send({ method: "turn/started", params: { threadId, turn } });
  send({ method: "item/agentMessage/delta", params: { threadId, turnId: turn.id, itemId: "handoff-answer", delta: ${JSON.stringify(CODEX_REPLY)} } });
  send({ method: "turn/completed", params: { threadId, turn: { ...turn, status: "completed" } } });
});
`;

let app!: AppFixture;
let limitedChatId = "";
let conversationCount = 0;

function openStore(): RuntimeStore {
  return new RuntimeStore(join(app.testDirectory, "data", "inertia.sqlite"), app.workspaceDirectory, { recoverInterruptedRuns: false });
}

function seedUsageLimitedClaudeChat(store: RuntimeStore): string {
  const project = store.snapshot().projects[0]!;
  const source = store.createConversation(project.id, TITLE, {
    modelSelection: providerNativeModelSelection({ providerId: "claude", modelId: "claude-sonnet-4-6" }),
  });
  const requestedAt = new Date(Date.now() - 60_000).toISOString();
  const failedAt = new Date(Date.now() - 30_000).toISOString();
  const run = store.createWorkspaceRun({ kind: "agent", projectId: source.projectId, conversationId: source.id,
    label: TITLE, detail: null, status: "running", port: null });
  const { turn } = store.beginAgentTurn({ conversationId: source.id, runId: run.id, content: REQUEST,
    providerId: source.providerId, modelSelection: source.modelSelection, reasoningEffort: source.reasoningEffort,
    accessMode: source.accessMode, interactionMode: source.interactionMode, configurationRevision: 0,
    association: "authoritative", requestedAt });
  store.updateAgentTurnLifecycle(turn.id, { status: "running", startedAt: requestedAt, updatedAt: requestedAt });
  store.createMessage(source.id, ANSWER, "assistant", [], turn.id, failedAt);
  store.updateAgentTurnLifecycle(turn.id, { status: "failed", terminalReason: "provider-error", completedAt: failedAt, updatedAt: failedAt });
  store.updateWorkspaceRun(run.id, { status: "failed", finishedAt: failedAt });
  store.limitResets.markUsageLimited(turn.id);
  store.updateConversation(source.id, { status: "failed" });
  store.createTurnGitArtifact({ turnId: turn.id, status: "unavailable", completeness: "unavailable",
    failureReason: "Not captured in this fixture.", absenceReason: "not-repository" });
  store.selectConversation(source.id);
  return source.id;
}

test.beforeAll(async () => {
  app = await createAppFixture({
    name: "conversation-continuation",
    initialState: "conversation",
    codexAppServerSource: handoffAppServer,
    beforeLaunch: ({ testDirectory, workspaceDirectory }) => {
      const store = new RuntimeStore(join(testDirectory, "data", "inertia.sqlite"), workspaceDirectory, { recoverInterruptedRuns: false });
      try {
        limitedChatId = seedUsageLimitedClaudeChat(store);
        conversationCount = store.snapshot().conversations.length;
      } finally {
        store.close();
      }
    },
  });
});

test.afterAll(async () => {
  await app?.close();
});

async function capture(info: TestInfo, name: string): Promise<void> {
  for (const theme of ["dark", "light"] as const) {
    await setAppearanceInPlace(app, theme);
    const path = info.outputPath(`${name}-${theme}.png`);
    await app.page.mouse.move(0, 0);
    await app.page.screenshot({ path, animations: "disabled" });
    await info.attach(`${name}-${theme}`, { path, contentType: "image/png" });
  }
}

test("continues a usage-limited Claude chat on Codex in place with its earlier messages", async ({ browserName: _browserName }, info) => {
  test.setTimeout(120_000);
  const { page } = app;
  await app.resizeWindow(1440, 920);
  await focusAppWindow(app.electronApp, page);
  await expect(page.getByRole("heading", { name: TITLE, level: 1 })).toBeVisible();

  const composer = page.getByRole("region", { name: "Message composer" });
  const row = composer.getByRole("group", { name: "Usage limit" });
  const continueElsewhere = row.getByRole("button", { name: "Continue with another model", exact: true });
  await expect(row.getByText("Usage limit reached", { exact: true })).toBeVisible();
  await expect(continueElsewhere).toBeEnabled();
  await capture(info, "continuation-limited-row");

  const chooser = page.getByRole("dialog", { name: "Choose model" });
  await continueElsewhere.focus();
  await page.keyboard.press("Enter");
  await expect(chooser.getByRole("combobox", { name: "Search models" })).toBeFocused();
  await chooser.getByRole("button", { name: /^Codex, \d+ models?$/u }).click();
  const codexDefault = chooser.getByRole("grid", { name: "Model results" }).locator(".model-chooser-row-option")
    .filter({ hasText: /^Provider default/u });
  await expect(codexDefault).toBeEnabled();
  await codexDefault.click();
  await expect(chooser).toBeHidden();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);

  const notice = composer.getByRole("status").filter({
    hasText: "Next message starts a new Codex session with this chat's earlier messages as context.",
  });
  await expect(notice).toBeVisible();
  await expect(row).toHaveCount(0);
  await expect(page.getByText(REQUEST, { exact: true })).toBeVisible();
  await expect(page.getByText(ANSWER, { exact: true })).toBeVisible();
  await expect.poll(() => {
    const store = openStore();
    try {
      const snapshot = store.snapshot();
      const { providerId, modelSelection, providerSessionId, continuationIdentity } = store.conversation(limitedChatId);
      return {
        activeConversationId: snapshot.activeConversationId,
        conversationCount: snapshot.conversations.length,
        providerId,
        backendProfileId: modelSelection.backendProfileId,
        modelId: modelSelection.modelId,
        providerSessionId,
        continuationIdentity,
        turnCount: store.conversationDetail(limitedChatId)!.agentTurns.length,
      };
    } finally {
      store.close();
    }
  }).toEqual({
    activeConversationId: limitedChatId,
    conversationCount,
    providerId: "codex",
    backendProfileId: providerNativeBackendProfile("codex").id,
    modelId: "provider-default",
    providerSessionId: null,
    continuationIdentity: null,
    turnCount: 1,
  });
  await capture(info, "continuation-handoff-pending");

  const message = page.getByRole("textbox", { name: "Message" });
  await message.fill(FOLLOW_UP);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByText(CODEX_REPLY, { exact: true })).toBeVisible();

  const separator = page.getByRole("separator", {
    name: /^Context handoff: Claude · claude-sonnet-4-6 to Codex(?: · [^·]+)? · 2 earlier messages restored$/u,
  });
  await expect(separator).toBeVisible();
  const answerBox = await page.getByText(ANSWER, { exact: true }).boundingBox();
  const dividerBox = await separator.boundingBox();
  const followUpBox = await page.getByText(FOLLOW_UP, { exact: true }).boundingBox();
  expect(answerBox!.y).toBeLessThan(dividerBox!.y);
  expect(dividerBox!.y).toBeLessThan(followUpBox!.y);
  await expect(page.getByText(/Provider changed · 2 earlier messages restored/u)).toBeVisible();
  await expect(composer.getByText(/Next message starts a new/u)).toHaveCount(0);

  const prompt = await readFile(join(app.workspaceDirectory, ".git", PROMPT_RECEIPT), "utf8");
  expect(prompt).toContain(FOLLOW_UP);
  expect(prompt).toContain(REQUEST);
  expect(prompt).toContain(ANSWER);
  const store = openStore();
  try {
    const turns = store.conversationDetail(limitedChatId)!.agentTurns;
    expect(turns).toHaveLength(2);
    expect(turns.find(({ providerId }) => providerId === "codex")).toMatchObject({
      status: "completed",
      continuationReasonCode: "harness-changed",
      providerSessionBefore: null,
      sessionRecovery: { restoredMessageCount: 2, omittedMessageCount: 0 },
    });
    expect(store.snapshot().conversations).toHaveLength(conversationCount);
  } finally {
    store.close();
  }
  await separator.scrollIntoViewIfNeeded();
  await capture(info, "continuation-handoff-divider");
  expect(app.rendererErrors).toEqual([]);
});
