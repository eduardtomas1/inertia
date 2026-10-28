import { describe, expect, it } from "vitest";

import { detachedChatWindowTitle } from "../src/shared/desktop-window-title";
import {
  parseAttachmentPickerMode,
  parseDetachedChatDraftAcknowledgement,
  parseDetachedChatDraftHandoff,
  parseDetachedChatTerminalHandoff,
  parseDetachedChatWindowOpenRequest,
  parseDetachedChatWindowRequest,
  parseMainWindowTarget,
  parseOpenProjectPathRequest,
  parsePendingDetachedChatDraft,
  parsePrivateConnectDeviceUpdateRequest,
  parsePrivateConnectPairingApprovalRequest,
  parseTerminalHandoffIds,
} from "../src/shared/desktop";
import {
  BACKEND_CREDENTIAL_MASK,
  parseBackendCredentialProfileRequest,
  parseSetBackendCredentialRequest,
} from "../src/shared/backend-credentials";

const projectId = "11111111-1111-4111-8111-111111111111";
const conversationId = "22222222-2222-4222-8222-222222222222";
const handoffId = "33333333-3333-4333-8333-333333333333";
const terminalIds = [
  "44444444-4444-4444-8444-444444444441",
  "44444444-4444-4444-8444-444444444442",
  "44444444-4444-4444-8444-444444444443",
  "44444444-4444-4444-8444-444444444444",
];

describe("desktop detached-chat contract", () => {
  it.each([
    ["First line\nSecond line\r\nThird", "First line Second line Third"],
    ["\0\r\n ", "Untitled chat"],
    ["🌍".repeat(64), "🌍".repeat(60)],
    ["x".repeat(119) + "🌍", "x".repeat(119)],
    ["Ordinary chat", "Ordinary chat"],
  ])("opens and retitles chats whose stored title is %j", (stored, expected) => {
    const title = detachedChatWindowTitle(stored);
    expect(title).toBe(expected);
    const request = { conversationId, title };
    expect(parseDetachedChatWindowRequest(request)).toEqual(request);
    expect(parseDetachedChatWindowOpenRequest({ ...request, draft: "Pending\nmessage", terminalIds: [] }))
      .toEqual({ ...request, draft: "Pending\nmessage", terminalIds: [] });
  });

  it("accepts one exact conversation identity and a bounded display title", () => {
    expect(parseDetachedChatWindowRequest({
      conversationId,
      title: "  Keep the runtime running  ",
    })).toEqual({
      conversationId,
      title: "Keep the runtime running",
    });
    for (const request of [
      { conversationId: "not-a-uuid", title: "Chat" },
      { conversationId, title: "" },
      { conversationId, title: "line one\nline two" },
      { conversationId, title: "x".repeat(121) },
      { conversationId, title: "Chat", activate: true },
    ]) {
      expect(parseDetachedChatWindowRequest(request)).toBeNull();
    }
  });

  it("accepts only bounded drafts bound to an exact detached conversation", () => {
    const open = {
      conversationId,
      title: "Keep the runtime running",
      draft: "Exact pending text",
      terminalIds: [],
    };
    expect(parseDetachedChatWindowOpenRequest(open)).toEqual(open);
    expect(parseDetachedChatDraftHandoff({
      conversationId,
      draft: open.draft,
    })).toEqual({ conversationId, draft: open.draft });

    for (const value of [
      { ...open, draft: "x".repeat(20_001) },
      { ...open, draft: 42 },
      { ...open, extra: true },
    ]) {
      expect(parseDetachedChatWindowOpenRequest(value)).toBeNull();
    }
    expect(parseDetachedChatDraftHandoff({
      conversationId: "not-a-uuid",
      draft: open.draft,
    })).toBeNull();
  });

  it("hands over at most four distinct terminal identities with a window", () => {
    expect(parseTerminalHandoffIds([])).toEqual([]);
    expect(parseTerminalHandoffIds(terminalIds)).toEqual(terminalIds);
    const open = { conversationId, title: "Chat", draft: "", terminalIds };
    expect(parseDetachedChatWindowOpenRequest(open)).toEqual(open);
    expect(parseDetachedChatWindowOpenRequest({ ...open, terminalIds: [] }))
      .toEqual({ ...open, terminalIds: [] });

    const invalidIds: unknown[] = [
      [...terminalIds, "44444444-4444-4444-8444-444444444445"],
      [terminalIds[0], terminalIds[0]],
      ["not-a-uuid"],
      [42],
      [null],
      "44444444-4444-4444-8444-444444444441",
      { 0: terminalIds[0], length: 1 },
      undefined,
    ];
    for (const value of invalidIds) {
      expect(parseTerminalHandoffIds(value)).toBeNull();
      expect(parseDetachedChatWindowOpenRequest({ ...open, terminalIds: value })).toBeNull();
    }
    const { terminalIds: _omitted, ...missing } = open;
    expect(parseDetachedChatWindowOpenRequest(missing)).toBeNull();
    expect(parseDetachedChatWindowOpenRequest({ ...missing, extra: [] })).toBeNull();
    expect(parseDetachedChatWindowOpenRequest({ ...open, extra: true })).toBeNull();

    const handoff = { conversationId, terminalIds, dock: true };
    expect(parseDetachedChatTerminalHandoff(handoff)).toEqual(handoff);
    for (const value of [
      { conversationId, terminalIds },
      { ...handoff, extra: true },
      { ...handoff, dock: 1 },
      { ...handoff, conversationId: "not-a-uuid" },
      { ...handoff, terminalIds: [terminalIds[0], terminalIds[0]] },
    ]) {
      expect(parseDetachedChatTerminalHandoff(value)).toBeNull();
    }
  });

  it("accepts only exact pending handoffs and acknowledgements", () => {
    const pending = {
      conversationId,
      draft: "Latest pending text",
      handoffId,
    };
    expect(parsePendingDetachedChatDraft(pending)).toEqual(pending);
    expect(parseDetachedChatDraftAcknowledgement({
      conversationId,
      handoffId,
    })).toEqual({ conversationId, handoffId });

    for (const value of [
      { ...pending, injected: true },
      { ...pending, conversationId: "not-a-uuid" },
      { ...pending, handoffId: "not-a-uuid" },
      { ...pending, draft: "x".repeat(20_001) },
    ]) {
      expect(parsePendingDetachedChatDraft(value)).toBeNull();
    }
    for (const value of [
      { conversationId, handoffId, injected: true },
      { conversationId: "not-a-uuid", handoffId },
      { conversationId, handoffId: "not-a-uuid" },
      { conversationId, handoffId: 42 },
    ]) {
      expect(parseDetachedChatDraftAcknowledgement(value)).toBeNull();
    }
  });
});

