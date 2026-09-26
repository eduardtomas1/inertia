import { describe, expect, it } from "vitest";

import type {
  AgentTurn,
  Conversation,
  ConversationDetail,
  ConversationDetailResult,
  ConversationDetailViewState,
  ConversationShell,
} from "../../src/shared/contracts";
import {
  continuationIdentityForSelection,
  providerNativeModelSelection,
} from "../../src/shared/model-routing";
import {
  mergeConversationShell,
  resolveConversationDetail,
} from "../../src/renderer/src/utils/conversationDetail";
import { mergeConversationHistory } from "../../src/renderer/src/utils/conversationHistory";
import { mergeProjectionPlans } from "../../src/renderer/src/utils/terminalTurnProjection";

const conversation: Conversation = {
  id: "conversation-1",
  projectId: "project-1",
  title: "Stored title",
  modelSelection: providerNativeModelSelection({
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
  subagents: [],
  reasonings: [],
  usage: [],
  plans: [],
  goals: [],
  checkpoints: [],
  reviewSummaries: [],
  reviewStates: [],
  reviewNotes: [],
};

const agentTurn: AgentTurn = {
  id: "turn-1",
  conversationId: conversation.id,
  runId: "run-1",
  userMessageId: "message-1",
  terminalAssistantMessageId: null,
  providerId: conversation.providerId,
  modelSelection: conversation.modelSelection,
  continuationIdentity: continuationIdentityForSelection(
    conversation.modelSelection,
  ),
  harnessId: conversation.modelSelection.harnessId,
  backendProfileId: conversation.modelSelection.backendProfileId,
  model: conversation.model,
  modelAlias: null,
  reasoningEffort: conversation.reasoningEffort,
  interactionMode: conversation.interactionMode,
  accessMode: conversation.accessMode,
  providerSessionBefore: null,
  providerSessionAfter: null,
  requestedAt: conversation.createdAt,
  startedAt: conversation.createdAt,
  completedAt: null,
  status: "running",
  terminalReason: null,
  checkpointId: null,
  usageAtStart: null,
  usageAtCompletion: null,
  configurationRevision: 1,
  association: "authoritative",
  createdAt: conversation.createdAt,
  updatedAt: conversation.createdAt,
};

describe("paged history reconciliation", () => {
  const older = { at: conversation.createdAt, id: "old-turn", kind: "turn" as const };
  const page = (id: string, content: string): ConversationDetail => ({
    ...detail, history: { older }, agentTurns: [{ ...agentTurn, id }],
    messages: [{ ...detail.messages[0]!, id: `message-${id}`, turnId: id, content }],
  });
  const plannedPage = (index: number, step = `Plan ${index}`): ConversationDetail => {
    const id = `turn-${index}`;
    const at = `2026-07-25T10:0${index}:00.000Z`;
    return { ...page(id, `Message ${index}`),
      agentTurns: [{ ...agentTurn, id, runId: `run-${index}`, requestedAt: at }],
      plans: [{ conversationId: conversation.id, turnId: id, runId: `run-${index}`,
        explanation: null, steps: [{ step, status: "completed" }] }] };
  };

  it.each(["older", "target"] as const)("keeps the latest plan selected after loading %s history and refreshing", (mode) => {
    const recent = plannedPage(3);
    const old = plannedPage(1);
    const loaded = mergeConversationHistory(recent, old, mode);
    const refreshed = mergeConversationHistory(loaded, plannedPage(3, "Updated latest plan"), "refresh");
    expect(refreshed.plans.map(({ runId }) => runId)).toEqual(["run-1", "run-3"]);
    expect(mergeProjectionPlans(refreshed.plans, undefined).at(-1)?.steps[0]?.step)
      .toBe("Updated latest plan");
    expect(recent.plans[0]?.steps[0]?.step).toBe("Plan 3");
    expect(old.plans[0]?.steps[0]?.step).toBe("Plan 1");
  });

  it("orders successive search targets between already loaded distant and latest plans", () => {
    const distant = mergeConversationHistory(plannedPage(4), plannedPage(1), "target");
    const middle = mergeConversationHistory(distant, plannedPage(3), "target");
    const complete = mergeConversationHistory(middle, plannedPage(2), "target");
    expect(complete.plans.map(({ runId }) => runId)).toEqual(["run-1", "run-2", "run-3", "run-4"]);
    expect(mergeProjectionPlans(complete.plans, undefined).at(-1)?.steps[0]?.step).toBe("Plan 4");
  });

  it.each(["older", "target"] as const)("deduplicates overlapping %s plans without replacing current values", (mode) => {
    const current = plannedPage(2, "Current plan");
    const stale = plannedPage(2, "Stale plan");
    const merged = mergeConversationHistory(current, stale, mode);
    expect(merged.plans).toEqual(current.plans);
    const withOlder = mergeConversationHistory(merged, plannedPage(1), "older");
    const cleared = mergeConversationHistory(withOlder, { ...current, plans: [] }, "refresh");
    expect(cleared.plans.map(({ runId }) => runId)).toEqual(["run-1"]);
  });

  it("retains legacy plan order while refreshing their values and owned plans", () => {
    const legacy = { ...plannedPage(1).plans[0]!, turnId: null, runId: "legacy" };
    const current = { ...plannedPage(2), plans: [legacy, ...plannedPage(2).plans] };
    const loaded = mergeConversationHistory(current, plannedPage(1), "older");
    const updatedLegacy = { ...legacy, explanation: "Updated legacy plan" };
    const refreshed = mergeConversationHistory(loaded,
      { ...plannedPage(2), plans: [updatedLegacy, ...plannedPage(2).plans] }, "refresh");
    expect(refreshed.plans.map(({ runId }) => runId)).toEqual(["legacy", "run-1", "run-2"]);
    expect(refreshed.plans[0]).toBe(updatedLegacy);
  });

  it("replaces another conversation's history even when its run identities match", () => {
    const current = plannedPage(1, "Current chat");
    const other = plannedPage(1, "Other chat");
    other.conversation = { ...conversation, id: "other-conversation" };
    other.plans = other.plans.map((plan) => ({ ...plan, conversationId: other.conversation.id }));
    expect(mergeConversationHistory(current, other, "target")).toBe(other);
    expect(other.plans).toHaveLength(1);
    expect(other.plans[0]?.steps[0]?.step).toBe("Other chat");
  });

  it("retains older pages while refreshing the active turn authoritatively", () => {
    const current = mergeConversationHistory(page("live", "streaming"), page("old", "saved"), "older");
    const next = page("live", "complete");
    const updated = mergeConversationHistory(current, next, "refresh");
    expect(updated.messages.map(({ content }) => content).sort()).toEqual(["complete", "saved"]);
    expect(updated.agentTurns).toHaveLength(2);
    expect(updated.history).toEqual(current.history);
  });

  it("does not overwrite newer live data when a delayed older page overlaps it", () => {
    const current = page("live", "complete");
    const old = { ...page("live", "stale"), history: { older: null } };
    expect(mergeConversationHistory(current, old, "older").messages[0]?.content).toBe("complete");
    expect(mergeConversationHistory(current, old, "older").history?.older).toBeNull();
  });

  it("keeps the contiguous cursor when loading a distant search result", () => {
    const current = page("recent", "recent");
    const distant = { ...page("distant", "hit"), history: { older: null } };
    const merged = mergeConversationHistory(current, distant, "target");
    expect(merged.messages).toHaveLength(2);
    expect(merged.history?.older).toEqual(older);
  });

  it("resets a disconnected latest window to avoid silently skipping offline turns", () => {
    const current = { ...page("old", "old"), history: { older: null } };
    const latest = page("new", "new");
    expect(mergeConversationHistory(current, latest, "refresh")).toBe(latest);
  });
});

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
  it("replaces the complete conversation route from the authoritative shell", () => {
    const loadedSelection = providerNativeModelSelection({
      providerId: "codex",
      modelId: "gpt-5",
      reasoningEffort: "high",
    });
    const shellSelection = {
      ...providerNativeModelSelection({
        providerId: "claude",
        modelId: "claude-sonnet-4-5",
        reasoningEffort: "medium",
      }),
      backendConfigurationRevision: 3,
    };
    const loadedConversation: Conversation = {
      ...conversation,
      providerId: "codex",
      modelSelection: loadedSelection,
      continuationIdentity: continuationIdentityForSelection(
        loadedSelection,
        "codex-endpoint",
      ),
      model: loadedSelection.modelId,
      reasoningEffort: "high",
      providerSessionId: "codex-session",
      updatedAt: "2026-07-25T10:00:00.000Z",
    };
    const authoritativeShell: ConversationShell = {
      ...shell,
      providerId: "claude",
      modelSelection: shellSelection,
      continuationIdentity: continuationIdentityForSelection(
        shellSelection,
        "claude-endpoint",
        true,
      ),
      model: shellSelection.modelId,
      reasoningEffort: "medium",
      providerSessionId: null,
      updatedAt: "2026-07-25T11:00:00.000Z",
    };
    const loadedDetail: ConversationDetail = {
      ...detail,
      conversation: loadedConversation,
    };
    const detailBefore = structuredClone(loadedDetail);
    const shellBefore = structuredClone(authoritativeShell);

    const merged = mergeConversationShell(loadedDetail, authoritativeShell);
    const expectedConversation = { ...authoritativeShell } as Record<string, unknown>;
    delete expectedConversation.latestTurn;
    delete expectedConversation.pendingApproval;
    delete expectedConversation.pendingInput;

    expect(merged.conversation).toEqual(expectedConversation);
    expect(merged.conversation.modelSelection).toBe(shellSelection);
    expect(merged.conversation.continuationIdentity)
      .toBe(authoritativeShell.continuationIdentity);
    expect(merged.messages).toBe(loadedDetail.messages);
    expect(merged.activities).toBe(loadedDetail.activities);
    expect(merged.subagents).toBe(loadedDetail.subagents);
    expect(merged.reasonings).toBe(loadedDetail.reasonings);
    expect(merged.plans).toBe(loadedDetail.plans);
    expect(merged.goals).toBe(loadedDetail.goals);
    expect(merged.checkpoints).toBe(loadedDetail.checkpoints);
    expect(merged.usage).toBe(loadedDetail.usage);
    expect(merged.reviewSummaries).toBe(loadedDetail.reviewSummaries);
    expect(merged.reviewStates).toBe(loadedDetail.reviewStates);
    expect(merged.reviewNotes).toBe(loadedDetail.reviewNotes);
    expect(merged.turnGitArtifacts).toBe(loadedDetail.turnGitArtifacts);
    expect(loadedDetail).toEqual(detailBefore);
    expect(authoritativeShell).toEqual(shellBefore);
  });

  it("keeps shell metadata authoritative without replacing heavy detail", () => {
    const merged = mergeConversationShell(detail, shell);
    expect(merged.conversation).toMatchObject({
      title: "Authoritative shell title",
      status: "completed",
      completedAt: shell.completedAt,
    });
    expect(merged.messages).toEqual(detail.messages);
  });

  it("projects the latest shell lifecycle onto an already-loaded turn", () => {
    const updatedAt = "2026-07-25T10:00:30.000Z";
    const blockedShell: ConversationShell = {
      ...shell,
      status: "needs-input",
      attentionKind: "approval",
      latestTurn: {
        id: agentTurn.id,
        runId: agentTurn.runId,
        status: "waiting-for-approval",
        runState: {
          state: "waiting-for-approval",
          providerState: "approval/requested",
          revision: 7,
        },
        providerId: agentTurn.providerId,
        harnessId: agentTurn.harnessId,
        backendProfileId: agentTurn.backendProfileId,
        modelSelection: agentTurn.modelSelection,
        continuationIdentity: agentTurn.continuationIdentity,
        model: agentTurn.model,
        reasoningEffort: agentTurn.reasoningEffort,
        requestedAt: agentTurn.requestedAt,
        startedAt: agentTurn.startedAt,
        completedAt: null,
        terminalReason: null,
        updatedAt,
      },
    };
    const loadedDetail = { ...detail, agentTurns: [agentTurn] };
    const merged = mergeConversationShell(loadedDetail, blockedShell);

    expect(merged.agentTurns).not.toBe(loadedDetail.agentTurns);
    expect(merged.agentTurns[0]).toMatchObject({
      id: agentTurn.id,
      status: "waiting-for-approval",
      runState: {
        state: "waiting-for-approval",
        providerState: "approval/requested",
        revision: 7,
      },
      updatedAt,
    });
    expect(merged.messages).toBe(loadedDetail.messages);
  });

  it("keeps a loaded terminal turn when the shell snapshot still reports it running", () => {
    const completedAt = "2026-07-25T10:00:40.000Z";
    const completedTurn: AgentTurn = {
      ...agentTurn,
      status: "completed",
      terminalReason: "provider-completed",
      completedAt,
      updatedAt: completedAt,
    };
    const staleShell: ConversationShell = {
      ...shell,
      status: "running",
      latestTurn: {
        id: agentTurn.id,
        runId: agentTurn.runId,
        status: "running",
        runState: agentTurn.runState,
        providerId: agentTurn.providerId,
        harnessId: agentTurn.harnessId,
        backendProfileId: agentTurn.backendProfileId,
        modelSelection: agentTurn.modelSelection,
        continuationIdentity: agentTurn.continuationIdentity,
        model: agentTurn.model,
        reasoningEffort: agentTurn.reasoningEffort,
        requestedAt: agentTurn.requestedAt,
        startedAt: agentTurn.startedAt,
        completedAt: null,
        terminalReason: null,
        updatedAt: "2026-07-25T10:00:20.000Z",
      },
    };
    const loadedDetail = { ...detail, agentTurns: [completedTurn] };

    const merged = mergeConversationShell(loadedDetail, staleShell);
    expect(merged.agentTurns[0]).toBe(completedTurn);
    const resolved = resolveConversationDetail(
      { conversationId: conversation.id, state: "loading" },
      conversation.id,
      { kind: "conversation.detail", conversationId: conversation.id, state: "ready", detail: loadedDetail },
      staleShell,
    );
    expect(resolved?.state === "ready" && resolved.detail.agentTurns[0]?.status).toBe("completed");
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
