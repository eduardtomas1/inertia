import { describe, expect, it } from "vitest";

import type {
  Conversation,
  ConversationDetail,
  ConversationDetailResult,
  ConversationDetailViewState,
  ConversationShell,
} from "../../src/shared/contracts";
import { nativeModelSelection } from "../../src/shared/model-routing";
import {
  mergeConversationShell,
  resolveConversationDetail,
} from "../../src/renderer/src/utils/conversationDetail";

const conversation: Conversation = {
  id: "conversation-1",
  projectId: "project-1",
  title: "Stored title",
  modelSelection: nativeModelSelection({
    providerId: "codex",
    modelId: "gpt",
    reasoningEffort: "high",
  }),
  continuationIdentity: null,
  providerId: "codex",
  model: "gpt",
  reasoningEffort: "high",
  interactionMode: "build",
  accessMode: "supervised",
  status: "idle",
  attentionKind: null,
  branch: "main",
  worktreePath: null,
  providerSessionId: "session-1",
  archivedAt: null,
  settledAt: null,
  completedAt: null,
  lastViewedAt: null,
  createdAt: "2026-07-25T10:00:00.000Z",
  updatedAt: "2026-07-25T10:00:00.000Z",
};

const shell: ConversationShell = {
  ...conversation,
  title: "Authoritative shell title",
  status: "completed",
  completedAt: "2026-07-25T10:01:00.000Z",
  updatedAt: "2026-07-25T10:01:00.000Z",
  latestTurn: null,
  pendingApproval: false,
  pendingInput: false,
};

const detail: ConversationDetail = {
  conversation,
  agentTurns: [],
  turnGitArtifacts: [],
  messages: [{
    id: "message-1",
    conversationId: conversation.id,
    turnId: null,
    role: "user",
    content: "Keep this transcript.",
    attachments: [],
    createdAt: conversation.createdAt,
  }],
  activities: [],
  reasonings: [],
  usage: [],
  plans: [],
  checkpoints: [],
  reviewSummaries: [],
  reviewStates: [],
  reviewNotes: [],
};

function result(
  state: ConversationDetailResult["state"],
  conversationId = conversation.id,
): ConversationDetailResult {
  if (state === "ready") {
    return { kind: "conversation.detail", conversationId, state, detail };
  }
  if (state === "failed") {
    return { kind: "conversation.detail", conversationId, state, message: "Database busy" };
  }
  return { kind: "conversation.detail", conversationId, state };
}

describe("conversation detail projection", () => {
  it("keeps shell metadata authoritative without replacing heavy detail", () => {
    const merged = mergeConversationShell(detail, shell);
    expect(merged.conversation).toMatchObject({
      title: "Authoritative shell title",
      status: "completed",
      completedAt: shell.completedAt,
    });
    expect(merged.messages).toEqual(detail.messages);
  });

  it("resolves a matching load and ignores a stale response from another conversation", () => {
    const loading: ConversationDetailViewState = {
      conversationId: conversation.id,
      state: "loading",
    };
    const ready = resolveConversationDetail(
      loading,
      conversation.id,
      result("ready"),
      shell,
    );
    expect(ready?.state).toBe("ready");
    if (ready?.state === "ready") {
      expect(ready.detail.conversation.title).toBe(shell.title);
    }
    expect(resolveConversationDetail(
      ready,
      conversation.id,
      result("ready", "conversation-2"),
      shell,
    )).toBe(ready);
  });

  it("never flashes missing while an authoritative shell still exists", () => {
    const loading: ConversationDetailViewState = {
      conversationId: conversation.id,
      state: "loading",
    };
    expect(resolveConversationDetail(
      loading,
      conversation.id,
      result("missing"),
      shell,
    )).toEqual(loading);

    const ready = result("ready");
    expect(resolveConversationDetail(
      ready,
      conversation.id,
      result("missing"),
      shell,
    )).toBe(ready);
  });

  it("preserves authoritative missing, deleted, and failed results without a shell", () => {
    const loading: ConversationDetailViewState = {
      conversationId: conversation.id,
      state: "loading",
    };
    for (const state of ["missing", "deleted", "failed"] as const) {
      expect(resolveConversationDetail(
        loading,
        conversation.id,
        result(state),
        null,
      )).toEqual(result(state));
    }
  });
});
