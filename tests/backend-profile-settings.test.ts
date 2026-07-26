import { describe, expect, it } from "vitest";

import {
  containsBackendCredentialMaterial,
  modelBackendProfileDetailSchema,
  modelBackendProfileViewSchema,
} from "../src/shared/backend-profile-settings";

const compatibility = {
  harnessId: "claude-agent-sdk",
  backendProfileId: "custom:team-gateway",
  backendProtocol: "anthropic-messages",
  state: "unknown",
  provenance: "unknown",
  allowsModelSwitchWithinSession: false,
  reasonCode: "probe-required",
  reason: "Test this endpoint before selecting it.",
} as const;

const view = {
  id: "custom:team-gateway",
  displayName: "Team gateway",
  harnessId: "claude-agent-sdk",
  protocol: "anthropic-messages",
  authenticationMode: "api-key",
  source: "custom",
  enabled: false,
  configurationRevision: 3,
  endpointIdentity: "endpoint:0123456789abcdef",
  preset: "custom",
  allowInsecureLocalhost: false,
  credentialGeneration: "vault-generation:3",
  models: [{
    id: "team-model",
    displayName: "Team model",
    contextWindowTokens: null,
    reasoningOptions: [],
    capabilities: [],
  }],
  routing: { mode: "simple", primaryModelId: "team-model" },
  capabilityHints: [],
  createdAt: "2026-07-25T08:00:00.000Z",
  updatedAt: "2026-07-25T08:00:00.000Z",
  endpointHost: "gateway.example.test",
  authState: "configured",
  connectionState: "not-tested",
  compatibility,
  latestProbe: null,
  canDelete: true,
  canDisable: true,
} as const;

describe("safe model backend settings contracts", () => {
  it("allows a vault generation marker without allowing credential material", () => {
    expect(containsBackendCredentialMaterial(view)).toBe(false);
    for (const unsafe of [
      { apiKey: "value" },
      { nested: { secretReference: "secret:opaque" } },
      { nested: [{ authorization: "Bearer value" }] },
      { credential_value: "value" },
      { refreshToken: "value" },
    ]) {
      expect(containsBackendCredentialMaterial(unsafe)).toBe(true);
    }
  });

  it("keeps full URLs out of shell views and permits them only in scoped detail", () => {
    expect(modelBackendProfileViewSchema.parse(view)).toEqual(view);
    expect(modelBackendProfileViewSchema.safeParse({
      ...view,
      baseUrl: "https://gateway.example.test/v1/messages",
    }).success).toBe(false);
    expect(modelBackendProfileDetailSchema.parse({
      ...view,
      baseUrl: "https://gateway.example.test/v1/messages",
    }).baseUrl).toBe("https://gateway.example.test/v1/messages");
  });
});
