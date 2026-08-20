import { describe, expect, it } from "vitest";

import {
  parseAttachmentPickerMode,
  parseDetachedChatDraftAcknowledgement,
  parseDetachedChatDraftHandoff,
  parseDetachedChatWindowOpenRequest,
  parseDetachedChatWindowRequest,
  parseOpenProjectPathRequest,
  parsePendingDetachedChatDraft,
  parsePrivateConnectDeviceUpdateRequest,
  parsePrivateConnectPairingApprovalRequest,
} from "../src/shared/desktop";
import {
  BACKEND_CREDENTIAL_MASK,
  parseBackendCredentialProfileRequest,
  parseSetBackendCredentialRequest,
} from "../src/shared/backend-credentials";

const projectId = "11111111-1111-4111-8111-111111111111";
const conversationId = "22222222-2222-4222-8222-222222222222";
const handoffId = "33333333-3333-4333-8333-333333333333";

describe("desktop detached-chat contract", () => {
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
