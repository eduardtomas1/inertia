import { describe, expect, it } from "vitest";
import {
  continuationIdentityForSelection,
  MODEL_CAPABILITY_IDS,
  nativeBackendProfile,
  nativeModelSelection,
} from "../../src/shared/model-routing";
import { defaultSettings } from "../../src/shared/contracts/app";
import { parseServerEvent } from "../../src/shared/contracts/server-event-schema";
const selection = nativeModelSelection({
  providerId: "codex",
  modelId: "gpt-test",
  reasoningEffort: "high",
});
const claudeSelection = nativeModelSelection({ providerId: "claude", modelId: "claude-test" });
const nativeBackend = nativeBackendProfile("codex");
const capability = {
  id: "streaming",
  state: "verified",
  provenance: "built-in",
  detail: null,
};
const checkedAt = "2030-01-01T00:00:00.000Z";
const probeCapabilities = MODEL_CAPABILITY_IDS.map((id) => ({
  id,
  state: id === "streaming" ? "verified" : "unknown",
  provenance: "probe",
  detail: null,
  checkedAt,
}));
const backendProfile = {
  id: nativeBackend.id,
  displayName: nativeBackend.displayName,
  harnessId: selection.harnessId,
  protocol: nativeBackend.protocol,
  authenticationMode: nativeBackend.authenticationMode,
  source: nativeBackend.source,
  enabled: true,
  configurationRevision: nativeBackend.configurationRevision,
  endpointIdentity: nativeBackend.endpointIdentity,
  preset: "native",
  baseUrl: null,
  allowInsecureLocalhost: false,
  credentialGeneration: null,
  models: [{
    id: selection.modelId,
    displayName: "GPT Test",
    contextWindowTokens: null,
    reasoningOptions: [{ value: "high", label: "High", description: "Thorough." }],
    capabilities: [capability],
  }],
  routing: { mode: "simple", primaryModelId: selection.modelId },
  capabilityHints: [capability],
  createdAt: checkedAt,
  updatedAt: checkedAt,
  endpointHost: null,
  authState: "harness-managed",
  connectionState: "connected",
  compatibility: {
    harnessId: selection.harnessId,
    backendProfileId: nativeBackend.id,
    backendProtocol: nativeBackend.protocol,
    state: "verified",
    provenance: "built-in",
    allowsModelSwitchWithinSession: true,
    reasonCode: "native-backend",
    reason: "The native backend is supported.",
  },
  latestProbe: {
    profileId: nativeBackend.id,
    backendConfigurationRevision: nativeBackend.configurationRevision,
    endpointIdentity: nativeBackend.endpointIdentity,
    protocol: nativeBackend.protocol,
    modelId: selection.modelId,
    compatibility: "protocol-compatible",
    protocolVerified: true,
    modelVerified: true,
    capabilities: probeCapabilities,
    contextWindow: {
      tokens: null,
      state: "unknown",
      provenance: "probe",
      detail: null,
      checkedAt,
    },
    failure: null,
    checkedAt,
  },
  canDelete: false,
  canDisable: false,
};
const changedFile = {
  path: "src/example.ts",
  status: "modified",
  insertions: 2,
  deletions: 1,
  untracked: false,
  staged: false,
  unstaged: true,
  indexStatus: " ",
  worktreeStatus: "M",
};
const diff = {
  patch: "diff --git a/src/example.ts b/src/example.ts\n",
  truncated: false,
  files: [changedFile],
};
const conversation = {
  id: "conversation-1",
  projectId: "project-1",
  title: "Boundary",
  providerId: "codex",
  modelSelection: selection,
  continuationIdentity: null,
  model: "gpt-test",
  reasoningEffort: "high",
  interactionMode: "build",
  accessMode: "supervised",
  status: "idle",
  attentionKind: null,
  branch: "main",
  worktreePath: null,
  providerSessionId: null,
  archivedAt: null,
  settledAt: null,
  completedAt: null,
  lastViewedAt: null,
  createdAt: "2030-01-01T00:00:00.000Z",
  updatedAt: "2030-01-01T00:00:00.000Z",
};
const conversationShell = {
  ...conversation,
  latestTurn: {
    id: "turn-1",
    runId: "run-1",
    status: "running",
    providerId: "codex",
    harnessId: selection.harnessId,
    backendProfileId: selection.backendProfileId,
    modelSelection: selection,
    continuationIdentity: continuationIdentityForSelection(selection),
    model: selection.modelId,
    reasoningEffort: "high",
    requestedAt: checkedAt,
    startedAt: checkedAt,
    completedAt: null,
    terminalReason: null,
    updatedAt: checkedAt,
  },
  pendingApproval: false,
  pendingInput: false,
};
const conversationDetail = {
  conversation,
  agentTurns: [{
    id: "turn-1",
    conversationId: conversation.id,
    runId: "run-1",
    userMessageId: "message-1",
    terminalAssistantMessageId: null,
    providerId: "codex",
    modelSelection: selection,
    continuationIdentity: continuationIdentityForSelection(selection),
    harnessId: selection.harnessId,
    backendProfileId: selection.backendProfileId,
    model: selection.modelId,
    modelAlias: null,
    reasoningEffort: "high",
    interactionMode: "build",
    accessMode: "supervised",
    providerSessionBefore: null,
    providerSessionAfter: null,
    requestedAt: conversation.createdAt,
    startedAt: conversation.createdAt,
    completedAt: null,
    status: "running",
    terminalReason: null,
    checkpointId: "checkpoint-1",
    usageAtStart: null,
    usageAtCompletion: null,
    configurationRevision: selection.backendConfigurationRevision,
    association: "authoritative",
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
  }],
  turnGitArtifacts: [{
    id: "artifact-1",
    turnId: "turn-1",
    conversationId: conversation.id,
    runId: "run-1",
    repositoryIdentity: null,
    worktreeIdentity: null,
    branch: "main",
    beforeCheckpointId: null,
    beforeFingerprint: null,
    afterFingerprint: null,
    files: [{ ...changedFile, previousPath: null, binary: false }],
    insertions: 2,
    deletions: 1,
    status: "ready",
    completeness: "complete",
    patchState: "available",
    patchDigest: "sha256:patch",
    capturedAt: conversation.createdAt,
    terminalAssistantMessageId: null,
    failureReason: null,
    absenceReason: null,
  }],
  messages: [{
    id: "message-1",
    conversationId: conversation.id,
    turnId: "turn-1",
    role: "user",
    content: "Inspect this.",
    attachments: [{ id: "attachment-1", name: "note.txt", path: "/tmp/note.txt", mimeType: "text/plain", size: 4 }],
    createdAt: conversation.createdAt,
  }],
  activities: [{
    id: "activity-1",
    conversationId: conversation.id,
    runId: "run-1",
    turnId: "turn-1",
    kind: "tool",
    title: "Inspect",
    detail: null,
    status: "completed",
    createdAt: conversation.createdAt,
  }],
  subagents: [{
    id: "trace-1",
    conversationId: conversation.id,
    runId: "run-1",
    turnId: "turn-1",
    providerId: "codex",
    providerTaskId: null,
    providerAgentId: null,
    parentTraceId: null,
    parentProviderAgentId: null,
    parentProviderToolUseId: null,
    providerToolUseId: null,
    providerRole: null,
    providerName: null,
    providerStatus: null,
    status: "completed",
    isLive: false,
    description: null,
    progress: null,
    result: null,
    sequence: 1,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
  }],
  reasonings: [{
    id: "reasoning-1",
    conversationId: conversation.id,
    runId: "run-1",
    turnId: "turn-1",
    content: "Checked.",
    status: "completed",
    createdAt: conversation.createdAt,
  }],
  usage: [{
    conversationId: conversation.id,
    turnId: "turn-1",
    usedTokens: 10,
    totalProcessedTokens: 10,
    totalProcessedScope: "run",
    maxTokens: 100,
    inputTokens: 8,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 2,
    reasoningOutputTokens: 0,
    compactsAutomatically: false,
    updatedAt: conversation.updatedAt,
  }],
  plans: [{
    conversationId: conversation.id,
    runId: "run-1",
    turnId: "turn-1",
    explanation: null,
    steps: [{ step: "Inspect", status: "completed" }],
  }],
  goals: [{
    conversationId: conversation.id,
    source: "inertia-local",
    providerSessionId: null,
    objective: "Inspect safely",
    status: "active",
    tokenBudget: null,
    tokensUsed: null,
    timeUsedSeconds: null,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    synchronizedAt: null,
  }],
  checkpoints: [{
    id: "checkpoint-1",
    conversationId: conversation.id,
    turnId: "turn-1",
    ref: "refs/inertia/checkpoint",
    label: "Before",
    turnIndex: 1,
    filesChanged: 1,
    insertions: 2,
    deletions: 1,
    createdAt: conversation.createdAt,
  }],
  reviewSummaries: [{
    conversationId: conversation.id,
    fingerprint: "diff",
    providerId: "codex",
    harnessId: selection.harnessId,
    backendProfileId: selection.backendProfileId,
    model: selection.modelId,
    overall: "Looks good.",
    classifications: [],
    files: [],
    generatedAt: conversation.updatedAt,
  }],
  reviewStates: [{
    conversationId: conversation.id,
    repositoryPath: ".",
    scope: "file",
    path: "src/example.ts",
    hunkId: null,
    targetFingerprint: "file",
    reviewed: true,
    stale: false,
    updatedAt: conversation.updatedAt,
  }],
  reviewNotes: [{
    id: "note-1",
    conversationId: conversation.id,
    repositoryPath: ".",
    path: "src/example.ts",
    hunkId: null,
    lineIds: [],
    targetFingerprint: "file",
    body: "Reviewed.",
    stale: false,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
  }],
};
function event(result: Record<string, unknown>): unknown {
  return {
    type: "request.result",
    requestId: "request-1",
    result,
  };
}
const pullRequest = {
  available: true,
  remoteName: "origin",
  forge: "github",
  unavailableReason: null,
};
const gitStatus = { isRepository: true, authorityRef: "authority-1", root: "/repo",
  branch: "main", upstream: "origin/main", ahead: 0, behind: 0, hasRemote: true,
  pullRequest, files: [changedFile], insertions: 2, deletions: 1,
};
describe("server event request-result trust boundary", () => {
  it.each([
    { kind: "backend.profile", profile: backendProfile },
    { kind: "backend.profile.probe", profile: backendProfile },
    {
      kind: "workspace.entries",
      directory: "src",
      entries: [{ path: "src/example.ts", kind: "file" }],
      truncated: false,
    },
    {
      kind: "workspace.file",
      usedFallback: false,
      file: {
        path: "src/example.ts",
        content: "export {};",
        truncated: false,
        language: "typescript",
        contentDigest: "sha256:abc",
        modifiedAt: "2030-01-01T00:00:00.000Z",
        authorityRef: "authority-1",
      },
    },
    {
      kind: "git.branches",
      branches: [{ name: "main", current: true, remote: false, worktreePath: null }],
    },
    {
      kind: "project.actions",
      actions: [{ id: "test", label: "Test", command: "npm test", preview: false }],
    },
    { kind: "duo.pending", launchIds: ["launch-1"], hasMore: false },
    {
      kind: "duo.prepared",
      launchId: "launch-1",
      state: "prepared",
      sides: [
        { ordinal: 0, conversationId: "conversation-1", turnId: "turn-1" },
        { ordinal: 1, conversationId: "conversation-2", turnId: "turn-2" },
      ],
      comparison: { conversationId: "conversation-3" },
    },
    {
      kind: "duo.status",
      launchId: "launch-1",
      state: "running",
      error: null,
      sides: [
        { ordinal: 0, conversationId: "conversation-1", turnId: "turn-1", dispatchState: "started" },
        { ordinal: 1, conversationId: "conversation-2", turnId: "turn-2", dispatchState: "started" },
      ],
      comparison: {
        state: "waiting",
        conversationId: null,
        turnId: null,
        attempt: 0,
        error: null,
      },
    },
    {
      kind: "git.status",
      status: gitStatus,
    },
    {
      kind: "git.workspace.status",
      status: {
        repositories: [{
          repositoryPath: ".",
          authorityRef: "authority-1",
          state: "ready",
          error: null,
          branch: "main",
          upstream: "origin/main",
          ahead: 0,
          behind: 0,
          hasRemote: true,
          pullRequest,
          files: [changedFile],
          insertions: 2,
          deletions: 1,
          clean: false,
          truncated: false,
        }],
        files: 1,
        insertions: 2,
        deletions: 1,
        scannedDirectories: 2,
        skippedDirectories: 0,
        discoveredRepositories: 1,
        repositoryLimit: 64,
        partial: false,
        truncated: false,
        issues: [],
      },
    },
    { kind: "git.diff", diff },
    {
      kind: "git.workspace.diff",
      diff: { ...diff, repositoryPath: ".", reviewMetadataChanged: false },
    },
    {
      kind: "git.turn.diff",
      diff: {
        ...diff,
        artifactId: "artifact-1",
        turnId: "turn-1",
        title: "Turn changes",
        completeness: "complete",
        patchState: "available",
      },
    },
    {
      kind: "git.reversal.plan",
      plan: {
        authorityRef: "authority-1",
        filePath: "src/example.ts",
        hunkId: "hunk-1",
        hunkHeader: "@@ -1 +1 @@",
        selectedLineCount: 1,
        changedLineCount: 1,
        affectedLayers: ["worktree"],
        validation: {
          diffFingerprint: "diff",
          fileFingerprint: "file",
          hunkFingerprint: "hunk",
          selectionFingerprint: "selection",
          gitStateFingerprint: "state",
        },
      },
    },
    {
      kind: "git.reversal",
      diff,
      operation: {
        id: "operation-1",
        authorityRef: "authority-1",
        repositoryPath: ".",
        filePath: "src/example.ts",
        selectedLineCount: 1,
        affectedLayers: ["worktree"],
        createdAt: "2030-01-01T00:00:00.000Z",
      },
    },
    {
      kind: "review.selection.answer",
      answer: {
        conversationId: conversation.id,
        repositoryPath: ".",
        fingerprint: "diff",
        filePath: "src/example.ts",
        hunkId: "hunk-1",
        selectedLineCount: 1,
        question: "Safe?",
        answer: "Yes.",
        providerId: "codex",
        modelSelection: selection,
        generatedAt: "2030-01-01T00:00:00.000Z",
      },
    },
    {
      kind: "review.summary",
      summary: {
        conversationId: conversation.id,
        fingerprint: "diff",
        providerId: "codex",
        harnessId: selection.harnessId,
        backendProfileId: selection.backendProfileId,
        model: selection.modelId,
        overall: "Looks good.",
        classifications: [{ classification: "test-impact", evidence: "Tests changed." }],
        files: [{
          path: "src/example.ts",
          summary: "Safe change.",
          classifications: [],
          hunks: [{ hunkId: "hunk-1", summary: "Guarded.", classifications: [] }],
        }],
        generatedAt: "2030-01-01T00:00:00.000Z",
      },
    },
    {
      kind: "conversation.detail",
      conversationId: conversation.id,
      state: "ready",
      detail: conversationDetail,
      sync: { runtimeGeneration: "runtime-1", latestSequence: 4 },
    },
  ])("accepts a complete $kind projection", (result) => {
    expect(parseServerEvent(event(result))).toMatchObject({
      type: "request.result",
      result: { kind: result.kind },
    });
  });
  it.each([
    {
      kind: "backend.profile",
      profile: { ...backendProfile, compatibility: { state: "verified" } },
    },
    {
      kind: "backend.profile.probe",
      profile: {
        ...backendProfile,
        models: [{
          ...backendProfile.models[0],
          reasoningOptions: [{ value: "high", label: "High", description: 7 }],
        }],
      },
    },
    {
      kind: "backend.profile",
      profile: {
        ...backendProfile,
        routing: { mode: "simple", primaryModelId: "missing-model" },
      },
    },
    {
      kind: "backend.profile.probe",
      profile: {
        ...backendProfile,
        latestProbe: {
          ...backendProfile.latestProbe,
          contextWindow: {
            ...backendProfile.latestProbe.contextWindow,
            tokens: "many",
          },
        },
      },
    },
    { kind: "workspace.entries", directory: "", entries: [{ path: "x" }], truncated: false },
    { kind: "workspace.file", file: { path: "x", content: 7 } },
    {
      kind: "workspace.file",
      usedFallback: "yes",
      file: {
        path: "x",
        content: "x",
        truncated: false,
        language: "text",
        contentDigest: "sha256:abc",
        modifiedAt: "2030-01-01T00:00:00.000Z",
      },
    },
    { kind: "git.branches", branches: [{ name: "main", current: "yes" }] },
    { kind: "project.actions", actions: [{ id: "test", label: "Test", command: "x", preview: "no" }] },
    { kind: "duo.pending", launchIds: [7], hasMore: false },
    {
      kind: "duo.prepared",
      launchId: "launch",
      state: "prepared",
      sides: [
        { ordinal: 0, conversationId: "one", turnId: "turn" },
        { ordinal: 0, conversationId: "two", turnId: "turn" },
      ],
    },
    {
      kind: "duo.status",
      launchId: "launch",
      state: "running",
      cancelRequested: "yes",
      error: null,
      sides: [
        { ordinal: 0, conversationId: "one", turnId: "turn-one", dispatchState: "started" },
        { ordinal: 1, conversationId: "two", turnId: "turn-two", dispatchState: "started" },
      ],
    },
    {
      kind: "git.status",
      status: { files: [{ ...changedFile, insertions: "2" }] },
    },
    { kind: "git.workspace.status", status: { repositories: [{ repositoryPath: "." }] } },
    { kind: "git.diff", diff: { patch: "", truncated: false, files: [{ path: "x" }] } },
    { kind: "git.reversal.plan", plan: { filePath: "x", validation: {} } },
    { kind: "git.reversal", diff, operation: { id: "operation" } },
    {
      kind: "review.selection.answer",
      answer: { conversationId: "conversation", modelSelection: { ...selection, capabilities: [{}] } },
    },
    {
      kind: "review.selection.answer",
      answer: {
        conversationId: "conversation",
        modelSelection: {
          ...selection,
          providerOptions: { apiKey: "must-not-cross-the-runtime-boundary" },
        },
      },
    },
    {
      kind: "review.selection.answer",
      answer: {
        conversationId: "conversation",
        modelSelection: {
          ...selection,
          providerOptions: { metadata: "x".repeat(33_000) },
        },
      },
    },
    {
      kind: "review.summary",
      summary: {
        conversationId: "conversation",
        fingerprint: "diff",
        providerId: "codex",
        harnessId: null,
        backendProfileId: null,
        model: null,
        overall: "Broken",
        classifications: [{ classification: "invented", evidence: "No." }],
        files: [],
        generatedAt: "now",
      },
    },
    {
      kind: "conversation.detail",
      conversationId: conversation.id,
      state: "ready",
      detail: {
        ...conversationDetail,
        messages: [{ ...conversationDetail.messages[0], attachments: [{ id: "bad" }] }],
      },
    },
  ])("rejects malformed nested $kind state", (result) => {
    expect(() => parseServerEvent(event(result))).toThrow("Malformed server event");
  });
  it.each([
    { available: true, remoteName: null, forge: null, unavailableReason: "no-remotes" }, { available: true, remoteName: "", forge: "github", unavailableReason: null },
    { available: false, remoteName: "origin", forge: "github", unavailableReason: "unsupported-forge" }, { available: false, remoteName: null, forge: null, unavailableReason: null },
    { available: false, remoteName: "origin", forge: null, unavailableReason: "no-remotes" }, { available: false, remoteName: null, forge: null, unavailableReason: "unsupported-url" },
  ])("rejects incoherent pull-request capability state", (next) => {
    expect(() => parseServerEvent(event({ kind: "git.status", status: { ...gitStatus, pullRequest: next } }))).toThrow("Malformed server event");
  });
  it.each([
    [pullRequest, false, "main"], [pullRequest, true, null],
    [{ available: false, remoteName: null, forge: null, unavailableReason: "no-remotes" }, true, "main"], [{ available: false, remoteName: null, forge: null, unavailableReason: "no-branch" }, true, "main"],
    [{ available: false, remoteName: null, forge: null, unavailableReason: "no-remotes" }, false, null],
  ])("rejects pull-request capability contradictions with Git state", (next, hasRemote, branch) => {
    expect(() => parseServerEvent(event({ kind: "git.status", status: { ...gitStatus, hasRemote, branch, pullRequest: next } }))).toThrow("Malformed server event");
  });
  it("accepts the non-repository no-remotes projection", () => {
    expect(parseServerEvent(event({ kind: "git.status", status: { ...gitStatus, isRepository: false, root: null, branch: null, upstream: null, hasRemote: false, pullRequest: { available: false, remoteName: null, forge: null, unavailableReason: "no-remotes" } } }))).toBeTruthy();
  });
});

