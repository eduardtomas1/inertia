import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { RemoteRuntimeGateway } from "../../src/server/remote-gateway";
import type {
  RemoteAuthorizationSubject,
  RemoteRequest,
} from "../../src/shared/remote-protocol";
import {
  REMOTE_LIMITS,
  remoteResponseSchema,
} from "../../src/shared/remote-protocol";

const temporaryDirectories: string[] = [];

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "inertia-remote-gateway-"));
  temporaryDirectories.push(directory);
  const store = new RuntimeStore(
    join(directory, "inertia.sqlite"),
    directory,
  );
  const firstProject = store.createProject("Safe project", directory);
  const firstConversation = store.createConversation(
    firstProject.id,
    "Safe conversation",
  );
  const secondProject = store.createProject("Secret project", directory);
  const secondConversation = store.createConversation(
    secondProject.id,
    "Other conversation",
  );
  let queued = 0;
  const gateway = new RemoteRuntimeGateway({
    shell: () => store.shellSnapshot(),
    detail: (conversationId) => store.conversationDetail(conversationId),
    isConversationActive: () => false,
    preparePrompt: async () => undefined,
    queuePrompt: () => ({ turnId: `remote-turn-${++queued}` }),
    now: () => new Date("2030-01-01T00:00:00.000Z"),
  });
  const subject: RemoteAuthorizationSubject = {
    deviceId: "09400fa3-32c0-4d8d-8d17-e8ea0a4f6937",
    sessionId: "7f0c11aa-9ee8-4e3c-8f8f-0907e31b389e",
    scopes: ["view"],
    projectIds: [firstProject.id],
    grantVersion: 1,
    expiresAt: "2030-02-01T00:00:00.000Z",
  };
  return {
    store,
    gateway,
    subject,
    firstProject,
    firstConversation,
    secondProject,
    secondConversation,
    queued: () => queued,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Remote Companion runtime authority", () => {
  it("projects only authorized projects without filesystem paths", async () => {
    const {
      store,
      gateway,
      subject,
      firstProject,
      firstConversation,
      secondProject,
    } = fixture();
    const response = await gateway.request(subject, {
      type: "state.get",
      requestId: crypto.randomUUID(),
    });

    expect(response.ok).toBe(true);
    expect(JSON.stringify(response)).not.toContain(firstProject.path);
    expect(JSON.stringify(response)).not.toContain(secondProject.id);
    if (response.ok && response.result.kind === "state") {
      expect(response.result.state.projects.map(({ id }) => id)).toEqual([
        firstProject.id,
      ]);
      expect(response.result.state.conversations.map(({ id }) => id)).toEqual([
        firstConversation.id,
      ]);
    }
    store.close();
  });

  it("redacts transcript output and omits attachments and execution details", async () => {
    const { store, gateway, subject, firstConversation } = fixture();
    store.createMessage(
      firstConversation.id,
      "Read /Users/alice/private.ts\n```ts\nconst key='sk-secret123456789';\n```\n<script>alert(1)</script>",
      "assistant",
      [{
        id: crypto.randomUUID(),
        name: "secret.txt",
        path: "/Users/alice/secret.txt",
        mimeType: "text/plain",
        size: 10,
      }],
    );
    const response = await gateway.request(subject, {
      type: "conversation.get",
      requestId: crypto.randomUUID(),
      conversationId: firstConversation.id,
    });

    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain("/Users/alice");
    expect(serialized).not.toContain("sk-secret");
    expect(serialized).not.toContain("<script>");
    expect(serialized).not.toContain("secret.txt");
    store.close();
  });

  it("enforces project ownership, scope, supervised mode, and expiry", async () => {
    const {
      store,
      gateway,
      subject,
      firstConversation,
      secondConversation,
    } = fixture();
    const send = (
      conversationId: string,
    ): RemoteRequest => ({
      type: "prompt.send",
      requestId: crypto.randomUUID(),
      deliveryId: crypto.randomUUID(),
      conversationId,
      content: "Continue safely",
    });

    expect(await gateway.request(subject, send(firstConversation.id))).toMatchObject({
      ok: false,
      code: "forbidden",
    });
    expect(await gateway.request(
      { ...subject, scopes: ["view", "prompt"] },
      send(secondConversation.id),
    )).toMatchObject({ ok: false, code: "not-found" });
    store.updateConversation(firstConversation.id, { accessMode: "full" });
    expect(await gateway.request(
      { ...subject, scopes: ["view", "prompt"] },
      send(firstConversation.id),
    )).toMatchObject({ ok: false, code: "forbidden" });
    expect(await gateway.request(
      { ...subject, expiresAt: "2029-01-01T00:00:00.000Z" },
      { type: "state.get", requestId: crypto.randomUUID() },
    )).toMatchObject({ ok: false, code: "forbidden" });
    store.close();
  });

  it("accepts each delivery exactly once and rejects identifier fixation", async () => {
    const { store, gateway, subject, firstConversation, queued } = fixture();
    const request = {
      type: "prompt.send" as const,
      requestId: crypto.randomUUID(),
      deliveryId: crypto.randomUUID(),
      conversationId: firstConversation.id,
      content: "Continue safely",
    };
    const promptingSubject: RemoteAuthorizationSubject = {
      ...subject,
      scopes: ["view", "prompt"],
    };

    const first = await gateway.request(promptingSubject, request);
    const duplicate = await gateway.request(promptingSubject, {
      ...request,
      requestId: crypto.randomUUID(),
    });
    const fixed = await gateway.request(promptingSubject, {
      ...request,
      requestId: crypto.randomUUID(),
      content: "Different prompt",
    });

    expect(first).toMatchObject({ ok: true });
    expect(duplicate).toMatchObject({ ok: true });
    expect(fixed).toMatchObject({ ok: false, code: "invalid" });
    expect(queued()).toBe(1);
    store.close();
  });

  it("retains only the bounded newest delivery identifiers", async () => {
    const { store, gateway, subject, firstConversation, queued } = fixture();
    const promptingSubject: RemoteAuthorizationSubject = {
      ...subject,
      scopes: ["view", "prompt"],
    };
    const firstDeliveryId = crypto.randomUUID();
    for (
      let index = 0;
      index <= REMOTE_LIMITS.deliveryReceipts;
      index += 1
    ) {
      const response = await gateway.request(promptingSubject, {
        type: "prompt.send",
        requestId: crypto.randomUUID(),
        deliveryId: index === 0 ? firstDeliveryId : crypto.randomUUID(),
        conversationId: firstConversation.id,
        content: `Prompt ${index}`,
      });
      expect(response).toMatchObject({ ok: true });
    }
    expect(queued()).toBe(REMOTE_LIMITS.deliveryReceipts + 1);

    expect(await gateway.request(promptingSubject, {
      type: "prompt.send",
      requestId: crypto.randomUUID(),
      deliveryId: firstDeliveryId,
      conversationId: firstConversation.id,
      content: "Prompt 0",
    })).toMatchObject({ ok: true });
    expect(queued()).toBe(REMOTE_LIMITS.deliveryReceipts + 2);
    store.close();
  });

  it("keeps the newest useful conversations within the encrypted byte budget", async () => {
    const {
      store,
      subject,
      firstProject,
      firstConversation,
    } = fixture();
    const snapshot = store.shellSnapshot();
    const template = snapshot.conversations.find(
      ({ id }) => id === firstConversation.id,
    )!;
    const conversations = Array.from({ length: 5_000 }, (_, index) => ({
      ...template,
      id: `large-conversation-${index}`,
      title: `Conversation ${index} ${"x".repeat(200)}`,
      updatedAt: new Date(
        Date.UTC(2030, 0, 1, 0, 0, index),
      ).toISOString(),
    }));
    const gateway = new RemoteRuntimeGateway({
      shell: () => ({
        ...snapshot,
        projects: snapshot.projects.filter(
          ({ id }) => id === firstProject.id,
        ),
        conversations,
        runs: [],
      }),
      detail: () => null,
      isConversationActive: () => false,
      preparePrompt: async () => undefined,
      queuePrompt: () => ({ turnId: "unused" }),
    });

    const response = await gateway.request(subject, {
      type: "state.get",
      requestId: crypto.randomUUID(),
    });
    expect(new TextEncoder().encode(JSON.stringify(response)).byteLength)
      .toBeLessThanOrEqual(REMOTE_LIMITS.plaintextBytes);
    expect(remoteResponseSchema.parse(response)).toEqual(response);
    if (response.ok && response.result.kind === "state") {
      expect(response.result.state.conversations.at(-1)?.id).toBe(
        "large-conversation-4999",
      );
      expect(response.result.state.conversations[0]?.id).not.toBe(
        "large-conversation-0",
      );
    }
    store.close();
  });

  it("truncates long transcripts by UTF-8 bytes while preserving the newest message", async () => {
    const { store, subject, firstConversation } = fixture();
    store.createMessage(firstConversation.id, "template", "assistant");
    const shell = store.shellSnapshot();
    const detail = store.conversationDetail(firstConversation.id)!;
    const template = detail.messages[0]!;
    const messages = Array.from({ length: 200 }, (_, index) => ({
      ...template,
      id: `large-message-${index}`,
      content: "😀".repeat(32_768),
      createdAt: new Date(
        Date.UTC(2030, 0, 1, 0, 0, index),
      ).toISOString(),
    }));
    const gateway = new RemoteRuntimeGateway({
      shell: () => shell,
      detail: () => ({ ...detail, messages }),
      isConversationActive: () => false,
      preparePrompt: async () => undefined,
      queuePrompt: () => ({ turnId: "unused" }),
    });

    const response = await gateway.request(subject, {
      type: "conversation.get",
      requestId: crypto.randomUUID(),
      conversationId: firstConversation.id,
    });
    expect(new TextEncoder().encode(JSON.stringify(response)).byteLength)
      .toBeLessThanOrEqual(REMOTE_LIMITS.plaintextBytes);
    expect(remoteResponseSchema.parse(response)).toEqual(response);
    if (response.ok && response.result.kind === "conversation") {
      expect(response.result.detail.messages.at(-1)?.id).toBe(
        "large-message-199",
      );
      expect(response.result.detail.messages.length).toBeLessThan(200);
    }
    store.close();
  });
});