describe("desktop main-window target contract", () => {
  const turnId = "44444444-4444-4444-8444-444444444444";
  const incidentId = "55555555-5555-4555-8555-555555555555";

  it.each([
    { kind: "conversation", conversationId },
    { kind: "new-chat", projectId },
    { kind: "new-chat", projectId, checkout: { kind: "branch", branch: "feature/detached-chat" } },
    { kind: "new-chat", projectId, checkout: { kind: "this-worktree" } },
    { kind: "new-chat", projectId, checkout: { kind: "this-worktree", branch: "cwp/handoff" } },
    { kind: "new-chat", projectId, checkout: { kind: "isolated-worktree" } },
    { kind: "settings", page: "appearance" },
    { kind: "settings", page: "agents" },
    { kind: "settings", page: "help" },
    { kind: "provider-setup", providerId: "codex" },
    { kind: "provider-setup", providerId: "claude", method: "console" },
    { kind: "provider-setup", providerId: "antigravity", method: "account" },
    { kind: "backend-setup" },
    { kind: "backend-setup", profileId: "local-ollama" },
    { kind: "backend-setup", profileId: "openrouter:main", panel: "models" },
    { kind: "diagnostics" },
    { kind: "diagnostics", turnId },
    { kind: "diagnostics", incidentId },
    { kind: "diagnostics", incidentId, turnId },
    { kind: "usage-limits" },
  ])("accepts the exact target %j", (target) => {
    const parsed = parseMainWindowTarget(target);
    expect(parsed).toEqual(target);
    expect(parsed).not.toBe(target);
  });

  it.each([
    ["no object", null],
    ["an array", [{ kind: "usage-limits" }]],
    ["an unknown kind", { kind: "browser" }],
    ["a missing kind", { conversationId }],
    ["an extra key", { kind: "usage-limits", url: "https://example.com/" }],
    ["an inherited kind", Object.create({ kind: "usage-limits" })],
    ["a malformed conversation", { kind: "conversation", conversationId: "../other" }],
    ["a missing conversation", { kind: "conversation" }],
    ["a malformed project", { kind: "new-chat", projectId: "project" }],
    ["an undefined checkout", { kind: "new-chat", projectId, checkout: undefined }],
    ["an unknown checkout", { kind: "new-chat", projectId, checkout: { kind: "path", path: "/tmp" } }],
    ["a checkout path", { kind: "new-chat", projectId, checkout: { kind: "this-worktree", path: "/tmp" } }],
    ["an isolated worktree branch", { kind: "new-chat", projectId, checkout: { kind: "isolated-worktree", branch: "main" } }],
    ["an empty branch", { kind: "new-chat", projectId, checkout: { kind: "branch", branch: "" } }],
    ["a padded branch", { kind: "new-chat", projectId, checkout: { kind: "branch", branch: " main" } }],
    ["a branch with a newline", { kind: "new-chat", projectId, checkout: { kind: "branch", branch: "main\nother" } }],
    ["a branch with a null byte", { kind: "new-chat", projectId, checkout: { kind: "this-worktree", branch: "main\0" } }],
    ["an over-long branch", { kind: "new-chat", projectId, checkout: { kind: "branch", branch: "b".repeat(256) } }],
    ["a missing branch", { kind: "new-chat", projectId, checkout: { kind: "branch" } }],
    ["an unknown settings page", { kind: "settings", page: "secrets" }],
    ["a legacy settings page", { kind: "settings", page: "diagnostics" }],
    ["a settings anchor", { kind: "settings", page: "agents", anchor: "model-backends" }],
    ["an unknown provider", { kind: "provider-setup", providerId: "gemini" }],
    ["an inherited provider", { kind: "provider-setup", providerId: "toString" }],
    ["an unknown sign-in method", { kind: "provider-setup", providerId: "claude", method: "token" }],
    ["an unsupported sign-in method", { kind: "provider-setup", providerId: "codex", method: "console" }],
    ["a malformed backend profile", { kind: "backend-setup", profileId: "../profile" }],
    ["an over-long backend profile", { kind: "backend-setup", profileId: "p".repeat(201) }],
    ["a backend panel without a profile", { kind: "backend-setup", panel: "key" }],
    ["an unknown backend panel", { kind: "backend-setup", profileId: "local", panel: "secret" }],
    ["a malformed diagnostics turn", { kind: "diagnostics", turnId: "turn-1" }],
    ["a malformed diagnostics incident", { kind: "diagnostics", incidentId: "incident-1" }],
    ["a diagnostics request", { kind: "diagnostics", requestId: turnId }],
    ["usage limits with a provider", { kind: "usage-limits", providerId: "codex" }],
  ])("rejects %s", (_name, target) => {
    expect(parseMainWindowTarget(target)).toBeNull();
  });
});

