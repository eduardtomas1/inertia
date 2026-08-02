import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { RemoteRuntimeGateway } from "../../src/server/remote-gateway";
import {
  createAuthenticatedSessionRecipient,
  createAuthenticatedSessionSender,
  generateRemoteKeyPair,
  importRemoteKeyPair,
  importRemotePublicKey,
  openSessionData,
  sealSessionData,
} from "../../src/shared/remote-crypto";
import type {
  RemoteAuthorizationSubject,
  RemoteRequest,
} from "../../src/shared/remote-protocol";
import {
  REMOTE_LIMITS,
  REMOTE_PROTOCOL_VERSION,
  encodedRemoteFrameBytes,
  remoteResponseSchema,
} from "../../src/shared/remote-protocol";
import {
  remoteConversationGrantsFromProjectIds,
} from "../../src/shared/remote-grants";
import {
  remotePromptSafetyForHarness,
} from "../../src/shared/remote-prompt-safety";

const temporaryDirectories: string[] = [];

function fixture(
  now: () => Date = () => new Date("2030-01-01T00:00:00.000Z"),
) {
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
    remotePromptSafety: () => remotePromptSafetyForHarness("codex-app-server"),
    now,
  });
  const subject: RemoteAuthorizationSubject = {
    deviceId: "09400fa3-32c0-4d8d-8d17-e8ea0a4f6937",
    sessionId: "7f0c11aa-9ee8-4e3c-8f8f-0907e31b389e",
    scopes: ["view"],
    projectIds: [firstProject.id],
    grants: remoteConversationGrantsFromProjectIds([firstProject.id]),
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

function deferred() {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function sendPrompt(
  gateway: RemoteRuntimeGateway,
  subject: RemoteAuthorizationSubject,
  request: Extract<RemoteRequest, { type: "prompt.send" }>,
) {
  const prepared = await gateway.preparePrompt(subject, request);
  return "preparationId" in prepared
    ? gateway.commitPrompt(subject, request, prepared.preparationId)
    : prepared;
}

function promptRaceFixture() {
  const base = fixture();
  let currentDetail = base.store.conversationDetail(
    base.firstConversation.id,
  );
  let active = false;
  let queueCalls = 0;
  const entered = deferred();
  const release = deferred();
  const gateway = new RemoteRuntimeGateway({
    shell: () => base.store.shellSnapshot(),
    detail: () => currentDetail,
    isConversationActive: () => active,
    preparePrompt: async () => {
      entered.resolve();
      await release.promise;
    },
    queuePrompt: () => ({
      turnId: `remote-race-${++queueCalls}`,
    }),
    remotePromptSafety: () => remotePromptSafetyForHarness("codex-app-server"),
    now: () => new Date("2030-01-01T00:00:00.000Z"),
  });
  const request: Extract<RemoteRequest, { type: "prompt.send" }> = {
    type: "prompt.send",
    requestId: crypto.randomUUID(),
    deliveryId: crypto.randomUUID(),
    conversationId: base.firstConversation.id,
    content: "Continue safely",
  };
  const promptingSubject: RemoteAuthorizationSubject = {
    ...base.subject,
    scopes: ["view", "prompt"],
  };
  return {
    ...base,
    gateway,
    request,
    promptingSubject,
    entered: entered.promise,
    release: release.resolve,
    detail: () => currentDetail,
    setDetail: (value: typeof currentDetail) => {
      currentDetail = value;
    },
    setActive: (value: boolean) => {
      active = value;
    },
    queueCalls: () => queueCalls,
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

  it("returns explicit unchanged projections with restart-stable validators", async () => {
    let checkedAt = new Date("2030-01-01T00:00:00.000Z");
    const {
      store,
      gateway,
      subject,
      firstConversation,
    } = fixture(() => checkedAt);
    const first = await gateway.request(subject, {
      type: "state.get",
      requestId: crypto.randomUUID(),
      ifNoneMatch: null,
    });
    expect(first).toMatchObject({
      ok: true,
      result: { kind: "state", validator: expect.any(String) },
    });
    if (!first.ok || first.result.kind !== "state" || !first.result.validator) {
      throw new Error("Missing conditional state projection.");
    }
    const validator = first.result.validator;

    checkedAt = new Date("2030-01-01T00:00:02.000Z");
    const unchanged = await gateway.request(
      { ...subject, sessionId: crypto.randomUUID() },
      {
        type: "state.get",
        requestId: crypto.randomUUID(),
        ifNoneMatch: validator,
      },
    );
    expect(unchanged).toMatchObject({
      ok: true,
      result: {
        kind: "not-modified",
        validator,
        checkedAt: checkedAt.toISOString(),
        resource: { kind: "state" },
      },
    });

    const reduced = await gateway.request(
      { ...subject, grantVersion: subject.grantVersion + 1 },
      {
        type: "state.get",
        requestId: crypto.randomUUID(),
        ifNoneMatch: validator,
      },
    );
    expect(reduced).toMatchObject({
      ok: true,
      result: { kind: "state", validator: expect.not.stringMatching(`^${validator}$`) },
    });

    store.updateConversation(firstConversation.id, { title: "Changed title" });
    const changed = await gateway.request(subject, {
      type: "state.get",
      requestId: crypto.randomUUID(),
      ifNoneMatch: validator,
    });
    expect(changed).toMatchObject({
      ok: true,
      result: {
        kind: "state",
        validator: expect.not.stringMatching(`^${validator}$`),
      },
    });

    const legacy = await gateway.request(subject, {
      type: "state.get",
      requestId: crypto.randomUUID(),
    });
    expect(legacy).toMatchObject({ ok: true, result: { kind: "state" } });
    if (legacy.ok && legacy.result.kind === "state") {
      expect(legacy.result).not.toHaveProperty("validator");
    }
    store.close();
  });

  it("keys conditional conversation validators to the authorized resource", async () => {
    const { store, gateway, subject, firstConversation } = fixture();
    const first = await gateway.request(subject, {
      type: "conversation.get",
      requestId: crypto.randomUUID(),
      conversationId: firstConversation.id,
      ifNoneMatch: null,
    });
    if (
      !first.ok
      || first.result.kind !== "conversation"
      || !first.result.validator
    ) throw new Error("Missing conditional conversation projection.");

    expect(await gateway.request(subject, {
      type: "conversation.get",
      requestId: crypto.randomUUID(),
      conversationId: firstConversation.id,
      ifNoneMatch: first.result.validator,
    })).toMatchObject({
      ok: true,
      result: {
        kind: "not-modified",
        validator: first.result.validator,
        resource: {
          kind: "conversation",
          conversationId: firstConversation.id,
        },
      },
    });
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
      ifNoneMatch: null,
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

    expect(await gateway.preparePrompt(
      subject,
      send(firstConversation.id),
    )).toMatchObject({
      ok: false,
      code: "forbidden",
    });
    expect(await gateway.preparePrompt(
      { ...subject, scopes: ["view", "prompt"] },
      send(secondConversation.id),
    )).toMatchObject({ ok: false, code: "not-found" });
    store.updateConversation(firstConversation.id, { accessMode: "full" });
    expect(await gateway.preparePrompt(
      { ...subject, scopes: ["view", "prompt"] },
      send(firstConversation.id),
    )).toMatchObject({ ok: false, code: "forbidden" });
    expect(await gateway.request(
      { ...subject, expiresAt: "2029-01-01T00:00:00.000Z" },
      { type: "state.get", requestId: crypto.randomUUID() },
    )).toMatchObject({ ok: false, code: "forbidden" });
    store.close();
  });

  it("rejects archived reads and prompts until the conversation is restored", async () => {
    const { store, gateway, subject, firstConversation, queued } = fixture();
    const promptingSubject: RemoteAuthorizationSubject = {
      ...subject,
      scopes: ["view", "prompt"],
    };
    const detailRequest = {
      type: "conversation.get" as const,
      requestId: crypto.randomUUID(),
      conversationId: firstConversation.id,
    };
    const promptRequest = {
      type: "prompt.send" as const,
      requestId: crypto.randomUUID(),
      deliveryId: crypto.randomUUID(),
      conversationId: firstConversation.id,
      content: "Do not revive an archived conversation",
    };

    store.archiveConversation(firstConversation.id, true);
    const archivedShell = await gateway.request(subject, {
      type: "state.get",
      requestId: crypto.randomUUID(),
    });
    expect(archivedShell).toMatchObject({ ok: true });
    if (archivedShell.ok && archivedShell.result.kind === "state") {
      expect(archivedShell.result.state.conversations).toEqual([]);
    }
    expect(await gateway.request(subject, detailRequest)).toMatchObject({
      ok: false,
      code: "not-found",
    });
    expect(await gateway.preparePrompt(
      promptingSubject,
      promptRequest,
    )).toMatchObject({ ok: false, code: "not-found" });

    store.archiveConversation(firstConversation.id, false);
    expect(await gateway.request(subject, {
      ...detailRequest,
      requestId: crypto.randomUUID(),
    })).toMatchObject({ ok: true });
    const prepared = await gateway.preparePrompt(
      promptingSubject,
      promptRequest,
    );
    if (!("preparationId" in prepared)) {
      throw new Error("Restored conversation was not prepared.");
    }

    store.archiveConversation(firstConversation.id, true);
    expect(gateway.commitPrompt(
      promptingSubject,
      promptRequest,
      prepared.preparationId,
    )).toMatchObject({ ok: false, code: "not-found" });
    expect(queued()).toBe(0);

    store.archiveConversation(firstConversation.id, false);
    const acceptedRequest = {
      ...promptRequest,
      requestId: crypto.randomUUID(),
      deliveryId: crypto.randomUUID(),
    };
    expect(await sendPrompt(
      gateway,
      promptingSubject,
      acceptedRequest,
    )).toMatchObject({ ok: true });
    expect(queued()).toBe(1);

    store.archiveConversation(firstConversation.id, true);
    expect(await sendPrompt(gateway, promptingSubject, {
      ...acceptedRequest,
      requestId: crypto.randomUUID(),
    })).toMatchObject({ ok: false, code: "not-found" });
    expect(queued()).toBe(1);

    store.archiveConversation(firstConversation.id, false);
    expect(await sendPrompt(gateway, promptingSubject, {
      ...acceptedRequest,
      requestId: crypto.randomUUID(),
    })).toMatchObject({ ok: true });
    expect(queued()).toBe(1);
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

    const first = await sendPrompt(gateway, promptingSubject, request);
    const duplicate = await sendPrompt(gateway, promptingSubject, {
      ...request,
      requestId: crypto.randomUUID(),
    });
    const fixed = await sendPrompt(gateway, promptingSubject, {
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

  it("commits only the exact prepared subject and request once", async () => {
    const { store, gateway, subject, firstConversation, queued } = fixture();
    const promptingSubject: RemoteAuthorizationSubject = {
      ...subject,
      scopes: ["view", "prompt"],
    };
    const request = {
      type: "prompt.send" as const,
      requestId: crypto.randomUUID(),
      deliveryId: crypto.randomUUID(),
      conversationId: firstConversation.id,
      content: "Commit exactly once",
    };

    const mismatchedPreparation = await gateway.preparePrompt(
      promptingSubject,
      request,
    );
    if (!("preparationId" in mismatchedPreparation)) {
      throw new Error("Prompt was not prepared");
    }
    expect(gateway.commitPrompt(
      { ...promptingSubject, grantVersion: 2 },
      request,
      mismatchedPreparation.preparationId,
    )).toMatchObject({ ok: false, code: "forbidden" });
    expect(queued()).toBe(0);

    const exactPreparation = await gateway.preparePrompt(
      promptingSubject,
      request,
    );
    if (!("preparationId" in exactPreparation)) {
      throw new Error("Prompt was not prepared");
    }
    expect(exactPreparation.preparationId).not.toBe(
      mismatchedPreparation.preparationId,
    );
    expect(gateway.commitPrompt(
      promptingSubject,
      request,
      mismatchedPreparation.preparationId,
    )).toMatchObject({
      ok: false,
      code: "forbidden",
    });
    expect(gateway.commitPrompt(
      promptingSubject,
      request,
      exactPreparation.preparationId,
    )).toMatchObject({
      ok: true,
    });
    expect(gateway.commitPrompt(
      promptingSubject,
      request,
      exactPreparation.preparationId,
    )).toMatchObject({
      ok: false,
      code: "forbidden",
    });
    expect(queued()).toBe(1);
    store.close();
  });

  it("expires and bounds one-time prompt preparations", async () => {
    let now = Date.parse("2030-01-01T00:00:00.000Z");
    const {
      store,
      gateway,
      subject,
      firstConversation,
      queued,
    } = fixture(() => new Date(now));
    const promptingSubject: RemoteAuthorizationSubject = {
      ...subject,
      scopes: ["view", "prompt"],
    };
    const request = {
      type: "prompt.send" as const,
      requestId: crypto.randomUUID(),
      deliveryId: crypto.randomUUID(),
      conversationId: firstConversation.id,
      content: "Expire this preparation",
    };
    const expired = await gateway.preparePrompt(promptingSubject, request);
    if (!("preparationId" in expired)) {
      throw new Error("Prompt was not prepared");
    }
    now += 15_001;
    expect(gateway.commitPrompt(
      promptingSubject,
      request,
      expired.preparationId,
    )).toMatchObject({ ok: false, code: "forbidden" });

    for (
      let index = 0;
      index < REMOTE_LIMITS.sessions
        * REMOTE_LIMITS.inFlightRequestsPerSession;
      index += 1
    ) {
      expect(await gateway.preparePrompt(promptingSubject, {
        ...request,
        requestId: crypto.randomUUID(),
        deliveryId: crypto.randomUUID(),
        content: `Pending prompt ${index}`,
      })).toHaveProperty("preparationId");
    }
    expect(await gateway.preparePrompt(promptingSubject, {
      ...request,
      requestId: crypto.randomUUID(),
      deliveryId: crypto.randomUUID(),
      content: "One prompt too many",
    })).toMatchObject({ ok: false, code: "busy" });
    expect(queued()).toBe(0);
    store.close();
  });

  it("bounds readiness work and invalidates an overlapping retry", async () => {
    const base = fixture();
    const release = deferred();
    let readinessCalls = 0;
    const gateway = new RemoteRuntimeGateway({
      shell: () => base.store.shellSnapshot(),
      detail: (conversationId) =>
        base.store.conversationDetail(conversationId),
      isConversationActive: () => false,
      preparePrompt: async () => {
        readinessCalls += 1;
        await release.promise;
      },
      queuePrompt: () => ({ turnId: "must-not-queue" }),
      remotePromptSafety: () => remotePromptSafetyForHarness("codex-app-server"),
      now: () => new Date("2030-01-01T00:00:00.000Z"),
    });
    const subject: RemoteAuthorizationSubject = {
      ...base.subject,
      scopes: ["view", "prompt"],
    };
    const request = {
      type: "prompt.send" as const,
      requestId: crypto.randomUUID(),
      deliveryId: crypto.randomUUID(),
      conversationId: base.firstConversation.id,
      content: "Latest preparation wins",
    };
    const first = gateway.preparePrompt(subject, request);
    const second = gateway.preparePrompt(subject, request);
    const remaining = Array.from(
      {
        length:
          REMOTE_LIMITS.sessions
          * REMOTE_LIMITS.inFlightRequestsPerSession
          - 2,
      },
      (_, index) => gateway.preparePrompt(subject, {
        ...request,
        requestId: crypto.randomUUID(),
        deliveryId: crypto.randomUUID(),
        content: `Bound readiness ${index}`,
      }),
    );
    expect(readinessCalls).toBe(
      REMOTE_LIMITS.sessions * REMOTE_LIMITS.inFlightRequestsPerSession,
    );
    expect(await gateway.preparePrompt(subject, {
      ...request,
      requestId: crypto.randomUUID(),
      deliveryId: crypto.randomUUID(),
      content: "Capacity must reject before readiness",
    })).toMatchObject({ ok: false, code: "busy" });
    expect(readinessCalls).toBe(
      REMOTE_LIMITS.sessions * REMOTE_LIMITS.inFlightRequestsPerSession,
    );

    release.resolve();
    expect(await first).toMatchObject({ ok: false, code: "forbidden" });
    expect(await second).toHaveProperty("preparationId");
    await expect(Promise.all(remaining)).resolves.toHaveLength(
      REMOTE_LIMITS.sessions
        * REMOTE_LIMITS.inFlightRequestsPerSession
        - 2,
    );
    base.store.close();
  });

  it("does not queue when Supervised access widens during readiness", async () => {
    const race = promptRaceFixture();
    const response = race.gateway.preparePrompt(
      race.promptingSubject,
      race.request,
    );
    await race.entered;
    race.setDetail({
      ...race.detail()!,
      conversation: {
        ...race.detail()!.conversation,
        accessMode: "full",
      },
    });
    race.release();

    expect(await response).toMatchObject({
      ok: false,
      code: "forbidden",
    });
    expect(race.queueCalls()).toBe(0);
    race.store.close();
  });

  it("does not queue when project authority changes during readiness", async () => {
    const race = promptRaceFixture();
    const response = race.gateway.preparePrompt(
      race.promptingSubject,
      race.request,
    );
    await race.entered;
    race.setDetail({
      ...race.detail()!,
      conversation: {
        ...race.detail()!.conversation,
        projectId: race.secondProject.id,
      },
    });
    race.release();

    expect(await response).toMatchObject({
      ok: false,
      code: "not-found",
    });
    expect(race.queueCalls()).toBe(0);
    race.store.close();
  });

  it("does not queue when a conversation disappears during readiness", async () => {
    const race = promptRaceFixture();
    const response = race.gateway.preparePrompt(
      race.promptingSubject,
      race.request,
    );
    await race.entered;
    race.setDetail(null);
    race.release();

    expect(await response).toMatchObject({
      ok: false,
      code: "not-found",
    });
    expect(race.queueCalls()).toBe(0);
    race.store.close();
  });

  it("does not prepare when a conversation is archived during readiness", async () => {
    const race = promptRaceFixture();
    const response = race.gateway.preparePrompt(
      race.promptingSubject,
      race.request,
    );
    await race.entered;
    race.setDetail({
      ...race.detail()!,
      conversation: {
        ...race.detail()!.conversation,
        archivedAt: new Date().toISOString(),
      },
    });
    race.release();

    expect(await response).toMatchObject({
      ok: false,
      code: "not-found",
    });
    expect(race.queueCalls()).toBe(0);
    race.store.close();
  });

  it("does not queue when a local run starts during readiness", async () => {
    const race = promptRaceFixture();
    const response = race.gateway.preparePrompt(
      race.promptingSubject,
      race.request,
    );
    await race.entered;
    race.setActive(true);
    race.release();

    expect(await response).toMatchObject({
      ok: false,
      code: "busy",
    });
    expect(race.queueCalls()).toBe(0);
    race.store.close();
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
      const response = await sendPrompt(gateway, promptingSubject, {
        type: "prompt.send",
        requestId: crypto.randomUUID(),
        deliveryId: index === 0 ? firstDeliveryId : crypto.randomUUID(),
        conversationId: firstConversation.id,
        content: `Prompt ${index}`,
      });
      expect(response).toMatchObject({ ok: true });
    }
    expect(queued()).toBe(REMOTE_LIMITS.deliveryReceipts + 1);

    expect(await sendPrompt(gateway, promptingSubject, {
      type: "prompt.send",
      requestId: crypto.randomUUID(),
      deliveryId: firstDeliveryId,
      conversationId: firstConversation.id,
      content: "Prompt 0",
    })).toMatchObject({ ok: true });
    expect(queued()).toBe(REMOTE_LIMITS.deliveryReceipts + 2);
    store.close();
  });

  it("rejects a replayed receipt once the grant drops the project", async () => {
    const { store, gateway, subject, firstProject, firstConversation, secondProject } =
      fixture();
    const promptingSubject: RemoteAuthorizationSubject = {
      ...subject,
      scopes: ["view", "prompt"],
    };
    const deliveryId = crypto.randomUUID();
    const request = {
      type: "prompt.send" as const,
      requestId: crypto.randomUUID(),
      deliveryId,
      conversationId: firstConversation.id,
      content: "Keep going",
    };
    expect(await sendPrompt(gateway, promptingSubject, request))
      .toMatchObject({ ok: true });

    const reducedSubject: RemoteAuthorizationSubject = {
      ...promptingSubject,
      projectIds: [secondProject.id],
      grants: remoteConversationGrantsFromProjectIds([secondProject.id]),
      grantVersion: 2,
    };
    expect(await gateway.preparePrompt(reducedSubject, {
      ...request,
      requestId: crypto.randomUUID(),
    })).toMatchObject({ ok: false, code: "not-found" });

    expect(firstProject.id).not.toBe(secondProject.id);
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
      remotePromptSafety: () => remotePromptSafetyForHarness("codex-app-server"),
    });

    const response = await gateway.request(subject, {
      type: "state.get",
      requestId: crypto.randomUUID(),
    });
    const responseBytes = new TextEncoder().encode(
      JSON.stringify(response),
    ).byteLength;
    expect(responseBytes).toBeGreaterThan(
      REMOTE_LIMITS.plaintextBytes - 1_024,
    );
    expect(responseBytes).toBeLessThanOrEqual(REMOTE_LIMITS.plaintextBytes);
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
      content: "😀".repeat(index === 199 ? 32_768 : 128),
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
      remotePromptSafety: () => remotePromptSafetyForHarness("codex-app-server"),
    });

    const response = await gateway.request(subject, {
      type: "conversation.get",
      requestId: crypto.randomUUID(),
      conversationId: firstConversation.id,
      ifNoneMatch: null,
    });
    expect(new TextEncoder().encode(JSON.stringify(response)).byteLength)
      .toBeLessThanOrEqual(REMOTE_LIMITS.plaintextBytes);
    expect(remoteResponseSchema.parse(response)).toEqual(response);
    if (
      response.ok
      && response.result.kind === "conversation"
      && response.result.validator
    ) {
      expect(response.result.detail.messages.at(-1)?.id).toBe(
        "large-message-199",
      );
      expect(response.result.detail.messages.length).toBeLessThan(200);
    } else throw new Error("Missing bounded conditional conversation.");

    const hostKeys = await generateRemoteKeyPair();
    const deviceKeys = await generateRemoteKeyPair();
    const hostId = crypto.randomUUID();
    const deviceId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const sender = await createAuthenticatedSessionSender(
      hostId,
      deviceId,
      sessionId,
      await importRemoteKeyPair(hostKeys),
      await importRemotePublicKey(deviceKeys.publicKey),
    );
    const recipient = await createAuthenticatedSessionRecipient(
      hostId,
      deviceId,
      sessionId,
      await importRemoteKeyPair(deviceKeys),
      await importRemotePublicKey(hostKeys.publicKey),
      sender.enc,
    );
    const frame = await sealSessionData(sender, sessionId, response);
    expect(encodedRemoteFrameBytes(frame)).toBeLessThanOrEqual(
      REMOTE_LIMITS.encryptedFrameBytes,
    );
    const connectionId = crypto.randomUUID();
    const fullEnvelopeBytes = new TextEncoder().encode(JSON.stringify({
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      type: "relay.frame",
      connectionId,
      frame,
    })).byteLength;
    expect(fullEnvelopeBytes).toBeLessThanOrEqual(
      REMOTE_LIMITS.relayEnvelopeBytes,
    );
    expect(remoteResponseSchema.parse(
      await openSessionData(recipient, frame),
    )).toEqual(response);

    const unchangedResponse = await gateway.request(subject, {
      type: "conversation.get",
      requestId: crypto.randomUUID(),
      conversationId: firstConversation.id,
      ifNoneMatch: response.result.validator,
    });
    expect(unchangedResponse).toMatchObject({
      ok: true,
      result: { kind: "not-modified" },
    });
    const unchangedFrame = await sealSessionData(
      sender,
      sessionId,
      unchangedResponse,
    );
    const unchangedEnvelopeBytes = new TextEncoder().encode(JSON.stringify({
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      type: "relay.frame",
      connectionId,
      frame: unchangedFrame,
    })).byteLength;
    expect(remoteResponseSchema.parse(
      await openSessionData(recipient, unchangedFrame),
    )).toEqual(unchangedResponse);
    expect(unchangedEnvelopeBytes).toBeLessThan(1_024);
    expect(fullEnvelopeBytes - unchangedEnvelopeBytes).toBeGreaterThan(
      90 * 1_024,
    );
    store.close();
  }, 30_000);
});
