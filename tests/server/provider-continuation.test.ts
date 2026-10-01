import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeStore } from "../../src/server/database";
import { createProviderContinuation } from "../../src/server/runtime/provider-continuation";
import { conversationCreatePayloadSchema } from "../../src/shared/contracts/client-command/conversation-create";
import { providerNativeModelSelection } from "../../src/shared/model-routing";

const roots: string[] = [];
const stores: RuntimeStore[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const route = { providerId: "claude" as const, selection: providerNativeModelSelection({ providerId: "claude", modelId: "provider-default" }) };
function fixture(worktree = false) {
  const root = mkdtempSync(join(tmpdir(), "inertia-continuation-"));
  roots.push(root);
  const workspace = join(root, "repository");
  mkdirSync(workspace);
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: workspace, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  writeFileSync(join(workspace, "README.md"), "Preserve this checkout\n");
  git("add", ".");
  git("-c", "user.name=Inertia", "-c", "user.email=test@inertia.local", "commit", "-qm", "Initial");
  const worktreePath = worktree ? join(root, "worktree") : null;
  if (worktreePath) git("worktree", "add", "-q", "-b", "feature", worktreePath);
  const store = new RuntimeStore(join(root, "db.sqlite"), workspace, { recoverInterruptedRuns: false });
  stores.push(store);
  const project = store.createProject("Project", workspace);
  const source = store.createConversation(project.id, "Implementation decisions", {
    providerId: "codex", branch: worktree ? "feature" : "main", worktreePath, activate: false,
  });
  const first = store.createMessage(source.id, "Keep retries idempotent.", "user", [], null, "2026-09-30T12:00:00.000Z");
  const second = store.createMessage(source.id, "Retry state is durable.", "assistant", [], null, "2026-09-30T12:01:00.000Z");
  store.updateConversation(source.id, { providerSessionId: "original-provider-session" });
  const payload = {
    projectId: project.id, title: "Continued conversation", draftConversationId: randomUUID(),
    providerId: route.providerId, modelSelection: { ...route.selection, capabilities: [...route.selection.capabilities] },
    accessMode: "supervised" as const, interactionMode: "plan" as const,
    continuation: { sourceConversationId: source.id, expectedUpdatedAt: store.conversation(source.id).updatedAt, sourceMessageIds: [first.id, second.id] },
  };
  return { store, source: store.conversation(source.id), payload, git, workspace };
}

describe("provider continuation", () => {
  it.each([false, true])("atomically carries selected context in the same checkout (worktree: %s), without a provider session or automatic send", async (worktree) => {
    const { store, source, payload } = fixture(worktree);
    const target = await createProviderContinuation(store, payload, route);
    expect(target).toMatchObject({ id: payload.draftConversationId, projectId: source.projectId,
      providerId: "claude", providerSessionId: null, continuationIdentity: null,
      branch: source.branch, worktreePath: source.worktreePath, accessMode: "supervised", interactionMode: "plan" });
    expect(store.conversationPath(target.id)).toBe(store.conversationPath(source.id));
    expect(store.conversation(source.id)).toEqual(source);
    const packets = store.contextPackets.list(target.id);
    expect(packets).toHaveLength(1);
    expect(packets[0]).toMatchObject({ sourceConversationId: source.id, targetConversationId: target.id, consumedMessageId: null, messageCount: 2, workspaceRelation: "same-workspace" });
    expect(store.contextPackets.preview(packets[0]!.id, target.id).excerpts.map(({ content }) => content)).toEqual(["Keep retries idempotent.", "Retry state is durable."]);
    expect(await createProviderContinuation(store, payload, route)).toMatchObject(target);
    await expect(createProviderContinuation(store, { ...payload, continuation: { ...payload.continuation, sourceMessageIds: payload.continuation.sourceMessageIds.slice(0, 1) } }, route)).rejects.toThrow("different settings");
    expect(store.contextPackets.list(target.id)).toHaveLength(1);
    expect(store.conversationWork.hasExclusiveCheckout(store.conversationPath(source.id))).toBe(false);
  });

  it("rolls back the destination when selected context cannot be created, then permits retry", async () => {
    const { store, payload, source } = fixture();
    const broken = { ...payload, continuation: { ...payload.continuation, sourceMessageIds: [randomUUID()] } };
    await expect(createProviderContinuation(store, broken, route)).rejects.toThrow();
    expect(store.shellSnapshot().conversations.some(({ id }) => id === payload.draftConversationId)).toBe(false);
    expect(store.conversation(source.id)).toEqual(source);
    await expect(createProviderContinuation(store, payload, route)).resolves.toMatchObject({ id: payload.draftConversationId });
  });

  it("rejects stale source identity and a changed branch", async () => {
    const { store, payload, git } = fixture();
    await expect(createProviderContinuation(store, { ...payload, continuation: { ...payload.continuation, expectedUpdatedAt: "2000-01-01T00:00:00.000Z" } }, route)).rejects.toThrow("source chat changed");
    git("checkout", "-qb", "other");
    await expect(createProviderContinuation(store, payload, route)).rejects.toThrow("branch changed");
    expect(store.shellSnapshot().conversations.some(({ id }) => id === payload.draftConversationId)).toBe(false);
  });

  it("excludes an active sibling process in the same checkout and releases reservations after failure", async () => {
    const { store, payload, source, workspace } = fixture();
    expect(store.conversationWork.reserveAtCheckout("sibling-process", source.projectId, workspace)).toBe(true);
    await expect(createProviderContinuation(store, payload, route)).rejects.toThrow("Stop active work");
    store.conversationWork.release("sibling-process");
    await expect(createProviderContinuation(store, payload, route)).resolves.toMatchObject({ id: payload.draftConversationId });
  });

  it("allows an explicit continuation preview of the source without weakening agent self-reference rules", () => {
    const { store, source } = fixture();
    expect(() => store.contextPackets.sourceTranscript(source.id, source.id)).toThrow("Choose another chat");
    expect(store.contextPackets.sourceTranscript(source.id, source.id, true).messages).toHaveLength(2);
  });

  it("refuses an unfinished ledger turn even when the conversation status is idle", async () => {
    const { store, source, payload } = fixture();
    store.beginAgentTurn({ id: randomUUID(), conversationId: source.id, runId: randomUUID(), content: "Still working",
      providerId: "codex", harnessId: "codex-app-server", backendProfileId: "builtin:openai", model: "provider-default", reasoningEffort: "",
      interactionMode: "build", accessMode: "supervised", configurationRevision: 0, association: "authoritative" });
    payload.continuation.expectedUpdatedAt = store.conversation(source.id).updatedAt;
    await expect(createProviderContinuation(store, payload, route)).rejects.toThrow("Wait for the source chat");
  });

  it("rejects caller-supplied checkout overrides and duplicate message IDs at the command boundary", () => {
    const { payload } = fixture();
    expect(conversationCreatePayloadSchema.safeParse(payload).success).toBe(true);
    for (const extra of [{ worktreePath: "/elsewhere" }, { branch: "other" }, { useWorktree: false }, { draftConversationId: undefined }]) {
      expect(conversationCreatePayloadSchema.safeParse({ ...payload, ...extra }).success).toBe(false);
    }
    expect(conversationCreatePayloadSchema.safeParse({ ...payload, continuation: { ...payload.continuation, sourceMessageIds: [payload.continuation.sourceMessageIds[0], payload.continuation.sourceMessageIds[0]] } }).success).toBe(false);
  });
});
