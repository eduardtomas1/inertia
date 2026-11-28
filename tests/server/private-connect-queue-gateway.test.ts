import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  privateConnectConversationDetailSchema,
  privateConnectRequestSchema,
} from "../../src/shared/private-connect/protocol";
import { privateConnectPromptSafetyForHarness } from "../../src/shared/private-connect/prompt-safety";
import {
  PRIVATE_CONNECT_RUNTIME_LIMITS,
  privateConnectRuntimeRequestSchema,
  privateConnectRuntimeResponseSchema,
  privateConnectRuntimeSafeConversationDetailSchema,
  type PrivateConnectRuntimeAuthorization,
} from "../../src/shared/private-connect/runtime-contract";
import { privateConnectRuntimeGrantsFromProjectIds } from "../../src/shared/private-connect/runtime-grants";
import { adaptPrivateConnectRuntimeResponse } from "../../src/main/private-connect/runtime-response";
import {
  dispatchPrivateConnectQueueRequest,
  isPrivateConnectQueueRequest,
  privateConnectRequiredScope,
} from "../../src/main/private-connect/queue-dispatch";
import type { PrivateConnectAuditEvent, PrivateConnectDevice } from "../../src/main/private-connect/store";
import { RuntimeStore } from "../../src/server/database";
import { PrivateConnectRuntimeGateway } from "../../src/server/private-connect/runtime-gateway";

const directories: string[] = [];
const stores: RuntimeStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createFixture(options: {
  active?: boolean;
  accessMode?: "supervised" | "full";
  providerId?: "codex" | "claude" | "kimi";
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "inertia-pc-queue-"));
  directories.push(directory);
  const store = new RuntimeStore(join(directory, "inertia.sqlite"), directory);
  stores.push(store);
  const project = store.createProject("Queue Project", directory);
  const conversation = store.createConversation(project.id, "Queue Chat", {
    accessMode: options.accessMode ?? "supervised",
    ...(options.providerId ? { providerId: options.providerId } : {}),
  });
  let active = options.active ?? false;
  const promptSafety = () => privateConnectPromptSafetyForHarness("codex-app-server");
  const makeGateway = () => new PrivateConnectRuntimeGateway({
    shell: () => store.shellSnapshot(),
    conversation: (id) => store.conversationShell(id),
    detail: (id) => store.conversationDetail(id),
    isConversationActive: () => active,
    preparePrompt: async () => undefined,
    queuePrompt: () => ({ turnId: `turn-${randomUUID()}` }),
    privateConnectPromptSafety: promptSafety,
    store,
  });
  const deviceId = "11111111-1111-4111-8111-111111111111";
  const sessionId = "22222222-2222-4222-8222-222222222222";
  const collaborate: PrivateConnectRuntimeAuthorization = {
    deviceId,
    sessionId,
    scopes: ["view", "prompt"],
    projectIds: [project.id],
    grants: privateConnectRuntimeGrantsFromProjectIds([project.id]),
    grantVersion: 1,
    expiresAt: "2030-01-01T00:00:00.000Z",
  };
  const monitor: PrivateConnectRuntimeAuthorization = {
    ...collaborate,
    scopes: ["view"],
  };
  return {
    store,
    project,
    conversation,
    collaborate,
    monitor,
    gateway: makeGateway(),
    makeGateway,
    setActive(next: boolean) { active = next; },
  };
}

