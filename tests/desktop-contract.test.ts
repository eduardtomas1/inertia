import { describe, expect, it } from "vitest";

import {
  parseAttachmentPickerMode,
  parseOpenProjectPathRequest,
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
