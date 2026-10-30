import { expect, test, type TestInfo } from "@playwright/test";
import { join } from "node:path";

import { RuntimeStore } from "../../src/server/database";
import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { setAppearanceInPlace } from "./support/appearance";
import { focusAppWindow } from "./support/window-focus";

const TITLE = "Release parser plan";
const FIRST = "Plan the dotted version parser fix.";
const SECOND = "Try the risky tokenizer rewrite.";
const FORK_REQUEST = "Explore the conservative split instead.";

const appServer = `
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
if (process.argv[2] === "--help") {
  process.stdout.write("Usage: codex app-server [OPTIONS] - Run the app server\\n");
  process.exit(0);
}
let threadId = "history-thread";
let turnSequence = 0;
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ id: message.id, result: { userAgent: "history-fixture" } });
  if (message.method === "config/read") return send({ id: message.id, result: { config: {} } });
  if (message.method === "model/list") return send({ id: message.id, result: { data: [], nextCursor: null } });
  if (message.method === "account/rateLimits/read") {
    return send({ id: message.id, result: { rateLimits: null, rateLimitsByLimitId: null } });
  }
  if (message.method === "thread/goal/get") return send({ id: message.id, result: { goal: null } });
  if (message.method === "thread/start" || message.method === "thread/resume") {
    threadId = message.params.threadId || threadId;
    return send({ id: message.id, result: { thread: { id: threadId }, model: "fixture" } });
  }
  if (message.method === "turn/start") {
    const prompt = (message.params.input || []).filter((item) => item.type === "text").map((item) => item.text).join("\\n");
    const requests = ${JSON.stringify([FIRST, SECOND, FORK_REQUEST])};
    const request = requests.filter((candidate) => prompt.includes(candidate))
      .reduce((first, candidate) => prompt.indexOf(candidate) < prompt.indexOf(first) ? candidate : first);
    const turn = { id: "history-turn-" + (++turnSequence), status: "inProgress", items: [], error: null };
    send({ id: message.id, result: { turn } });
    send({ method: "turn/started", params: { threadId, turn } });
    send({ method: "item/agentMessage/delta", params: { threadId, turnId: turn.id, itemId: turn.id + "-answer",
      delta: "Fixture answer: " + request } });
    return send({ method: "turn/completed", params: { threadId, turn: { ...turn, status: "completed" } } });
  }
  if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: "Method not found" } });
});
`;

let app!: AppFixture;

test.beforeAll(async () => {
  app = await createAppFixture({
    name: "history-rollback-merge-back",
    initialState: "conversation",
    codexAppServerSource: appServer,
    beforeLaunch: ({ testDirectory, workspaceDirectory }) => {
      const store = new RuntimeStore(join(testDirectory, "data", "inertia.sqlite"), workspaceDirectory, { recoverInterruptedRuns: false });
      try {
        const conversationId = store.shellSnapshot().activeConversationId;
        if (!conversationId) throw new Error("The history fixture requires an active chat.");
        store.updateConversation(conversationId, { title: TITLE });
      } finally {
        store.close();
      }
    },
  });
});

test.afterAll(async () => {
  await app?.close();
});

function openStore(): RuntimeStore {
  return new RuntimeStore(join(app.testDirectory, "data", "inertia.sqlite"), app.workspaceDirectory, { recoverInterruptedRuns: false });
}

async function capture(info: TestInfo, name: string, assertStage: () => Promise<void>): Promise<void> {
  for (const theme of ["dark", "light"] as const) {
    await setAppearanceInPlace(app, theme);
    await expect(app.page.getByText("Capturing changes…", { exact: true })).toHaveCount(0);
    await assertStage();
    await expect(app.page.locator(".response-turn.is-settling")).toHaveCount(0);
    await expect(app.page.getByText("Capturing changes…", { exact: true })).toHaveCount(0);
    const path = info.outputPath(`${name}-${theme}.png`);
    await app.page.screenshot({ path, animations: "disabled" });
    await info.attach(`${name}-${theme}`, { path, contentType: "image/png" });
  }
}

async function send(text: string): Promise<void> {
  const { page } = app;
  await page.getByRole("textbox", { name: "Message" }).fill(text);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByText(`Fixture answer: ${text}`, { exact: true })).toBeVisible();
}

