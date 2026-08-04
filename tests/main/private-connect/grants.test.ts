import { describe, expect, it } from "vitest";

import {
  normalizePrivateConnectGrants,
  privateConnectGrantAllowsConversation,
  privateConnectGrantedProjectIds,
  privateConnectGrantsFromProjectIds,
} from "../../../src/shared/private-connect/grants";
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

  it("maps scopes to least-privilege presets", () => {
    expect(scopesForPreset("monitor")).toEqual(["private:read"]);
    expect(scopesForPreset("collaborate")).toHaveLength(4);
    expect(presetForScopes(["private:read"])).toBe("monitor");
    expect(presetForScopes(["private:stop"])).toBe("collaborate");
    expect(hasPrivateConnectScope(["private:read"], "private:prompt")).toBe(false);
    expect(hasPrivateConnectScope(scopesForPreset("collaborate"), "private:prompt")).toBe(true);
  });
});
