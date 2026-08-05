import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../../src/server/database";
import { PrivateConnectRuntimeGateway } from "../../../src/server/private-connect/runtime-gateway";
import {
  normalizePrivateConnectRuntimeGrants,
  privateConnectRuntimeGrantsFromProjectIds,
  privateConnectRuntimeGrantAllowsConversation,
  privateConnectRuntimeGrantsNeedReview,
  type PrivateConnectRuntimeGrant,
} from "../../../src/shared/private-connect/runtime-grants";
import type {
  PrivateConnectRuntimeAuthorization,
  PrivateConnectRuntimeResponse,
} from "../../../src/shared/private-connect/runtime-contract";
import {
  privateConnectPromptSafetyForHarness,
} from "../../../src/shared/private-connect/prompt-safety";
import { removeTemporaryDirectory } from "../../helpers/temporary-directory";

const temporaryDirectories: string[] = [];
const stores: RuntimeStore[] = [];
const REQUEST_ID = "6bbd21ad-3f1a-4e6f-8a86-2e3f0c3f5c11";
const PROMPT_REQUEST_ID = "4d1b6f8c-59a1-4c62-9a17-2f1c8b3d5e01";
const DELIVERY_ID = "2f7c0a9e-1b3d-4e5f-8a6b-7c8d9e0f1a2b";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "inertia-private-connect-scope-"));
  temporaryDirectories.push(directory);
  const store = new RuntimeStore(join(directory, "inertia.sqlite"), directory);
  stores.push(store);
  const project = store.createProject("Granted project", directory);
  const other = store.createProject("Other project", directory);
  const granted = store.createConversation(project.id, "Granted conversation");
  const sibling = store.createConversation(project.id, "Sibling conversation");
  const gateway = new PrivateConnectRuntimeGateway({
    shell: () => store.shellSnapshot(),
    detail: (conversationId) => store.conversationDetail(conversationId),
    isConversationActive: () => false,
    preparePrompt: async () => undefined,
    queuePrompt: () => ({ turnId: "private-connect-turn" }),
    privateConnectPromptSafety: () => privateConnectPromptSafetyForHarness("codex-app-server"),
    now: () => new Date("2030-01-01T00:00:00.000Z"),
  });
  const subject = (
    grants: PrivateConnectRuntimeGrant[],
    scopes: PrivateConnectRuntimeAuthorization["scopes"] = ["view", "prompt"],
  ): PrivateConnectRuntimeAuthorization => ({
    deviceId: "09400fa3-32c0-4d8d-8d17-e8ea0a4f6937",
    sessionId: "7f0c11aa-9ee8-4e3c-8f8f-0907e31b389e",
    scopes,
    projectIds: [...new Set(grants.map(({ projectId }) => projectId))].sort(),
    grants: normalizePrivateConnectRuntimeGrants(grants),
    grantVersion: 1,
    expiresAt: "2030-02-01T00:00:00.000Z",
  });
  const explicit = (
    projectId: string,
    conversationIds: string[],
  ): PrivateConnectRuntimeGrant => ({
    projectId,
    conversationIds,
    includeFutureConversations: false,
    legacyProjectWide: false,
  });
  return { store, gateway, project, other, granted, sibling, subject, explicit };
}

async function visibleConversations(
  gateway: PrivateConnectRuntimeGateway,
  subject: PrivateConnectRuntimeAuthorization,
): Promise<string[]> {
  const response = await gateway.request(subject, {
    type: "state.get",
    requestId: REQUEST_ID,
  });
  if (!response.ok || response.result.kind !== "state") return [];
  return response.result.state.conversations.map(({ id }) => id).sort();
}

async function fetchConversation(
  gateway: PrivateConnectRuntimeGateway,
  subject: PrivateConnectRuntimeAuthorization,
  conversationId: string,
): Promise<PrivateConnectRuntimeResponse> {
  return await gateway.request(subject, {
    type: "conversation.get",
    requestId: REQUEST_ID,
    conversationId,
  });
}

