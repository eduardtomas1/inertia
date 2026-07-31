import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { RemoteRuntimeGateway } from "../../src/server/remote-gateway";
import { RemoteTranscriptCache } from "../../src/server/remote-transcript-cache";
import type { RemoteAuthorizationSubject } from "../../src/shared/remote-protocol";
import {
  remoteConversationGrantsFromProjectIds,
} from "../../src/shared/remote-grants";
import {
  remotePromptSafetyForHarness,
} from "../../src/shared/remote-prompt-safety";

const temporaryDirectories: string[] = [];
const stores: RuntimeStore[] = [];
const BUDGET_BYTES = 512 * 1024;

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "inertia-remote-memory-"));
  temporaryDirectories.push(directory);
  const store = new RuntimeStore(join(directory, "inertia.sqlite"), directory);
  stores.push(store);
  const project = store.createProject("Project", directory);
  const conversation = store.createConversation(project.id, "Conversation");
  const transcriptCache = new RemoteTranscriptCache({
    budgetBytes: BUDGET_BYTES,
  });
  const gateway = new RemoteRuntimeGateway({
    shell: () => store.shellSnapshot(),
    detail: (conversationId) => store.conversationDetail(conversationId),
    isConversationActive: () => false,
    preparePrompt: async () => undefined,
    queuePrompt: () => ({ turnId: "turn" }),
    remotePromptSafety: () => remotePromptSafetyForHarness("codex-app-server"),
    transcriptCache,
    now: () => new Date("2030-01-01T00:00:00.000Z"),
  });
  const subject: RemoteAuthorizationSubject = {
    deviceId: "09400fa3-32c0-4d8d-8d17-e8ea0a4f6937",
    sessionId: "7f0c11aa-9ee8-4e3c-8f8f-0907e31b389e",
    scopes: ["view"],
    projectIds: [project.id],
    grants: remoteConversationGrantsFromProjectIds([project.id]),
    grantVersion: 1,
    expiresAt: "2030-02-01T00:00:00.000Z",
  };
  return { store, gateway, transcriptCache, subject, project, conversation };
}

async function transcript(
  gateway: RemoteRuntimeGateway,
  subject: RemoteAuthorizationSubject,
  conversationId: string,
): Promise<{ id: string; content: string }[]> {
  const response = await gateway.request(subject, {
    type: "conversation.get",
    requestId: "6bbd21ad-3f1a-4e6f-8a86-2e3f0c3f5c11",
    conversationId,
  });
  if (!response.ok || response.result.kind !== "conversation") {
    throw new Error("The gateway refused the transcript request.");
  }
  return response.result.detail.messages.map(({ id, content }) => ({
    id,
    content,
  }));
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("remote gateway transcript memory", () => {
  it("stays inside the byte budget for many multi-megabyte messages", async () => {
    const { store, gateway, transcriptCache, subject, conversation } = fixture();
    for (let index = 0; index < 24; index += 1) {
      store.createMessage(
        conversation.id,
        `Answer ${index}. ${"prose ".repeat(200_000)}`,
        "assistant",
      );
    }
    await transcript(gateway, subject, conversation.id);
    expect(transcriptCache.retainedBytes()).toBeLessThanOrEqual(BUDGET_BYTES);
    await transcript(gateway, subject, conversation.id);
    expect(transcriptCache.retainedBytes()).toBeLessThanOrEqual(BUDGET_BYTES);
  });

  it("returns identical sanitized content across repeated fetches", async () => {
    const { store, gateway, subject, conversation } = fixture();
    store.createMessage(
      conversation.id,
      "See /Users/someone/keys.txt with token_abcdefghijklmnop",
      "assistant",
    );
    const first = await transcript(gateway, subject, conversation.id);
    const second = await transcript(gateway, subject, conversation.id);
    expect(second).toEqual(first);
    expect(first[0]?.content).not.toContain("/Users/someone");
    expect(first[0]?.content).toContain("<redacted-secret>");
  });

  it("stops serving cached content once the conversation is forgotten", async () => {
    const { store, gateway, transcriptCache, subject, conversation } = fixture();
    store.createMessage(conversation.id, "remembered prose", "assistant");
    await transcript(gateway, subject, conversation.id);
    expect(transcriptCache.size()).toBe(1);
    gateway.forgetConversation(conversation.id);
    expect(transcriptCache.size()).toBe(0);
    expect(transcriptCache.retainedBytes()).toBe(0);
  });

  it("forgets a single message without dropping its neighbours", async () => {
    const { store, gateway, transcriptCache, subject, conversation } = fixture();
    const first = store.createMessage(conversation.id, "first", "assistant");
    store.createMessage(conversation.id, "second", "assistant");
    await transcript(gateway, subject, conversation.id);
    expect(transcriptCache.size()).toBe(2);
    gateway.forgetMessage(conversation.id, first.id);
    expect(transcriptCache.size()).toBe(1);
  });

  it("drops all sensitive cached state when the gateway is reset", async () => {
    const { store, gateway, transcriptCache, subject, conversation } = fixture();
    store.createMessage(conversation.id, "sensitive prose", "assistant");
    await transcript(gateway, subject, conversation.id);
    expect(transcriptCache.retainedBytes()).toBeGreaterThan(0);
    gateway.reset();
    expect(transcriptCache.size()).toBe(0);
    expect(transcriptCache.retainedBytes()).toBe(0);
  });

  it("retains only the projection, never the original provider message", async () => {
    const { store, gateway, transcriptCache, subject, conversation } = fixture();
    const source = `\`\`\`\n${"secret source line\n".repeat(200_000)}\`\`\``;
    expect(source.length).toBeGreaterThan(3_000_000);
    store.createMessage(conversation.id, source, "assistant");
    const messages = await transcript(gateway, subject, conversation.id);
    expect(messages[0]?.content).toBe("[Code omitted on Remote Companion]");
    expect(transcriptCache.size()).toBe(1);
    expect(transcriptCache.retainedBytes()).toBeLessThan(2_000);
  });
});
