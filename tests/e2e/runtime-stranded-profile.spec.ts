import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { readSystemBootId } from "../../src/main/system-boot-id";
import { ConversationAttachmentStore } from "../../src/node/conversation-attachment-store";
import { RuntimeGenerationLeaseJournal } from "../../src/node/runtime-generation-leases";
import { RuntimeStore } from "../../src/server/database";
import { createAppFixture } from "./support/app-fixture";

const reply = "A new turn completed after profile recovery.";
const provider = `
if (process.argv[2] === "--help") {
  process.stdout.write("Usage: codex app-server [OPTIONS] - Run the app server\\n");
  process.exit(0);
}
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
let threadId = "recovered-profile-thread";
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialized") return;
  if (message.method === "initialize") return send({ id: message.id, result: { userAgent: "recovered-profile-fixture" } });
  if (message.method === "model/list") return send({ id: message.id, result: { data: [], nextCursor: null } });
  if (message.method === "account/rateLimits/read") return send({ id: message.id, result: { rateLimits: null, rateLimitsByLimitId: null } });
  if (message.method === "thread/goal/get") return send({ id: message.id, result: { goal: null } });
  if (message.method === "thread/start" || message.method === "thread/resume") {
    threadId = message.params.threadId || threadId;
    return send({ id: message.id, result: { thread: { id: threadId }, cwd: process.cwd(), model: "fixture", serviceTier: null, initialTurnsPage: null } });
  }
  if (message.method !== "turn/start") return;
  const turn = { id: "recovered-profile-turn", status: "inProgress", items: [], error: null };
  send({ id: message.id, result: { turn } });
  send({ method: "turn/started", params: { threadId, turn } });
  send({ method: "item/agentMessage/delta", params: { threadId, turnId: turn.id, itemId: "answer", delta: ${JSON.stringify(reply)} } });
  send({ method: "turn/completed", params: { threadId, turn: { ...turn, status: "completed" } } });
});
`;

test("recovers a previous-boot stranded profile and completes a new turn @runtime-recovery", async () => {
  const currentBoot = readSystemBootId();
  expect(currentBoot).not.toBeNull();
  const priorBoot = process.platform === "win32"
    ? `win32:${(Number.parseInt(currentBoot!.slice(6), 16) === 0 ? 1 : 0).toString(16).padStart(8, "0")}`
    : `${process.platform}:${randomUUID()}`;
  expect(priorBoot).not.toBe(currentBoot);
  const generation = `${randomUUID()}:50`;
  const oldTurnId = randomUUID();
  const attachmentId = randomUUID();
  let conversationId = "";
  let originalImage: Buffer;
  const app = await createAppFixture({
    name: "stranded-profile",
    initialState: "conversation",
    codexAppServerSource: provider,
    beforeLaunch: async ({ testDirectory, workspaceDirectory }) => {
      const dataDirectory = join(testDirectory, "data");
      originalImage = await readFile(join(testDirectory, "preview.png"));
      const attachment = { id: attachmentId, path: attachmentId, name: "saved-preview.png", mimeType: "image/png", size: originalImage.length } as const;
      const attachments = await ConversationAttachmentStore.open(dataDirectory);
      try { await attachments.retain([{ attachment, bytes: originalImage }]); }
      finally { await attachments.close(); }
      const store = new RuntimeStore(join(dataDirectory, "inertia.sqlite"), workspaceDirectory, { recoverInterruptedRuns: false });
      try {
        conversationId = store.shellSnapshot().activeConversationId!;
        const message = store.createMessage(conversationId, "Saved work before the interrupted update.", "user", [attachment]);
        const turn = store.createAgentTurn({
          id: oldTurnId, conversationId, runId: randomUUID(), userMessageId: message.id,
          providerId: "codex", harnessId: "codex-app-server", backendProfileId: "codex-local",
          model: "gpt-test", reasoningEffort: "high", interactionMode: "build", accessMode: "supervised",
          configurationRevision: 0, association: "authoritative",
        });
        store.updateAgentTurnLifecycle(turn.id, { status: "running" });
        store.updateConversation(conversationId, { status: "running" });
        store.providerRunOwnership.record(turn.id, conversationId, turn.runId, generation, priorBoot, new Date().toISOString());
      } finally { store.close(); }
      // Deliberately reproduce the old profile's lease without a session,
      // claim, containment, or cleanup receipt. No real process is represented.
      expect(new RuntimeGenerationLeaseJournal(dataDirectory).publish(generation, priorBoot)).toBe(true);
    },
  });
  const assertSavedProfile = async (completedNewTurn = false): Promise<void> => {
    const dataDirectory = join(app.testDirectory, "data");
    expect(new RuntimeGenerationLeaseJournal(dataDirectory).all().some((lease) => lease.runtimeGenerationId === generation)).toBe(false);
    const store = new RuntimeStore(join(dataDirectory, "inertia.sqlite"), app.workspaceDirectory, { recoverInterruptedRuns: false });
    try {
      expect(store.agentTurn(oldTurnId)).toMatchObject({ status: "interrupted", terminalReason: "runtime-restart" });
      expect(store.providerRunOwnership.all().some((owner) => owner.runtimeGenerationId === generation)).toBe(false);
      expect(store.shellSnapshot().activeConversationId).toBe(conversationId);
      if (completedNewTurn) {
        const newTurns = store.agentTurnsForConversation(conversationId)
          .filter((turn) => turn.id !== oldTurnId);
        expect(newTurns).toHaveLength(1);
        expect(newTurns[0]).toMatchObject({ status: "completed" });
      }
    } finally { store.close(); }
    const attachments = await ConversationAttachmentStore.open(dataDirectory);
    try { expect((await attachments.preview(attachmentId))?.bytes).toEqual(originalImage); }
    finally { await attachments.close(); }
    await expect(app.page.getByText("Saved work before the interrupted update.", { exact: true })).toBeVisible();
  };
  try {
    expect(await app.runtimeSnapshot()).toMatchObject({ phase: "ready" });
    await assertSavedProfile();
    const composer = app.page.getByRole("region", { name: "Message composer" });
    await composer.getByRole("textbox", { name: "Message" }).fill("Continue after recovery.");
    await composer.getByRole("button", { name: "Send message" }).click();
    await expect(app.page.getByText(reply, { exact: true })).toBeVisible();
    await expect(composer.getByRole("button", { name: "Stop agent" })).toHaveCount(0);
    await app.restart();
    expect(await app.runtimeSnapshot()).toMatchObject({ phase: "ready" });
    await assertSavedProfile(true);
    await expect(app.page.getByText(reply, { exact: true })).toBeVisible();
  } finally { await app.close(); }
});