async function sendPrompt(
  gateway: PrivateConnectRuntimeGateway,
  subject: PrivateConnectRuntimeAuthorization,
  conversationId: string,
): Promise<PrivateConnectRuntimeResponse> {
  const prepared = await gateway.preparePrompt(subject, {
    type: "prompt.send",
    requestId: PROMPT_REQUEST_ID,
    deliveryId: DELIVERY_ID,
    conversationId,
    content: "hello",
  });
  if (!("preparationId" in prepared)) return prepared;
  return gateway.commitPrompt(subject, {
    type: "prompt.send",
    requestId: PROMPT_REQUEST_ID,
    deliveryId: DELIVERY_ID,
    conversationId,
    content: "hello",
  }, prepared.preparationId);
}

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of temporaryDirectories.splice(0)) {
    await removeTemporaryDirectory(directory);
  }
});
describe("Private Connect conversation-scoped authority", () => {
  it("exposes only the granted conversation from its project", async () => {
    const f = fixture();
    const subject = f.subject([f.explicit(f.project.id, [f.granted.id])]);
    expect(await visibleConversations(f.gateway, subject)).toEqual([
      f.granted.id,
    ]);
  });

  it("hides another conversation in the same project", async () => {
    const f = fixture();
    const subject = f.subject([f.explicit(f.project.id, [f.granted.id])]);
    const response = await fetchConversation(f.gateway, subject, f.sibling.id);
    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.code).toBe("not-found");
  });

  it("hides conversations created after the grant", async () => {
    const f = fixture();
    const subject = f.subject([f.explicit(f.project.id, [f.granted.id])]);
    const fresh = f.store.createConversation(f.project.id, "Created later");
    expect(await visibleConversations(f.gateway, subject)).toEqual([
      f.granted.id,
    ]);
    const response = await fetchConversation(f.gateway, subject, fresh.id);
    expect(response.ok).toBe(false);
  });

  it("exposes future conversations only when explicitly opted in", async () => {
    const f = fixture();
    const subject = f.subject([{
      projectId: f.project.id,
      conversationIds: [],
      includeFutureConversations: true,
      legacyProjectWide: false,
    }]);
    const fresh = f.store.createConversation(f.project.id, "Created later");
    expect(await visibleConversations(f.gateway, subject)).toEqual(
      [f.granted.id, f.sibling.id, fresh.id].sort(),
    );
  });

  it("stops exposing a revoked conversation immediately", async () => {
    const f = fixture();
    const granted = f.subject([
      f.explicit(f.project.id, [f.granted.id, f.sibling.id]),
    ]);
    expect(await visibleConversations(f.gateway, granted)).toEqual(
      [f.granted.id, f.sibling.id].sort(),
    );
    const narrowed = f.subject([f.explicit(f.project.id, [f.granted.id])]);
    expect(await visibleConversations(f.gateway, narrowed)).toEqual([
      f.granted.id,
    ]);
    const response = await fetchConversation(f.gateway, narrowed, f.sibling.id);
    expect(response.ok).toBe(false);
  });

  it("returns grant-bound validators and compact unchanged projections", async () => {
    const f = fixture();
    const subject = f.subject([f.explicit(f.project.id, [f.granted.id])]);
    const first = await f.gateway.request(subject, {
      type: "state.get",
      requestId: REQUEST_ID,
      ifNoneMatch: null,
    });
    expect(first).toMatchObject({
      ok: true,
      result: { kind: "state", validator: expect.any(String) },
    });
    if (!first.ok || first.result.kind !== "state" || !first.result.validator) {
      throw new Error("Private Connect did not issue a state validator");
    }

    const unchanged = await f.gateway.request(subject, {
      type: "state.get",
      requestId: REQUEST_ID,
      ifNoneMatch: first.result.validator,
    });
    expect(unchanged).toMatchObject({
      ok: true,
      result: {
        kind: "not-modified",
        validator: first.result.validator,
        resource: { kind: "state" },
      },
    });

    const changedAuthority = await f.gateway.request({
      ...subject,
      grantVersion: subject.grantVersion + 1,
    }, {
      type: "state.get",
      requestId: REQUEST_ID,
      ifNoneMatch: first.result.validator,
    });
    expect(changedAuthority).toMatchObject({
      ok: true,
      result: { kind: "state", validator: expect.any(String) },
    });
    if (changedAuthority.ok && changedAuthority.result.kind === "state") {
      expect(changedAuthority.result.validator).not.toBe(first.result.validator);
    }
  });

  it("removes access when the conversation is archived", async () => {
    const f = fixture();
    const subject = f.subject([f.explicit(f.project.id, [f.granted.id])]);
    f.store.archiveConversation(f.granted.id, true);
    expect(await visibleConversations(f.gateway, subject)).toEqual([]);
    const response = await fetchConversation(f.gateway, subject, f.granted.id);
    expect(response.ok).toBe(false);
  });

  it("removes access when the conversation is deleted", async () => {
    const f = fixture();
    const subject = f.subject([f.explicit(f.project.id, [f.granted.id])]);
    f.store.deleteConversation(f.granted.id);
    expect(await visibleConversations(f.gateway, subject)).toEqual([]);
    const response = await fetchConversation(f.gateway, subject, f.granted.id);
    expect(response.ok).toBe(false);
  });

  it("binds conversation authority to the project it was granted under", () => {
    const f = fixture();
    const grants = normalizePrivateConnectRuntimeGrants([
      f.explicit(f.project.id, [f.granted.id]),
      f.explicit(f.other.id, []),
    ]);
    expect(privateConnectRuntimeGrantAllowsConversation(
      grants,
      f.project.id,
      f.granted.id,
    )).toBe(true);
    expect(privateConnectRuntimeGrantAllowsConversation(
      grants,
      f.other.id,
      f.granted.id,
    )).toBe(false);
    expect(privateConnectRuntimeGrantAllowsConversation(
      grants,
      "never-granted-project",
      f.granted.id,
    )).toBe(false);
  });

  it("refuses prompts for an ungranted conversation", async () => {
    const f = fixture();
    const subject = f.subject([f.explicit(f.project.id, [f.granted.id])]);
    const response = await sendPrompt(f.gateway, subject, f.sibling.id);
    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.code).toBe("not-found");
  });

  it("refuses prompts once conversation authority is removed", async () => {
    const f = fixture();
    const granted = f.subject([f.explicit(f.project.id, [f.granted.id])]);
    const prepared = await f.gateway.preparePrompt(granted, {
      type: "prompt.send",
      requestId: PROMPT_REQUEST_ID,
      deliveryId: DELIVERY_ID,
      conversationId: f.granted.id,
      content: "hello",
    });
    expect("preparationId" in prepared).toBe(true);
    if (!("preparationId" in prepared)) return;

    const narrowed = f.subject([f.explicit(f.project.id, [])]);
    const committed = f.gateway.commitPrompt(narrowed, {
      type: "prompt.send",
      requestId: PROMPT_REQUEST_ID,
      deliveryId: DELIVERY_ID,
      conversationId: f.granted.id,
      content: "hello",
    }, prepared.preparationId);
    expect(committed.ok).toBe(false);
  });

  it("grants nothing for a project with no explicit conversations", async () => {
    const f = fixture();
    const subject = f.subject([f.explicit(f.project.id, [])]);
    expect(await visibleConversations(f.gateway, subject)).toEqual([]);
  });
});

