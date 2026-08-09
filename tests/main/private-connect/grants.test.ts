import { describe, expect, it } from "vitest";

import {
  PRIVATE_CONNECT_GRANT_LIMITS,
  normalizePrivateConnectGrants,
  privateConnectGrantAllowsConversation,
  privateConnectGrantedProjectIds,
  privateConnectGrantsForSelectedProjects,
  privateConnectGrantsFromProjectIds,
} from "../../../src/shared/private-connect/grants";
import {
  privateConnectRuntimeAuthorizationSchema,
} from "../../../src/shared/private-connect/runtime-contract";
import {
  normalizePrivateConnectRuntimeGrants,
  privateConnectRuntimeGrantAllowsConversation,
  privateConnectRuntimeGrantIsProjectWide,
  privateConnectRuntimeGrantsFromProjectIds,
  privateConnectRuntimeGrantsNeedReview,
  privateConnectRuntimeGrantedProjectIds,
  samePrivateConnectRuntimeGrants,
} from "../../../src/shared/private-connect/runtime-grants";
import {
  hasPrivateConnectScope,
  presetForScopes,
  scopesForPreset,
} from "../../../src/shared/private-connect/scopes";

describe("Private Connect grants and scopes", () => {
  it("normalizes project grants and authorizes only the intended conversations", () => {
    const grants = normalizePrivateConnectGrants([
      { projectId: " project ", conversationIds: ["a", "a", "  ", "b"], includeFutureConversations: false },
      { projectId: "project", conversationIds: ["c"], includeFutureConversations: true },
      { projectId: "other", conversationIds: [], includeFutureConversations: false },
    ]);
    expect(grants).toEqual([
      { projectId: "project", conversationIds: ["a", "b", "c"], includeFutureConversations: true },
      { projectId: "other", conversationIds: [], includeFutureConversations: false },
    ]);
    expect(privateConnectGrantedProjectIds(grants)).toEqual(["project", "other"]);
    expect(privateConnectGrantAllowsConversation(grants, "project", "future")).toBe(true);
    expect(privateConnectGrantAllowsConversation(grants, "missing", "future")).toBe(false);
    expect(privateConnectGrantsFromProjectIds(["b", "a", "b"])).toHaveLength(2);
    expect(privateConnectGrantsForSelectedProjects(["a", "b"], [
      { projectId: "outside", conversationIds: ["leaked"], includeFutureConversations: true },
      { projectId: "a", conversationIds: ["one"], includeFutureConversations: false },
    ])).toEqual([
      { projectId: "a", conversationIds: ["one"], includeFutureConversations: false },
      { projectId: "b", conversationIds: [], includeFutureConversations: true },
    ]);
  });

  it("keeps runtime grants deterministic and distinguishes legacy project-wide access", () => {
    const grants = normalizePrivateConnectRuntimeGrants([
      { projectId: "z", conversationIds: ["b", "a"], includeFutureConversations: false, legacyProjectWide: false },
      { projectId: "a", conversationIds: [], includeFutureConversations: false, legacyProjectWide: true },
      { projectId: "z", conversationIds: ["a"], includeFutureConversations: true, legacyProjectWide: false },
    ]);
    expect(grants.map(({ projectId }) => projectId)).toEqual(["a", "z"]);
    expect(privateConnectRuntimeGrantedProjectIds(grants)).toEqual(["a", "z"]);
    expect(privateConnectRuntimeGrantAllowsConversation(grants, "z", "future")).toBe(true);
    expect(privateConnectRuntimeGrantAllowsConversation(grants, "missing", "future")).toBe(false);
    expect(privateConnectRuntimeGrantIsProjectWide(grants, "a")).toBe(true);
    expect(privateConnectRuntimeGrantIsProjectWide(grants, "z")).toBe(true);
    expect(privateConnectRuntimeGrantsNeedReview(grants)).toBe(true);
    const legacy = privateConnectRuntimeGrantsFromProjectIds(["a"]);
    expect(samePrivateConnectRuntimeGrants(legacy, [...legacy])).toBe(true);
    expect(samePrivateConnectRuntimeGrants(legacy, [])).toBe(false);
    expect(samePrivateConnectRuntimeGrants(legacy, [{ ...legacy[0]!, projectId: "different" }])).toBe(false);
  });

  it("accepts the desktop grant limit across the runtime boundary", () => {
    const authorization = {
      deviceId: "11111111-1111-4111-8111-111111111111",
      sessionId: "22222222-2222-4222-8222-222222222222",
      scopes: ["view"],
      projectIds: ["project"],
      grants: [{
        projectId: "project",
        conversationIds: Array.from(
          {
            length:
              PRIVATE_CONNECT_GRANT_LIMITS.conversationsPerProject,
          },
          (_, index) => `conversation-${index}`,
        ),
        includeFutureConversations: false,
        legacyProjectWide: false,
      }],
      grantVersion: 1,
      expiresAt: "2030-01-01T00:00:00.000Z",
    };
    expect(
      privateConnectRuntimeAuthorizationSchema.safeParse(authorization)
        .success,
    ).toBe(true);
    authorization.grants[0]!.conversationIds.push("one-too-many");
    expect(
      privateConnectRuntimeAuthorizationSchema.safeParse(authorization)
        .success,
    ).toBe(false);
  });

  it("maps scopes to least-privilege presets", () => {
    expect(scopesForPreset("monitor")).toEqual(["private:read"]);
    expect(scopesForPreset("collaborate")).toHaveLength(4);
    expect(presetForScopes(["private:read"])).toBe("monitor");
    expect(presetForScopes(["private:stop"])).toBe("collaborate");
    expect(hasPrivateConnectScope(["private:read"], "private:prompt")).toBe(false);
    expect(hasPrivateConnectScope(scopesForPreset("collaborate"), "private:prompt")).toBe(true);
  });
});