describe("usage dashboard event trust boundary", () => {
  const measured = {
    value: 0,
    measuredRequests: 0,
    totalRequests: 0,
    coverage: "complete",
  };
  const dashboard = {
    generatedAt: "2026-06-30T12:00:00.000Z",
    range: {
      days: 7,
      fromInclusive: "2026-06-24T00:00:00.000Z",
      toExclusive: "2026-07-01T00:00:00.000Z",
      startDate: "2026-06-24",
      endDate: "2026-06-30",
      timeZone: "UTC",
    },
    totals: {
      requestCount: 0,
      completedCount: 0,
      failedCount: 0,
      cancelledCount: 0,
      interruptedCount: 0,
      activeDays: 0,
      runtime: measured,
      processedTokens: measured,
    },
    daily: Array.from({ length: 7 }, (_, index) => ({
      date: `2026-06-${24 + index}`,
      requestCount: 0,
      completedCount: 0,
      failedCount: 0,
      cancelledCount: 0,
      interruptedCount: 0,
      runtime: measured,
      processedTokens: measured,
      providers: [],
    })),
    providers: [],
    models: [],
    tokens: {
      input: measured,
      cachedInput: measured,
      cacheWriteInput: measured,
      output: measured,
      reasoningOutput: measured,
    },
    cost: { status: "unavailable", reason: "No pricing provenance." },
  };

  it("accepts safe aggregates and rejects malformed or duplicate series", () => {
    expect(parseServerEvent(event({
      kind: "usage.dashboard",
      dashboard,
    }))).toBeTruthy();
    expect(() => parseServerEvent(event({
      kind: "usage.dashboard",
      dashboard: {
        ...dashboard,
        totals: { ...dashboard.totals, requestCount: -1 },
      },
    }))).toThrow("Malformed server event");
    expect(() => parseServerEvent(event({
      kind: "usage.dashboard",
      dashboard: {
        ...dashboard,
        totals: {
          ...dashboard.totals,
          requestCount: 1,
          processedTokens: { ...measured, coverage: "partial" },
        },
      },
    }))).toThrow("Malformed server event");
    expect(() => parseServerEvent(event({
      kind: "usage.dashboard",
      dashboard: {
        ...dashboard,
        totals: {
          ...dashboard.totals,
          processedTokens: { ...measured, coverage: "partial" },
        },
      },
    }))).toThrow("Malformed server event");
    expect(() => parseServerEvent(event({
      kind: "usage.dashboard",
      dashboard: {
        ...dashboard,
        daily: dashboard.daily.map((day) => ({
          ...day,
          date: dashboard.daily[0]!.date,
        })),
      },
    }))).toThrow("Malformed server event");
    expect(() => parseServerEvent(event({
      kind: "usage.dashboard",
      dashboard: {
        ...dashboard,
        daily: dashboard.daily.map((day) => {
          const { providers: _providers, ...withoutProviders } = day;
          return withoutProviders;
        }),
      },
    }))).toThrow("Malformed server event");
    expect(() => parseServerEvent(event({
      kind: "usage.dashboard",
      dashboard: {
        ...dashboard,
        range: { ...dashboard.range, days: "7" },
      },
    }))).toThrow("Malformed server event");
  });
});
describe("server event settings trust boundary", () => {
  const snapshotEvent = (settings: unknown): unknown => ({
    type: "snapshot.updated",
    snapshot: {
      projects: [],
      conversations: [],
      runs: [],
      providers: [],
      settings,
      activeProjectId: null,
      activeConversationId: null,
    },
  });
  it("accepts the canonical settings projection", () => {
    expect(parseServerEvent(snapshotEvent(defaultSettings))).toMatchObject({
      type: "snapshot.updated",
    });
  });
  it.each([
    ["theme", "sepia"],
    ["defaultProvider", "gemini"],
    ["defaultAccessMode", "unrestricted"],
    ["newThreadMode", "remote"],
    ["usageDisplayMode", "verbose"],
    ["interfaceScale", "huge"],
    ["responseDensity", "dense"],
    ["workspaceStartupSurface", "terminal"],
    ["autoScrollToFinalAnswer", "yes"],
    ["sidebarMode", "folders"],
    ["projectGrouping", "flat"],
    ["defaultInteractionMode", "chat"],
    ["terminalFontSize", 13.5],
  ])("rejects malformed nested settings.%s", (key, invalidValue) => {
    expect(() => parseServerEvent(snapshotEvent({
      ...defaultSettings,
      [key]: invalidValue,
    }))).toThrow("Malformed server event");
  });
});
describe("server event conversation discriminant boundary", () => {
  const snapshotEvent = (shell: unknown): unknown => ({
    type: "conversation.shell.updated",
    conversation: shell,
    runs: [],
  });
  const detailEvent = (nextConversation: unknown): unknown => event({
    kind: "conversation.detail",
    conversationId: conversation.id,
    state: "ready",
    detail: {
      ...conversationDetail,
      conversation: nextConversation,
    },
  });
  it("accepts canonical conversation enums through shell and detail projections", () => {
    expect(parseServerEvent(snapshotEvent(conversationShell)))
      .toMatchObject({ type: "conversation.shell.updated" });
    expect(parseServerEvent(detailEvent(conversation))).toMatchObject({
      type: "request.result",
      result: { kind: "conversation.detail", state: "ready" },
    });
  });
  it("validates response-speed identity while allowing pending conversation transitions", () => {
    expect(() => parseServerEvent(snapshotEvent({
      ...conversationShell,
      latestTurn: {
        ...conversationShell.latestTurn,
        continuationIdentity: {
          ...conversationShell.latestTurn.continuationIdentity,
          performanceModeIdentity: "fast:turbo",
        },
      },
    }))).toThrow("Malformed server event");

    const fastSelection = nativeModelSelection({
      providerId: "codex",
      modelId: "gpt-test",
      reasoningEffort: "high",
      providerOptions: { fastMode: "priority" },
    });
    expect(parseServerEvent(snapshotEvent({
      ...conversationShell,
      modelSelection: fastSelection,
      continuationIdentity: continuationIdentityForSelection(selection),
    }))).toMatchObject({ type: "conversation.shell.updated" });
    expect(parseServerEvent(snapshotEvent({
      ...conversationShell,
      continuationIdentity: continuationIdentityForSelection(fastSelection),
    }))).toMatchObject({ type: "conversation.shell.updated" });
    expect(() => parseServerEvent(snapshotEvent({
      ...conversationShell,
      latestTurn: {
        ...conversationShell.latestTurn,
        modelSelection: fastSelection,
        continuationIdentity: continuationIdentityForSelection(selection),
      },
    }))).toThrow("Malformed server event");

    const cursorSelection = nativeModelSelection({
      providerId: "cursor",
      modelId: "cursor-test",
    });
    expect(() => parseServerEvent(snapshotEvent({
      ...conversationShell,
      providerId: "cursor",
      modelSelection: cursorSelection,
      continuationIdentity: {
        ...continuationIdentityForSelection(cursorSelection),
        performanceModeIdentity: "fast:priority",
      },
      model: cursorSelection.modelId,
      latestTurn: null,
    }))).toThrow("Malformed server event");
    expect(() => parseServerEvent(snapshotEvent({
      ...conversationShell,
      continuationIdentity: {
        ...continuationIdentityForSelection(selection),
        performanceModeIdentity: "fast:fast",
      },
    }))).toThrow("Malformed server event");
    expect(() => parseServerEvent(snapshotEvent({
      ...conversationShell,
      latestTurn: {
        ...conversationShell.latestTurn,
        modelSelection: {
          ...cursorSelection,
          providerOptions: { fastMode: "priority" },
        },
        continuationIdentity: {
          ...continuationIdentityForSelection(cursorSelection),
          performanceModeIdentity: "fast:priority",
        },
        providerId: "cursor",
        harnessId: cursorSelection.harnessId,
        backendProfileId: cursorSelection.backendProfileId,
        model: cursorSelection.modelId,
      },
    }))).toThrow("Malformed server event");
  });
  it.each([
    ["providerId", "gemini"],
    ["modelSelection", claudeSelection],
    ["continuationIdentity", { ...continuationIdentityForSelection(selection), harnessId: "claude-agent-sdk" }],
    ["continuationIdentity", { ...continuationIdentityForSelection(selection), backendProfileId: "native:claude" }],
    ["continuationIdentity", { ...continuationIdentityForSelection(selection), backendConfigurationRevision: 99 }],
    ["continuationIdentity", { ...continuationIdentityForSelection(selection), modelIdentity: "other-model" }], ["model", "other-model"], ["reasoningEffort", "low"],
    ["latestTurn", { ...conversationShell.latestTurn, modelSelection: claudeSelection }], ["latestTurn", { ...conversationShell.latestTurn, model: "other-model" }],
    ["interactionMode", "chat"],
    ["accessMode", "unrestricted"],
    ["status", "sleeping"],
    ["attentionKind", "confirmation"],
  ])("rejects malformed shell conversation.%s", (key, invalidValue) => {
    expect(() => parseServerEvent(snapshotEvent({
      ...conversationShell,
      [key]: invalidValue,
    }))).toThrow("Malformed server event");
  });
  it.each([
    ["providerId", "gemini"],
    ["interactionMode", "chat"],
    ["accessMode", "unrestricted"],
    ["status", "sleeping"],
    ["attentionKind", "confirmation"],
  ])("rejects malformed detail conversation.%s", (key, invalidValue) => {
    expect(() => parseServerEvent(detailEvent({
      ...conversation,
      [key]: invalidValue,
    }))).toThrow("Malformed server event");
  });
  it.each([
    ["providerId", "gemini"],
    ["status", "sleeping"],
  ])("rejects malformed shell latestTurn.%s", (key, invalidValue) => {
    expect(() => parseServerEvent(snapshotEvent({
      ...conversationShell,
      latestTurn: {
        ...conversationShell.latestTurn,
        [key]: invalidValue,
      },
    }))).toThrow("Malformed server event");
  });
  it("rejects a ready detail whose outer conversation identity disagrees", () => {
    expect(() => parseServerEvent(event({
      kind: "conversation.detail",
      conversationId: "different-conversation",
      state: "ready",
      detail: conversationDetail,
    }))).toThrow("Malformed server event");
  });
  it.each([
    "agentTurns",
    "turnGitArtifacts",
    "messages",
    "activities",
    "subagents",
    "reasonings",
    "usage",
    "plans",
    "goals",
    "checkpoints",
    "reviewSummaries",
    "reviewStates",
    "reviewNotes",
  ])("rejects a mismatched detail.%s conversation identity", (collectionName) => {
    const collection = Reflect.get(conversationDetail, collectionName) as Array<Record<string, unknown>>;
    expect(collection).not.toHaveLength(0);
    expect(() => parseServerEvent(event({
      kind: "conversation.detail",
      conversationId: conversation.id,
      state: "ready",
      detail: {
        ...conversationDetail,
        [collectionName]: [{
          ...collection[0],
          conversationId: "different-conversation",
        }],
      },
    }))).toThrow("Malformed server event");
  });
});
describe("server event provider identity boundary", () => {
  const provider = {
    id: "codex",
    label: "Codex",
    command: "codex",
    available: true,
    version: "1.0.0",
    executable: "/opt/bin/codex",
    installState: "installed",
    authState: "authenticated",
    canRun: true,
    statusMessage: null,
    models: [{ id: "gpt-test", label: "GPT Test", description: "Test model", isDefault: true, inputModalities: ["text"], reasoningOptions: [], defaultReasoningEffort: "high", fastMode: { providerValue: "priority", label: "Fast", description: "Faster responses", isDefault: false } }],
    rateLimits: [{ id: "five-hour", label: "Five hour", usedPercent: 20, remainingPercent: 80, windowMinutes: 300, resetsAt: checkedAt }],
    metadataState: {
      models: {
        freshness: "fresh",
        provenance: "provider",
        updatedAt: checkedAt,
        lastAttemptedAt: checkedAt,
        refreshing: false,
      },
      rateLimits: {
        freshness: "fresh",
        provenance: "provider",
        updatedAt: checkedAt,
        lastAttemptedAt: checkedAt,
        refreshing: false,
      },
    },
  };
  const snapshotEvent = (providerInfo: unknown): unknown => ({
    type: "snapshot.updated",
    snapshot: {
      projects: [],
      conversations: [],
      runs: [],
      providers: [providerInfo],
      settings: defaultSettings,
      activeProjectId: null,
      activeConversationId: null,
    },
  });
  it.each(["codex", "claude", "cursor", "opencode"])(
    "accepts the canonical %s provider identity",
    (id) => {
      const expectedFastMode = id === "codex"
        ? provider.models[0].fastMode
        : id === "claude"
          ? { ...provider.models[0].fastMode, providerValue: "fast" }
          : null;
      expect(parseServerEvent(snapshotEvent({
        ...provider,
        id,
        models: [{ ...provider.models[0], fastMode: expectedFastMode }],
        agentThreadManagement: {
          state: "supported",
          detail: "Audited runtime capability.",
        },
      }))).toMatchObject({
        type: "snapshot.updated",
      });
    },
  );
  it.each([
    ["provider identity", { ...provider, id: "gemini" }], ["model IDs", { ...provider, models: [provider.models[0], { ...provider.models[0] }] }],
    ["Fast mode metadata", { ...provider, models: [{ ...provider.models[0], fastMode: { providerValue: 1, label: "Fast", description: "Broken", isDefault: false } }] }],
    ["cross-provider Fast mode", { ...provider, id: "cursor" }],
    ["wrong native Fast value", { ...provider, models: [{ ...provider.models[0], fastMode: { ...provider.models[0].fastMode, providerValue: "fast" } }] }],
    ["empty Fast label", { ...provider, models: [{ ...provider.models[0], fastMode: { ...provider.models[0].fastMode, label: "" } }] }],
    ["oversized Fast description", { ...provider, models: [{ ...provider.models[0], fastMode: { ...provider.models[0].fastMode, description: "x".repeat(501) } }] }],
    ["undeclared Fast metadata", { ...provider, models: [{ ...provider.models[0], fastMode: { ...provider.models[0].fastMode, apiKey: "never-cross-ipc" } }] }],
    ["rate-limit IDs", { ...provider, rateLimits: [provider.rateLimits[0], { ...provider.rateLimits[0] }] }],
    ["chat-tool capability", { ...provider, agentThreadManagement: { state: "invented", detail: "Unsafe" } }],
  ])("rejects duplicate or malformed %s", (_label, malformed) => {
    expect(() => parseServerEvent(snapshotEvent(malformed))).toThrow("Malformed server event");
  });
});
describe("server event workspace-run discriminant boundary", () => {
  const run = {
    id: "run-1",
    kind: "agent",
    projectId: "project-1",
    conversationId: conversation.id,
    actionId: null,
    label: "Agent run",
    detail: null,
    status: "running",
    attentionState: "unseen",
    canStop: true,
    port: null,
    startedAt: checkedAt,
    finishedAt: null,
  };
  const snapshotEvent = (workspaceRun: unknown): unknown => ({
    type: "conversation.shell.updated",
    conversation: conversationShell,
    runs: [workspaceRun],
  });
  it("accepts a canonical workspace run", () => {
    expect(parseServerEvent(snapshotEvent(run))).toMatchObject({
      type: "conversation.shell.updated",
    });
  });
  it.each([
    ["kind", "background"],
    ["status", "paused"],
    ["attentionState", "ignored"],
  ])("rejects malformed workspace run %s", (key, invalidValue) => {
    expect(() => parseServerEvent(snapshotEvent({
      ...run,
      [key]: invalidValue,
    }))).toThrow("Malformed server event");
  });
});
describe("server event remaining discriminant and identity boundary", () => {
  const project = {
    id: "project-1",
    name: "Boundary",
    path: "/workspace/boundary", normalizedPath: "/workspace/boundary",
    repositoryIdentity: null, repositoryRoot: null,
    repositoryRelativePath: ".",
    groupingMode: null,
    gitRepositoryLimit: 64,
    color: "violet",
    status: "ready",
    createdAt: checkedAt, updatedAt: checkedAt,
  };
  const maintenance = {
    providerId: "codex", installedVersion: "1.0.0",
    latestVersion: "1.0.1", versionStatus: "update-available",
    freshness: "fresh", checkedAt,
    installMethod: "npm-global", updateAvailability: "available",
    updateLabel: "Update", instructionsUrl: "https://example.test/update",
    message: null,
  };
  const operation = {
    id: "operation-1", providerId: "codex",
    status: "running", startedAt: checkedAt,
    finishedAt: null, afterVersion: null,
    beforeVersion: "1.0.0", targetVersion: "1.0.1",
    message: "Updating", output: null,
    outputTruncated: false,
  };
  const provider = {
    id: "codex", label: "Codex",
    command: "codex", available: true,
    version: "1.0.0", executable: "/opt/bin/codex",
    installState: "installed", authState: "authenticated",
    canRun: true, statusMessage: null,
    models: [], rateLimits: [],
    metadataState: {
      models: {
        freshness: "fresh",
        provenance: "provider",
        updatedAt: checkedAt,
        lastAttemptedAt: checkedAt,
        refreshing: false,
      },
      rateLimits: {
        freshness: "stale",
        provenance: "persistent-cache",
        updatedAt: checkedAt,
        lastAttemptedAt: checkedAt,
        refreshing: false,
      },
    },
    maintenance,
  };
  const backendDefault = {
    scope: "global",
    projectId: null,
    selection,
    updatedAt: checkedAt,
  };
  const promptPreset = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Review",
    body: "Review this patch.",
    route: null,
    position: 0,
    revision: 1,
    createdAt: checkedAt,
    updatedAt: checkedAt,
  };
  const snapshot = (overrides: Record<string, unknown> = {}): unknown => ({
    projects: [project],
    conversations: [],
    runs: [],
    providers: [provider],
    maintenanceOperations: [operation],
    backendDefaults: [backendDefault],
    settings: defaultSettings,
    activeProjectId: project.id,
    activeConversationId: null,
    ...overrides,
  });
  const run = {
    id: "run-1", kind: "agent",
    projectId: project.id, conversationId: conversation.id,
    actionId: null, label: "Agent run",
    detail: null, status: "running",
    attentionState: "unseen", canStop: true,
    port: null, startedAt: checkedAt,
    finishedAt: null,
  };
  const approval = {
    id: "approval-1",
    providerId: "codex",
    conversationId: conversation.id,
    runId: "run-1",
    turnId: "turn-1",
    kind: "command",
    title: "Run tests",
    detail: null,
    command: "npm test",
    cwd: "/workspace/boundary",
    reason: null,
    networkScope: { host: "example.test", protocol: "https" },
    permissionRoots: [{ path: "/workspace/boundary", access: "read" }],
    availableDecisions: ["approve", "deny", "cancel"],
  };
  const input = {
    id: "input-1",
    providerId: "codex",
    conversationId: conversation.id,
    runId: "run-1",
    turnId: "turn-1",
    autoResolutionMs: null,
    questions: [{
      id: "question-1",
      header: "Choice",
      question: "Continue?",
      isOther: false,
      isSecret: false,
      allowMultiple: false,
      options: [{ id: "yes", label: "Yes", description: "Continue." }],
    }],
  };
  const workflow = {
    conversationId: conversation.id,
    goals: conversationDetail.goals,
    goalCapability: {
      kind: "inertia-local",
      available: true,
      label: "Inertia local goal",
      reason: "Local fallback.",
    },
    skills: [{
      id: "skill-1",
      conversationId: conversation.id,
      name: "review",
      description: "Review changes.",
      shortDescription: null,
      scope: "repo",
      enabled: true,
      source: "codex-native",
    }],
    skillsCapability: {
      kind: "codex-native",
      available: true,
      label: "Codex skills",
    },
    goalRefreshWarning: null,
    skillDiscovery: { truncated: false, warningCount: 0, synchronizedAt: checkedAt },
    refreshedAt: checkedAt,
  };
  it("accepts representative canonical snapshot and live projections", () => {
    expect(parseServerEvent({ type: "snapshot.updated", snapshot: snapshot() })).toBeTruthy();
    expect(parseServerEvent({ type: "agent.approval.requested", request: approval })).toBeTruthy();
    expect(parseServerEvent({ type: "agent.input.requested", request: input })).toBeTruthy();
    expect(parseServerEvent(event({ kind: "agent.workflow", workflow }))).toBeTruthy();
    expect(parseServerEvent(event({
      kind: "agent.skills",
      conversationId: conversation.id,
      skills: workflow.skills,
      skillDiscovery: workflow.skillDiscovery,
    }))).toBeTruthy();
  });
  it.each([
    ["project status", { projects: [{ ...project, status: "paused" }] }],
    ["provider install state", { providers: [{ ...provider, installState: "missing" }] }],
    ["provider auth state", { providers: [{ ...provider, authState: "ready" }] }],
    ["provider metadata freshness", { providers: [{ ...provider, metadataState: {
      ...provider.metadataState,
      models: { ...provider.metadataState.models, freshness: "recent" },
    } }] }],
    ["provider metadata provenance", { providers: [{ ...provider, metadataState: {
      ...provider.metadataState,
      rateLimits: { ...provider.metadataState.rateLimits, provenance: "database" },
    } }] }],
    ["maintenance provider", { providers: [{ ...provider, maintenance: {
      ...maintenance, providerId: "claude",
    } }] }],
    ["maintenance status", { providers: [{ ...provider, maintenance: {
      ...maintenance, versionStatus: "outdated",
    } }] }],
    ["maintenance freshness", { providers: [{ ...provider, maintenance: {
      ...maintenance, freshness: "recent",
    } }] }],
    ["maintenance install method", { providers: [{ ...provider, maintenance: {
      ...maintenance, installMethod: "script",
    } }] }],
    ["maintenance availability", { providers: [{ ...provider, maintenance: {
      ...maintenance, updateAvailability: "maybe",
    } }] }],
    ["operation provider", { maintenanceOperations: [{ ...operation, providerId: "gemini" }] }],
    ["operation status", { maintenanceOperations: [{ ...operation, status: "paused" }] }],
    ["backend default scope", { backendDefaults: [{ ...backendDefault, scope: "workspace" }] }],
    ["backend default relationship", { backendDefaults: [{
      ...backendDefault, scope: "global", projectId: "11111111-1111-4111-8111-111111111111",
    }] }],
  ])("rejects malformed snapshot %s", (_label, overrides) => {
    expect(() => parseServerEvent({
      type: "snapshot.updated",
      snapshot: snapshot(overrides),
    })).toThrow("Malformed server event");
  });
  it.each([
    ["activity kind", "activities", { ...conversationDetail.activities[0], kind: "network" }],
    ["activity status", "activities", { ...conversationDetail.activities[0], status: "paused" }],
    ["subagent provider", "subagents", { ...conversationDetail.subagents[0], providerId: "gemini" }],
    ["subagent status", "subagents", { ...conversationDetail.subagents[0], status: "paused" }],
    ["turn interaction", "agentTurns", { ...conversationDetail.agentTurns[0], interactionMode: "chat" }],
    ["turn access", "agentTurns", { ...conversationDetail.agentTurns[0], accessMode: "unrestricted" }],
    ["turn route", "agentTurns", { ...conversationDetail.agentTurns[0], modelSelection: claudeSelection }],
    ["turn model", "agentTurns", { ...conversationDetail.agentTurns[0], model: "other-model" }], ["turn alias", "agentTurns", { ...conversationDetail.agentTurns[0], modelAlias: "other" }],
    ["turn reasoning", "agentTurns", { ...conversationDetail.agentTurns[0], reasoningEffort: "low" }], ["turn revision", "agentTurns", { ...conversationDetail.agentTurns[0], configurationRevision: 99 }],
    ["turn usage session binding", "agentTurns", {
      ...conversationDetail.agentTurns[0],
      usageAtStart: {
        usedTokens: 10,
        totalProcessedTokens: 10,
        totalProcessedScope: "thread",
        maxTokens: 100,
        inputTokens: 8,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 2,
        reasoningOutputTokens: 0,
        compactsAutomatically: false,
        providerSessionBound: "yes",
        capturedAt: conversation.updatedAt,
      },
    }],
    ["turn user message", "agentTurns", { ...conversationDetail.agentTurns[0], userMessageId: "missing-message" }], ["turn terminal message", "agentTurns", { ...conversationDetail.agentTurns[0], terminalAssistantMessageId: "missing-message" }], ["turn terminal role", "agentTurns", { ...conversationDetail.agentTurns[0], terminalAssistantMessageId: "message-1" }], ["turn checkpoint", "agentTurns", { ...conversationDetail.agentTurns[0], checkpointId: "missing-checkpoint" }],
    ["user message role", "messages", { ...conversationDetail.messages[0], role: "assistant" }], ["user message turn", "messages", { ...conversationDetail.messages[0], turnId: "other-turn" }], ["checkpoint turn", "checkpoints", { ...conversationDetail.checkpoints[0], turnId: "other-turn" }],
    ["artifact turn", "turnGitArtifacts", { ...conversationDetail.turnGitArtifacts[0], turnId: "missing-turn" }], ["artifact run", "turnGitArtifacts", { ...conversationDetail.turnGitArtifacts[0], runId: "other-run" }],
    ["activity run", "activities", { ...conversationDetail.activities[0], runId: "other-run" }], ["subagent run", "subagents", { ...conversationDetail.subagents[0], runId: "other-run" }], ["reasoning run", "reasonings", { ...conversationDetail.reasonings[0], runId: "other-run" }], ["plan run", "plans", { ...conversationDetail.plans[0], runId: "other-run" }],
    ["attachment MIME", "messages", { ...conversationDetail.messages[0], attachments: [{
      id: "attachment-1", name: "x.exe", path: "/tmp/x.exe", mimeType: "application/x-msdownload", size: 1,
    }] }],
  ])("rejects malformed detail %s", (_label, collection, value) => {
    expect(() => parseServerEvent(event({
      kind: "conversation.detail",
      conversationId: conversation.id,
      state: "ready",
      detail: { ...conversationDetail, [collection]: [value] },
    }))).toThrow("Malformed server event");
  });
  it.each([
    ["turn", "agentTurns", conversationDetail.agentTurns[0], undefined], ["turn run", "agentTurns", conversationDetail.agentTurns[0], "turn-2"], ["Git artifact", "turnGitArtifacts", conversationDetail.turnGitArtifacts[0], undefined], ["artifact turn", "turnGitArtifacts", conversationDetail.turnGitArtifacts[0], "artifact-2"],
    ["message", "messages", conversationDetail.messages[0], undefined], ["activity", "activities", conversationDetail.activities[0], undefined],
    ["subagent", "subagents", conversationDetail.subagents[0], undefined], ["reasoning", "reasonings", conversationDetail.reasonings[0], undefined],
    ["checkpoint", "checkpoints", conversationDetail.checkpoints[0], undefined], ["review note", "reviewNotes", conversationDetail.reviewNotes[0], undefined],
    ["usage", "usage", conversationDetail.usage[0], undefined], ["plan run", "plans", conversationDetail.plans[0], undefined],
    ["goal source", "goals", conversationDetail.goals[0], undefined], ["review summary", "reviewSummaries", conversationDetail.reviewSummaries[0], undefined],
    ["review state key", "reviewStates", conversationDetail.reviewStates[0], undefined], ["subagent task identity", "subagents", { ...conversationDetail.subagents[0], providerTaskId: "task-1" }, "trace-2"], ["subagent agent identity", "subagents", { ...conversationDetail.subagents[0], providerAgentId: "agent-1" }, "trace-2"],
  ])("rejects duplicate detail %s identities", (_label, collection, entry, duplicateId) => {
    expect(() => parseServerEvent(event({
      kind: "conversation.detail", conversationId: conversation.id, state: "ready",
      detail: { ...conversationDetail, [collection]: [entry, { ...entry, id: duplicateId ?? ("id" in entry ? entry.id : undefined) }] },
    }))).toThrow("Malformed server event");
  });
  it.each([
    ["approval provider", { ...approval, providerId: "gemini" }],
    ["approval kind", { ...approval, kind: "network" }],
    ["approval protocol", { ...approval, networkScope: { host: "x", protocol: "ftp" } }],
    ["approval access", { ...approval, permissionRoots: [{ path: "/tmp", access: "execute" }] }],
  ])("rejects malformed %s", (_label, request) => {
    expect(() => parseServerEvent({
      type: "agent.approval.requested",
      request,
    })).toThrow("Malformed server event");
  });
  it("rejects malformed input and cleared-goal provider discriminants", () => {
    expect(parseServerEvent({
      type: "agent.goal.cleared",
      conversationId: conversation.id,
      source: "codex-native",
    })).toBeTruthy();
    expect(() => parseServerEvent({ type: "agent.input.requested", request: { ...input, providerId: "gemini" } })).toThrow("Malformed server event");
    expect(() => parseServerEvent({ type: "agent.input.requested", request: { ...input, questions: [input.questions[0], { ...input.questions[0] }] } })).toThrow("Malformed server event");
    expect(() => parseServerEvent({ type: "agent.input.requested", request: { ...input, questions: [{ ...input.questions[0], options: [input.questions[0].options[0], { ...input.questions[0].options[0] }] }] } })).toThrow("Malformed server event");
    expect(() => parseServerEvent({ type: "agent.goal.cleared", conversationId: conversation.id, source: "provider-native" })).toThrow("Malformed server event");
  });
  it("requires sequenced scope and shell run identities to match their payload", () => {
    const textEvent = {
      type: "agent.text",
      conversationId: conversation.id,
      runId: "run-1",
      turnId: "turn-1",
      text: "Working",
    };
    const frame = (scope: unknown, mutation: unknown): unknown => ({
      type: "runtime.event",
      sync: { runtimeGeneration: "runtime-1", latestSequence: 1 },
      scope,
      event: mutation,
    });
    expect(parseServerEvent(frame({
      kind: "conversation-detail", conversationId: conversation.id,
    }, textEvent))).toBeTruthy();
    expect(() => parseServerEvent(frame({
      kind: "conversation-detail", conversationId: "conversation-2",
    }, textEvent))).toThrow("Malformed server event");
    expect(() => parseServerEvent(frame({ kind: "shell" }, textEvent)))
      .toThrow("Malformed server event");
    expect(() => parseServerEvent({
      type: "conversation.shell.updated",
      conversation: conversationShell,
      runs: [{ ...run, conversationId: "conversation-2" }],
    })).toThrow("Malformed server event");
    expect(() => parseServerEvent({
      type: "conversation.shell.updated",
      conversation: conversationShell,
      runs: [{ ...run, projectId: "project-2" }],
    })).toThrow("Malformed server event");
    expect(parseServerEvent(frame({ kind: "shell" }, {
      type: "conversation.shell.updated",
      conversation: conversationShell,
      runs: [run],
    }))).toBeTruthy();
  });
  it("binds snapshot conversation runs while preserving project-scoped runs", () => {
    const parseSnapshot = (runs: unknown[]): unknown => parseServerEvent({
      type: "snapshot.updated",
      snapshot: snapshot({ conversations: [conversationShell], runs }),
    });
    expect(parseSnapshot([{ ...run, conversationId: null }])).toBeTruthy();
    expect(() => parseSnapshot([{ ...run, conversationId: "missing" }]))
      .toThrow("Malformed server event");
    expect(() => parseSnapshot([{ ...run, projectId: "project-2" }])).toThrow("Malformed server event");
    expect(parseServerEvent({ type: "snapshot.updated", snapshot: snapshot({ conversations: [conversationShell], activeConversationId: conversation.id }) })).toBeTruthy();
    expect(() => parseServerEvent({ type: "snapshot.updated", snapshot: snapshot({ projects: [project, { ...project }] }) })).toThrow("Malformed server event");
    expect(() => parseServerEvent({ type: "snapshot.updated", snapshot: snapshot({ projects: [project, { ...project, id: "project-2" }], conversations: [conversationShell, { ...conversationShell, projectId: "project-2" }] }) })).toThrow("Malformed server event");
    const invalidCollections = [
      { conversations: [{ ...conversationShell, projectId: "missing" }] }, { runs: [{ ...run, conversationId: null, projectId: "missing" }] },
      { providers: [provider, { ...provider }] }, { runs: [run, { ...run }] }, { backendProfiles: [backendProfile, { ...backendProfile }] },
      { maintenanceOperations: [operation, { ...operation }] }, { backendDefaults: [backendDefault, { ...backendDefault }] },
      { backendDefaults: [{ ...backendDefault, scope: "project", projectId: "22222222-2222-4222-8222-222222222222" }] },
    ];
    for (const invalid of invalidCollections) expect(() => parseServerEvent({ type: "snapshot.updated", snapshot: snapshot(invalid) })).toThrow("Malformed server event");
    const invalidActiveStates = [
      { activeProjectId: "missing" }, { activeConversationId: "missing" },
      { projects: [project, { ...project, id: "project-2" }], conversations: [conversationShell], activeProjectId: "project-2", activeConversationId: conversation.id },
    ];
    for (const active of invalidActiveStates) expect(() => parseServerEvent({ type: "snapshot.updated", snapshot: snapshot(active) })).toThrow("Malformed server event");
  });
  it("accepts only ordered, unique, structurally safe prompt presets", () => {
    const parsePresets = (promptPresets: unknown[]): unknown => parseServerEvent({
      type: "snapshot.updated",
      snapshot: snapshot({ promptPresets }),
    });
    expect(parsePresets([promptPreset])).toBeTruthy();
    expect(() => parsePresets([
      promptPreset,
      { ...promptPreset, position: 1 },
    ])).toThrow("Malformed server event");
    expect(() => parsePresets([{ ...promptPreset, position: 1 }]))
      .toThrow("Malformed server event");
    expect(() => parsePresets([{
      ...promptPreset,
      filesystemPath: "/private/context.txt",
    }])).toThrow("Malformed server event");
  });
  it("rejects mismatched and duplicate event-local identities", () => {
    const skill = workflow.skills[0]; const attachment = conversationDetail.messages[0].attachments[0];
    const duplicateEvents = [
      { type: "conversation.shell.updated", conversation: conversationShell, runs: [run, { ...run }] },
      { type: "conversation.message.persisted", message: { ...conversationDetail.messages[0], attachments: [attachment, { ...attachment }] } },
      { type: "provider.maintenance.updated", providers: [maintenance, { ...maintenance }] },
      event({ kind: "provider.maintenance", providers: [maintenance, { ...maintenance }] }),
      event({ kind: "project.actions", actions: [{ id: "test", label: "Test", command: "npm test", preview: false }, { id: "test", label: "Duplicate", command: "npm test", preview: false }] }),
      event({ kind: "agent.workflow", workflow: { ...workflow, skills: [skill, { ...skill }] } }), event({ kind: "agent.workflow", workflow: { ...workflow, goals: [workflow.goals[0], { ...workflow.goals[0] }] } }), event({ kind: "agent.skills", conversationId: conversation.id, skills: [skill, { ...skill }], skillDiscovery: workflow.skillDiscovery }),
      event({ kind: "duo.pending", launchIds: ["launch-1", "launch-1"], hasMore: false }),
    ];
    for (const malformed of duplicateEvents) expect(() => parseServerEvent(malformed)).toThrow("Malformed server event");
    expect(() => parseServerEvent(event({ kind: "agent.workflow", workflow: { ...workflow, goals: [{ ...workflow.goals[0], conversationId: "conversation-2" }] } }))).toThrow("Malformed server event");
    expect(() => parseServerEvent(event({ kind: "agent.skills", conversationId: conversation.id, skills: [{ ...skill, conversationId: "conversation-2" }], skillDiscovery: workflow.skillDiscovery }))).toThrow("Malformed server event");
  });
});