describe("Private Connect grant migration", () => {
  it("migrates legacy project grants without narrowing or widening", () => {
    const grants = privateConnectRuntimeGrantsFromProjectIds([
      "project-b",
      "project-a",
    ]);
    expect(grants.map(({ projectId }) => projectId)).toEqual([
      "project-a",
      "project-b",
    ]);
    for (const grant of grants) {
      expect(grant.legacyProjectWide).toBe(true);
      expect(grant.includeFutureConversations).toBe(false);
      expect(grant.conversationIds).toEqual([]);
      expect(privateConnectRuntimeGrantAllowsConversation(
        grants,
        grant.projectId,
        "any-conversation",
      )).toBe(true);
    }
    expect(privateConnectRuntimeGrantsNeedReview(grants)).toBe(true);
  });

  it("does not reach conversations in projects that were never granted", () => {
    const grants = privateConnectRuntimeGrantsFromProjectIds(["project-a"]);
    expect(privateConnectRuntimeGrantAllowsConversation(grants, "project-b", "c")).toBe(false);
  });

  it("marks new explicit grants as needing no review", () => {
    const grants = normalizePrivateConnectRuntimeGrants([{
      projectId: "project-a",
      conversationIds: ["c1"],
      includeFutureConversations: false,
      legacyProjectWide: false,
    }]);
    expect(privateConnectRuntimeGrantsNeedReview(grants)).toBe(false);
    expect(privateConnectRuntimeGrantAllowsConversation(grants, "project-a", "c1")).toBe(true);
    expect(privateConnectRuntimeGrantAllowsConversation(grants, "project-a", "c2")).toBe(false);
  });

  it("bounds and de-duplicates conversation grants", () => {
    const grants = normalizePrivateConnectRuntimeGrants([
      {
        projectId: "project-a",
        conversationIds: ["c2", "c1", "c1"],
        includeFutureConversations: false,
        legacyProjectWide: false,
      },
      {
        projectId: "project-a",
        conversationIds: ["c3"],
        includeFutureConversations: false,
        legacyProjectWide: false,
      },
    ]);
    expect(grants).toHaveLength(1);
    expect(grants[0]?.conversationIds).toEqual(["c1", "c2", "c3"]);
  });

  it("ignores blank project and conversation identifiers", () => {
    expect(normalizePrivateConnectRuntimeGrants([{
      projectId: "   ",
      conversationIds: ["c1"],
      includeFutureConversations: true,
      legacyProjectWide: false,
    }])).toEqual([]);
    const grants = normalizePrivateConnectRuntimeGrants([{
      projectId: "project-a",
      conversationIds: ["  ", "c1"],
      includeFutureConversations: false,
      legacyProjectWide: false,
    }]);
    expect(grants[0]?.conversationIds).toEqual(["c1"]);
  });
});