describe("Private Connect queue protocol, main bridge, and runtime gateway", () => {
  it("projects sanitized read-only queue for Monitor with attachment counts only and never exposes filenames or paths", async () => {
    const f = createFixture({ active: true });
    const withAttachmentId = randomUUID();
    const textOnlyId = randomUUID();
    const watcherId = randomUUID();

    f.store.orchestration.queue.enqueue({
      conversationId: f.conversation.id,
      itemId: withAttachmentId,
      content: "Inspect this screenshot",
      attachments: [{
        id: randomUUID(),
        name: "secret-credentials-screenshot.png",
        mimeType: "image/png",
        size: 1234,
        path: "/home/user/.secrets/secret-credentials-screenshot.png",
      }],
    });
    f.store.orchestration.queue.enqueue({
      conversationId: f.conversation.id,
      itemId: textOnlyId,
      content: "Follow up on tests",
      createdBy: "user",
      creationSource: "mobile",
      deviceId: f.collaborate.deviceId,
      steerWhenReadyRunId: "run-preparing-1",
    });
    f.store.orchestration.queue.enqueue({
      conversationId: f.conversation.id,
      itemId: watcherId,
      content: "Watcher spotted a bug",
      kind: "watcher-note",
      createdBy: "system",
      creationSource: "server",
      followsThreadSelection: true,
      attribution: {
        watcherNote: {
          linkId: randomUUID(),
          wakeId: randomUUID(),
          watcherConversationId: randomUUID(),
          preset: "reviewer",
          watcherLabel: "Codex Reviewer",
          delivery: "queue",
        },
      },
    });

    const response = await f.gateway.request(f.monitor, {
      type: "conversation.get",
      requestId: randomUUID(),
      conversationId: f.conversation.id,
    });
    expect(response.ok).toBe(true);
    expect(privateConnectRuntimeResponseSchema.safeParse(response).success).toBe(true);
    if (!response.ok || response.result.kind !== "conversation") throw new Error("expected conversation detail");

    expect(privateConnectRuntimeSafeConversationDetailSchema.safeParse(response.result.detail).success).toBe(true);
    const queue = response.result.detail.queue!;
    expect(queue.items).toHaveLength(3);
    expect(queue.items[0]).toMatchObject({
      id: withAttachmentId,
      content: "Inspect this screenshot",
      attachmentCount: 1,
      editable: false,
      sendLabel: "none",
      attribution: "user",
    });
    expect(queue.items[1]).toMatchObject({
      id: textOnlyId,
      content: "Follow up on tests",
      attachmentCount: 0,
      editable: true,
      sendLabel: "send-now",
      attribution: "device",
      steerWaiting: true,
    });
    expect(queue.items[2]).toMatchObject({
      id: watcherId,
      content: "Watcher spotted a bug",
      attachmentCount: 0,
      editable: false,
      sendLabel: "none",
      attribution: "watcher",
      modelLabel: null,
    });
    expect(JSON.stringify(response)).not.toContain("secret-credentials-screenshot.png");
    expect(JSON.stringify(response)).not.toContain("/home/user/.secrets");

    // Main bridge runtime-response adaptation forwards queue cleanly and matches protocol schema.
    const device: PrivateConnectDevice = {
      id: f.monitor.deviceId,
      label: "Phone",
      scopes: ["private:read"],
      projectIds: [f.project.id],
      grants: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2030-01-01T00:00:00.000Z",
      lastSeenAt: null,
      revokedAt: null,
      grantVersion: 1,
    };
    const adapted = adaptPrivateConnectRuntimeResponse(response, device);
    expect(adapted.ok).toBe(true);
    if (adapted.ok) {
      const result = adapted.result as { detail: unknown };
      expect(privateConnectConversationDetailSchema.safeParse(result.detail).success).toBe(true);
    }
  });

  it("refuses Monitor devices on all queue mutations at both main bridge and runtime gateway", async () => {
    const f = createFixture({ active: true });
    const itemId = randomUUID();
    const requests = [
      { protocolVersion: 1 as const, type: "queue.send" as const, requestId: randomUUID(), conversationId: f.conversation.id, id: itemId },
      { protocolVersion: 1 as const, type: "queue.edit" as const, requestId: randomUUID(), conversationId: f.conversation.id, id: itemId, expectedRevision: 0, content: "Updated" },
      { protocolVersion: 1 as const, type: "queue.remove" as const, requestId: randomUUID(), conversationId: f.conversation.id, id: itemId },
      { protocolVersion: 1 as const, type: "queue.resume" as const, requestId: randomUUID(), conversationId: f.conversation.id },
    ];
    for (const request of requests) {
      expect(privateConnectRequestSchema.safeParse(request).success).toBe(true);
      expect(isPrivateConnectQueueRequest(request)).toBe(true);
      expect(privateConnectRequiredScope(request.type)).toBe("private:prompt");
      const { protocolVersion: _pv, ...runtimeReq } = request;
      expect(privateConnectRuntimeRequestSchema.safeParse(runtimeReq).success).toBe(true);
      const response = await f.gateway.request(f.monitor, runtimeReq);
      expect(response).toMatchObject({ ok: false, code: "forbidden" });
    }
  });

  it("queues busy prompt.send onto V2 queue with device attribution, CRLF normalization, and restart-safe G5 replay", async () => {
    const f = createFixture({ active: true });
    const deliveryId = randomUUID();
    const request1 = {
      type: "prompt.send" as const,
      requestId: randomUUID(),
      deliveryId,
      conversationId: f.conversation.id,
      content: "Line one\r\nLine two\rLine three",
    };

    const prepared = await f.gateway.preparePrompt(f.collaborate, request1);
    expect("preparationId" in prepared).toBe(true);
    if (!("preparationId" in prepared)) throw new Error("expected preparation");
    const committed = f.gateway.commitPrompt(f.collaborate, request1, prepared.preparationId);
    expect(privateConnectRuntimeResponseSchema.safeParse(committed).success).toBe(true);
    expect(committed).toMatchObject({
      ok: true,
      result: {
        kind: "prompt.accepted",
        deliveryId,
        turnId: null,
        queuedMessageId: deliveryId,
      },
    });

    const item = f.store.orchestration.queue.getItem(deliveryId)!;
    expect(item).toMatchObject({
      kind: "message",
      createdBy: "user",
      creationSource: "mobile",
      deviceId: f.collaborate.deviceId,
      state: "waiting",
    });
    expect(f.store.orchestration.queue.getContent(f.conversation.id, deliveryId)?.content)
      .toBe("Line one\nLine two\nLine three");

    // Simulate runtime restart (fresh gateway with empty in-memory receipts map) -> G5 receipt replays cleanly!
    const restartedGateway = f.makeGateway();
    const replayReq = { ...request1, requestId: randomUUID() };
    const replayed = await restartedGateway.preparePrompt(f.collaborate, replayReq);
    expect(replayed).toMatchObject({
      ok: true,
      requestId: replayReq.requestId,
      result: { kind: "prompt.accepted", deliveryId, turnId: null, queuedMessageId: deliveryId },
    });
    expect(f.store.orchestration.queue.listActive(f.conversation.id)).toHaveLength(1);

    // Same deliveryId with different content -> command-conflict refused as invalid!
    const conflictReq = { ...request1, requestId: randomUUID(), content: "Different prompt body" };
    const conflicted = await restartedGateway.preparePrompt(f.collaborate, conflictReq);
    expect(conflicted).toMatchObject({ ok: false, code: "invalid" });
  });

  it("handles queue.edit (text-only, CRLF, revision), queue.remove (with attachments), queue.send, and queue.resume", async () => {
    const f = createFixture({ active: true });
    const textId = randomUUID();
    const attachedId = randomUUID();
    const watcherId = randomUUID();

    f.store.orchestration.queue.enqueue({
      conversationId: f.conversation.id,
      itemId: textId,
      content: "Original text",
      queueHeld: true,
    });
    f.store.orchestration.queue.enqueue({
      conversationId: f.conversation.id,
      itemId: attachedId,
      content: "With file",
      attachments: [{ id: randomUUID(), name: "spec.pdf", mimeType: "application/pdf", size: 500, path: "/tmp/spec.pdf" }],
      queueHeld: true,
    });
    f.store.orchestration.queue.enqueue({
      conversationId: f.conversation.id,
      itemId: watcherId,
      content: "Watcher note",
      kind: "watcher-note",
      createdBy: "system",
      creationSource: "server",
      followsThreadSelection: true,
      attribution: {
        watcherNote: {
          linkId: randomUUID(),
          wakeId: randomUUID(),
          watcherConversationId: randomUUID(),
          preset: "reviewer",
          watcherLabel: "Reviewer",
          delivery: "queue",
        },
      },
    });

    // Edit text-only item with CRLF -> succeeds & bumps editRevision.
    const editOk = await f.gateway.request(f.collaborate, {
      type: "queue.edit",
      requestId: randomUUID(),
      conversationId: f.conversation.id,
      id: textId,
      expectedRevision: 0,
      content: "Updated\r\ntext",
    });
    expect(editOk).toMatchObject({ ok: true, result: { kind: "queue.updated", conversationId: f.conversation.id } });
    expect(f.store.orchestration.queue.getContent(f.conversation.id, textId)?.content).toBe("Updated\ntext");
    expect(f.store.orchestration.queue.getItem(textId)?.contentRef.editRevision).toBe(1);

    // Stale expectedRevision -> refused as stale.
    const editStale = await f.gateway.request(f.collaborate, {
      type: "queue.edit",
      requestId: randomUUID(),
      conversationId: f.conversation.id,
      id: textId,
      expectedRevision: 0,
      content: "Stale edit",
    });
    expect(editStale).toMatchObject({ ok: false, code: "stale" });

    // Edit item with attachments -> refused as forbidden.
    const editAttached = await f.gateway.request(f.collaborate, {
      type: "queue.edit",
      requestId: randomUUID(),
      conversationId: f.conversation.id,
      id: attachedId,
      expectedRevision: 0,
      content: "Try editing attached",
    });
    expect(editAttached).toMatchObject({ ok: false, code: "forbidden" });

    // Edit automatic watcher item -> refused as forbidden.
    const editWatcher = await f.gateway.request(f.collaborate, {
      type: "queue.edit",
      requestId: randomUUID(),
      conversationId: f.conversation.id,
      id: watcherId,
      expectedRevision: 0,
      content: "Try editing watcher",
    });
    expect(editWatcher).toMatchObject({ ok: false, code: "forbidden" });

    // Remove item with attachments -> allowed!
    const removeAttached = await f.gateway.request(f.collaborate, {
      type: "queue.remove",
      requestId: randomUUID(),
      conversationId: f.conversation.id,
      id: attachedId,
    });
    expect(removeAttached).toMatchObject({ ok: true, result: { kind: "queue.updated" } });
    expect(f.store.orchestration.queue.getItem(attachedId)?.state).toBe("cancelled");

    // Send automatic watcher item -> refused as forbidden.
    const sendWatcher = await f.gateway.request(f.collaborate, {
      type: "queue.send",
      requestId: randomUUID(),
      conversationId: f.conversation.id,
      id: watcherId,
    });
    expect(sendWatcher).toMatchObject({ ok: false, code: "forbidden" });

    // Resume releases held items and records durable resume intent.
    const resumeOk = await f.gateway.request(f.collaborate, {
      type: "queue.resume",
      requestId: randomUUID(),
      conversationId: f.conversation.id,
    });
    expect(resumeOk).toMatchObject({ ok: true, result: { kind: "queue.updated" } });
    expect(f.store.orchestration.queue.getItem(textId)?.queueHeld).toBe(false);
    expect(f.store.orchestration.queue.getState(f.conversation.id)?.pendingSendIntent?.kind).toBe("resume");

    // Send user item records send-now intent.
    const sendUser = await f.gateway.request(f.collaborate, {
      type: "queue.send",
      requestId: randomUUID(),
      conversationId: f.conversation.id,
      id: textId,
    });
    expect(sendUser).toMatchObject({ ok: true, result: { kind: "queue.updated" } });
    expect(f.store.orchestration.queue.getState(f.conversation.id)?.pendingSendIntent).toMatchObject({
      kind: "send-now",
      itemId: textId,
    });
  });

  it("enforces text-only queue.send and never projects stop-and-send for attachment rows or non-steerable active harnesses", async () => {
    const steerable = createFixture({ active: true, providerId: "codex" });
    const textId = randomUUID();
    const attachedId = randomUUID();
    const followUpId = randomUUID();

    steerable.store.orchestration.queue.enqueue({
      conversationId: steerable.conversation.id,
      itemId: textId,
      content: "Plain text follow-up",
    });
    steerable.store.orchestration.queue.enqueue({
      conversationId: steerable.conversation.id,
      itemId: attachedId,
      content: "Attached screenshot",
      attachments: [{
        id: randomUUID(),
        name: "capture.png",
        mimeType: "image/png",
        size: 256,
        path: "/tmp/capture.png",
      }],
    });
    steerable.store.orchestration.queue.enqueue({
      conversationId: steerable.conversation.id,
      itemId: followUpId,
      content: "Unread steer follow-up",
      steerFollowUpOfRunId: "run-active-1",
    });

    const activeDetail = await steerable.gateway.request(steerable.monitor, {
      type: "conversation.get",
      requestId: randomUUID(),
      conversationId: steerable.conversation.id,
    });
    if (!activeDetail.ok || activeDetail.result.kind !== "conversation") {
      throw new Error("expected conversation detail");
    }
    expect(activeDetail.result.detail.queue?.items.map(({ id, sendLabel }) => ({ id, sendLabel }))).toEqual([
      { id: textId, sendLabel: "send-now" },
      { id: attachedId, sendLabel: "none" },
      { id: followUpId, sendLabel: "none" },
    ]);

    // Attachment rows are forbidden on queue.send both while active and when idle.
    const sendAttachedActive = await steerable.gateway.request(steerable.collaborate, {
      type: "queue.send",
      requestId: randomUUID(),
      conversationId: steerable.conversation.id,
      id: attachedId,
    });
    expect(sendAttachedActive).toMatchObject({ ok: false, code: "forbidden" });

    // Unread follow-up items cannot be sent manually while a turn is active.
    const sendFollowUpActive = await steerable.gateway.request(steerable.collaborate, {
      type: "queue.send",
      requestId: randomUUID(),
      conversationId: steerable.conversation.id,
      id: followUpId,
    });
    expect(sendFollowUpActive).toMatchObject({ ok: false, code: "forbidden" });

    // Even when idle, attachment rows stay non-sendable from a paired device.
    steerable.setActive(false);
    const idleDetail = await steerable.gateway.request(steerable.monitor, {
      type: "conversation.get",
      requestId: randomUUID(),
      conversationId: steerable.conversation.id,
    });
    if (!idleDetail.ok || idleDetail.result.kind !== "conversation") {
      throw new Error("expected conversation detail");
    }
    expect(idleDetail.result.detail.queue?.items.map(({ id, sendLabel }) => ({ id, sendLabel }))).toEqual([
      { id: textId, sendLabel: "send-now" },
      { id: attachedId, sendLabel: "none" },
      { id: followUpId, sendLabel: "send-now" },
    ]);
    const sendAttachedIdle = await steerable.gateway.request(steerable.collaborate, {
      type: "queue.send",
      requestId: randomUUID(),
      conversationId: steerable.conversation.id,
      id: attachedId,
    });
    expect(sendAttachedIdle).toMatchObject({ ok: false, code: "forbidden" });

    // Non-steerable harness (kimi-acp) never projects stop-and-send while active and rejects active queue.send.
    const nonSteerable = createFixture({ active: true, providerId: "kimi" });
    const kimiItemId = randomUUID();
    nonSteerable.store.orchestration.queue.enqueue({
      conversationId: nonSteerable.conversation.id,
      itemId: kimiItemId,
      content: "Queued for non-steerable harness",
    });

    const kimiActiveDetail = await nonSteerable.gateway.request(nonSteerable.monitor, {
      type: "conversation.get",
      requestId: randomUUID(),
      conversationId: nonSteerable.conversation.id,
    });
    if (!kimiActiveDetail.ok || kimiActiveDetail.result.kind !== "conversation") {
      throw new Error("expected conversation detail");
    }
    expect(kimiActiveDetail.result.detail.queue?.items).toEqual([
      expect.objectContaining({ id: kimiItemId, sendLabel: "none" }),
    ]);
    const kimiActiveSend = await nonSteerable.gateway.request(nonSteerable.collaborate, {
      type: "queue.send",
      requestId: randomUUID(),
      conversationId: nonSteerable.conversation.id,
      id: kimiItemId,
    });
    expect(kimiActiveSend).toMatchObject({ ok: false, code: "forbidden" });

    // Once idle, text-only item on non-steerable harness projects send-now and executes cleanly.
    nonSteerable.setActive(false);
    const kimiIdleDetail = await nonSteerable.gateway.request(nonSteerable.monitor, {
      type: "conversation.get",
      requestId: randomUUID(),
      conversationId: nonSteerable.conversation.id,
    });
    if (!kimiIdleDetail.ok || kimiIdleDetail.result.kind !== "conversation") {
      throw new Error("expected conversation detail");
    }
    expect(kimiIdleDetail.result.detail.queue?.items).toEqual([
      expect.objectContaining({ id: kimiItemId, sendLabel: "send-now" }),
    ]);
    const kimiIdleSend = await nonSteerable.gateway.request(nonSteerable.collaborate, {
      type: "queue.send",
      requestId: randomUUID(),
      conversationId: nonSteerable.conversation.id,
      id: kimiItemId,
    });
    expect(kimiIdleSend).toMatchObject({ ok: true, result: { kind: "queue.updated" } });
  });

  it("enforces supervised access / prompt safety on queue mutations and trims queue to plaintext byte budget", async () => {
    const full = createFixture({ active: true, accessMode: "full" });
    const fullResp = await full.gateway.request(full.collaborate, {
      type: "queue.resume",
      requestId: randomUUID(),
      conversationId: full.conversation.id,
    });
    expect(fullResp).toMatchObject({ ok: false, code: "forbidden" });

    const f = createFixture({ active: true });
    for (let index = 0; index < 8; index += 1) {
      f.store.orchestration.queue.enqueue({
        conversationId: f.conversation.id,
        itemId: randomUUID(),
        content: `Item ${index}: ${"x".repeat(18_000)}`,
      });
    }
    const detailResp = await f.gateway.request(f.monitor, {
      type: "conversation.get",
      requestId: randomUUID(),
      conversationId: f.conversation.id,
    });
    expect(detailResp.ok).toBe(true);
    const bytes = new TextEncoder().encode(JSON.stringify(detailResp)).byteLength;
    expect(bytes).toBeLessThanOrEqual(PRIVATE_CONNECT_RUNTIME_LIMITS.plaintextBytes);
  });

  it("audits and dispatches queue commands through main queue-dispatch helper", async () => {
    const f = createFixture({ active: true });
    const audits: Array<{ type: PrivateConnectAuditEvent["type"]; detail: string }> = [];
    const persist = vi.fn(async () => undefined);
    const device: PrivateConnectDevice = {
      id: f.collaborate.deviceId,
      label: "Laptop",
      scopes: ["private:read", "private:prompt", "private:input", "private:stop"],
      projectIds: [f.project.id],
      grants: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2030-01-01T00:00:00.000Z",
      lastSeenAt: null,
      revokedAt: null,
      grantVersion: 1,
    };
    const response = await dispatchPrivateConnectQueueRequest(
      { protocolVersion: 1, type: "queue.resume", requestId: randomUUID(), conversationId: f.conversation.id },
      {
        device,
        requireCurrentSession: () => undefined,
        runtimeAuthorization: () => f.collaborate,
        sendToRuntime: (subject, req) => f.gateway.request(subject, req),
        record: (type, detail) => { audits.push({ type, detail }); },
        persist,
      },
    );
    expect(response).toMatchObject({ ok: true, result: { kind: "queue.updated", conversationId: f.conversation.id } });
    expect(audits.map(({ type }) => type)).toEqual(["request.started", "prompt.accepted"]);
    expect(persist).toHaveBeenCalledTimes(2);
  });
});
