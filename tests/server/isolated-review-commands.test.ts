import type WebSocket from "ws";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Conversation } from "../../src/shared/contracts";
import type { RuntimeStore } from "../../src/server/database";
import { ConversationWorkAuthority } from "../../src/server/runtime/conversation-work-authority";
import {
  createIsolatedReviewCommandHandler,
  type IsolatedReviewCommandDependencies,
} from "../../src/server/runtime/commands/isolated-review-commands";

const reviewSupport = vi.hoisted(() => ({
  selectedReviewContext: vi.fn(),
  captureRequiredCheckpoint: vi.fn(),
}));

vi.mock("../../src/server/runtime/commands/review-support", async (original) => ({
  ...await original<typeof import("../../src/server/runtime/commands/review-support")>(),
  selectedReviewContext: reviewSupport.selectedReviewContext,
  captureRequiredCheckpoint: reviewSupport.captureRequiredCheckpoint,
}));

const projectId = "11111111-1111-4111-8111-111111111111";
const conversationId = "22222222-2222-4222-8222-222222222222";
const requestId = "33333333-3333-4333-8333-333333333333";
const turnId = "44444444-4444-4444-8444-444444444444";
const conversation = {
  id: conversationId,
  projectId,
  providerId: "codex",
} as Conversation;
const command = {
  type: "review.selection.revise" as const,
  requestId,
  payload: {
    projectId,
    conversationId,
    repositoryPath: ".",
    fingerprint: "a".repeat(64),
    filePath: "src/example.ts",
    hunkId: "hunk-1",
    lineIds: ["line-1"],
    ignoreWhitespace: false,
  },
};

function deferred<Value>(): {
  promise: Promise<Value>;
  resolve: (value: Value) => void;
} {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function fixture(authority: ConversationWorkAuthority) {
  const start = vi.fn(() => true);
  const queue = vi.fn(() => ({ turn: { id: turnId } }));
  const dependencies = {
    store: {
      conversation: vi.fn(() => conversation),
      conversationWork: authority,
    } as unknown as RuntimeStore,
    turns: {
      isActive: vi.fn(() => false),
      queue,
      start,
    },
    isolatedRuns: { has: vi.fn(() => false) },
    secureFiles: {},
    dataDirectory: "/private/inertia-data",
    enableProviders: true,
    providerInfo: () => [{ id: "codex", canRun: true }],
    publicError: (error: unknown) => String(error),
    broadcastSnapshot: vi.fn(),
    send: vi.fn(),
  } as unknown as IsolatedReviewCommandDependencies;
  return { dependencies, queue, start };
}

describe("isolated review revision authority", () => {
  beforeEach(() => {
    reviewSupport.selectedReviewContext.mockReset();
    reviewSupport.captureRequiredCheckpoint.mockReset();
  });

  it("rejects a resumed terminal before reading the diff or creating a checkpoint", async () => {
    const authority = new ConversationWorkAuthority(() => projectId);
    expect(authority.reserve(conversationId)).toBe(true);
    const { dependencies, queue } = fixture(authority);

    await expect(createIsolatedReviewCommandHandler(dependencies)(
      {} as WebSocket,
      command,
    )).rejects.toThrow("End the resumed provider terminal");

    expect(reviewSupport.selectedReviewContext).not.toHaveBeenCalled();
    expect(reviewSupport.captureRequiredCheckpoint).not.toHaveBeenCalled();
    expect(queue).not.toHaveBeenCalled();
  });

  it("holds conversation ownership from diff read through turn start", async () => {
    const authority = new ConversationWorkAuthority(() => projectId);
    const context = deferred<{
      visibleContent: string;
      requestContext: { diffSelections: [] };
      patch: string;
      filePath: string;
      hunkHeader: string;
      selectedLineCount: number;
    }>();
    reviewSupport.selectedReviewContext.mockReturnValue(context.promise);
    reviewSupport.captureRequiredCheckpoint.mockImplementation(async () => {
      expect(authority.hasConversation(conversationId)).toBe(true);
      return { id: "checkpoint-1", label: "Before revision" };
    });
    const { dependencies, queue, start } = fixture(authority);
    start.mockImplementation(() => {
      expect(authority.hasConversation(conversationId)).toBe(true);
      return true;
    });

    const pending = createIsolatedReviewCommandHandler(dependencies)(
      {} as WebSocket,
      command,
    );
    await vi.waitFor(() => {
      expect(reviewSupport.selectedReviewContext).toHaveBeenCalledOnce();
    });
    expect(authority.hasConversation(conversationId)).toBe(true);
    expect(authority.reserve(conversationId)).toBe(false);

    context.resolve({
      visibleContent: "Revise this selection",
      requestContext: { diffSelections: [] },
      patch: "",
      filePath: "src/example.ts",
      hunkHeader: "@@ -1 +1 @@",
      selectedLineCount: 1,
    });

    await expect(pending).resolves.toBe("handled");
    expect(queue).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledWith(turnId);
    expect(authority.hasConversation(conversationId)).toBe(false);
  });
});