describe("desktop project-path contract", () => {
  it("accepts only scoped relative paths and enumerated OS actions", () => {
    const request = {
      projectId,
      conversationId,
      relativePath: "src/index.ts",
      action: "open-externally",
    };
    expect(parseOpenProjectPathRequest(request)).toEqual(request);
    expect(parseOpenProjectPathRequest({
      projectId,
      relativePath: ".",
      action: "reveal",
    })).toEqual({
      projectId,
      relativePath: ".",
      action: "reveal",
    });
    for (const relativePath of ["../secret", "src/../../secret", "/etc/passwd", "C:\\Windows\\system.ini", "C:system.ini", "src/\0secret"]) {
      expect(parseOpenProjectPathRequest({ ...request, relativePath })).toBeNull();
    }
    expect(parseOpenProjectPathRequest({ ...request, action: "open" })).toBeNull();
    expect(parseOpenProjectPathRequest({ ...request, absolutePath: "/tmp/renderer-controlled" })).toBeNull();
  });
});

describe("desktop attachment picker contract", () => {
  it("keeps image-only follow-up selection explicit and fail-closed", () => {
    expect(parseAttachmentPickerMode(undefined)).toBe("all");
    expect(parseAttachmentPickerMode("all")).toBe("all");
    expect(parseAttachmentPickerMode("images")).toBe("images");
    for (const value of [null, "documents", { mode: "images" }, ["images"]]) {
      expect(parseAttachmentPickerMode(value)).toBeNull();
    }
  });
});

describe("desktop credential contract", () => {
  it("accepts explicit set and profile requests without accepting masked round trips", () => {
    expect(parseSetBackendCredentialRequest({
      profileId: "kimi",
      secret: "fresh-secret",
    })).toEqual({
      profileId: "kimi",
      secret: "fresh-secret",
    });
    expect(parseSetBackendCredentialRequest({
      profileId: "kimi",
      secret: BACKEND_CREDENTIAL_MASK,
    })).toBeNull();
    expect(parseSetBackendCredentialRequest({
      profileId: "kimi",
      secret: "line-one\nline-two",
    })).toBeNull();
    expect(parseBackendCredentialProfileRequest({ profileId: "kimi" }))
      .toEqual({ profileId: "kimi" });
    expect(parseBackendCredentialProfileRequest({
      profileId: "kimi",
      secret: "must-not-be-accepted",
    })).toBeNull();
  });
});

describe("desktop Private Connect contract", () => {
  it("rejects unknown pairing and device fields", () => {
    const deviceUpdate = {
      deviceId: projectId,
      preset: "monitor",
      projectIds: [projectId],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    expect(parsePrivateConnectDeviceUpdateRequest(deviceUpdate)).toEqual(deviceUpdate);
    expect(parsePrivateConnectDeviceUpdateRequest({
      ...deviceUpdate,
      injected: true,
    })).toBeNull();

    const pairing = {
      requestId: conversationId,
      preset: "monitor",
      projectIds: [projectId],
      grantDays: 1,
    };
    expect(parsePrivateConnectPairingApprovalRequest(pairing)).toEqual(pairing);
    expect(parsePrivateConnectPairingApprovalRequest({
      ...pairing,
      injected: true,
    })).toBeNull();
  });

  it("rejects sparse conversation grants at the preload boundary", () => {
    const sparseConversationIds: string[] = [];
    sparseConversationIds.length = 1;
    expect(parsePrivateConnectDeviceUpdateRequest({
      deviceId: projectId,
      preset: "monitor",
      projectIds: [projectId],
      grants: [{
        projectId,
        conversationIds: sparseConversationIds,
        includeFutureConversations: false,
      }],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })).toBeNull();
  });
});