test("rolls back chat context from a retained turn and merges a fork's findings into its source chat", async ({ browserName: _browserName }, info) => {
  test.setTimeout(150_000);
  const { page } = app;
  await app.resizeWindow(1440, 920);
  await focusAppWindow(app.electronApp, page);
  await expect(page.getByRole("heading", { name: TITLE, level: 1 })).toBeVisible();
  await send(FIRST);
  await send(SECOND);

  const firstTurn = page.getByRole("region", { name: "Turn 1" });
  const secondTurn = page.getByRole("region", { name: "Turn 2" });
  const trigger = firstTurn.getByRole("button", { name: "Roll back to here" });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const confirmation = firstTurn.getByRole("group", { name: "Confirm rollback" });
  await expect(confirmation).toContainText("Workspace files are not changed.");
  await expect(confirmation.getByRole("button", { name: "Roll back", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(confirmation).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await page.keyboard.press("Enter");
  await capture(info, "rollback-confirmation", async () => {
    await expect(confirmation).toContainText("Workspace files are not changed.");
    await expect(confirmation.getByRole("button", { name: "Roll back", exact: true })).toBeFocused();
    await secondTurn.hover();
    await expect(secondTurn.getByRole("button", { name: "Roll back to here" })).toBeVisible();
    await expect(secondTurn.locator(".turn-meta-primary")).toHaveCSS("opacity", "1");
  });
  await page.keyboard.press("Enter");

  await expect(firstTurn.getByRole("alert")).toHaveCount(0);
  await expect(firstTurn.getByRole("status").filter({ hasText: /^Rolled back 1 later turn\./u })).toBeVisible();
  await expect(trigger).toBeFocused();
  await expect(secondTurn.getByText("Rolled back · not in context", { exact: true })).toBeVisible();
  await expect(secondTurn.getByRole("button", { name: "Roll back to here" })).toHaveCount(0);
  await expect(secondTurn).toHaveClass(/is-rolled-back/u);
  await expect(page.getByText(SECOND, { exact: true })).toBeVisible();
  const assertRetainedHistory = async (): Promise<void> => {
    await firstTurn.getByRole("button", { name: "Fork from here" }).focus();
    await secondTurn.hover();
    await expect(firstTurn.locator(".turn-meta-primary")).toHaveCSS("opacity", "1");
    await expect(secondTurn.locator(".turn-meta-primary")).toHaveCSS("opacity", "1");
    await expect(firstTurn.getByRole("button", { name: "Fork from here" })).toBeVisible();
    await expect(secondTurn.getByText("Rolled back · not in context", { exact: true })).toBeVisible();
    await expect(secondTurn).toHaveClass(/is-rolled-back/u);
    await expect(secondTurn.getByRole("button", { name: "Roll back to here" })).toHaveCount(0);
    await expect(page.getByText(SECOND, { exact: true })).toBeVisible();
  };
  await capture(info, "rollback-retained-turn", async () => {
    await assertRetainedHistory();
    await expect(firstTurn.getByRole("status").filter({ hasText: /^Rolled back 1 later turn\./u })).toBeVisible();
  });

  await firstTurn.getByRole("button", { name: "Fork from here" }).click();
  await expect(page.getByRole("heading", { name: `${TITLE} fork`, level: 1 })).toBeVisible();
  await send(FORK_REQUEST);
  const lineage = page.getByRole("region", { name: "Fork lineage" });
  const merge = lineage.getByRole("button", { name: "Merge findings into source chat" });
  await merge.focus();
  await page.keyboard.press("Enter");
  await expect(lineage.getByRole("alert")).toHaveCount(0);
  await expect(lineage.getByRole("status").filter({ hasText: "Attached 2 messages from 1 turn to the source chat's next message." }))
    .toBeVisible();
  await capture(info, "merge-back-confirmation", async () => {
    await expect(page.getByRole("heading", { name: `${TITLE} fork`, level: 1 })).toBeVisible();
    await expect(lineage.getByRole("status").filter({ hasText: "Attached 2 messages from 1 turn to the source chat's next message." }))
      .toBeVisible();
    await expect(page.getByText(`Fixture answer: ${FORK_REQUEST}`, { exact: true })).toBeVisible();
    await firstTurn.hover();
    await expect(firstTurn.locator(".turn-meta-primary")).toHaveCSS("opacity", "1");
  });

  const sidebar = page.getByRole("complementary", { name: "Project navigation", exact: true });
  await sidebar.getByText(TITLE, { exact: true }).click();
  await expect(page.getByRole("heading", { name: TITLE, level: 1 })).toBeVisible();
  const composer = page.getByRole("region", { name: "Message composer" });
  await expect(composer.getByText(`${TITLE} fork`, { exact: false })).toBeVisible();
  await capture(info, "merge-back-source-draft", async () => {
    await expect(page.getByRole("heading", { name: TITLE, level: 1 })).toBeVisible();
    await expect(composer.getByText(`${TITLE} fork`, { exact: false })).toBeVisible();
    await assertRetainedHistory();
  });

  const store = openStore();
  try {
    const sourceId = store.shellSnapshot().activeConversationId!;
    const drafts = store.contextPackets.list(sourceId).filter(({ consumedMessageId }) => consumedMessageId === null);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ note: `Merge-back from fork "${TITLE} fork".`, messageCount: 2 });
    expect(store.conversationDetail(sourceId)?.rolledBackTurnIds).toHaveLength(1);
  } finally {
    store.close();
  }
});
