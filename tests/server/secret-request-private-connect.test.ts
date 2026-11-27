import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SECRET_REQUEST_TOOL_NAME } from "../../src/node/agent-secrets";
import { agentSecretFilePath, agentSecretRoot } from "../../src/server/runtime/agent-secrets/secret-files";
import { PrivateConnectRuntimeGateway } from "../../src/server/private-connect/runtime-gateway";
import { privateConnectStoreReads } from "../../src/server/private-connect/store-detail";
import { RuntimeStore } from "../../src/server/database";
import { AgentSecretService } from "../../src/server/runtime/agent-secrets/agent-secret-service";
import type { ProviderHostToolCall } from "../../src/server/provider/contracts";
import type { AppSnapshot, RuntimeMutationEvent } from "../../src/shared/contracts";
import type { PrivateConnectRuntimeAuthorization } from "../../src/shared/private-connect/runtime-contract";
import { privateConnectRuntimeGrantsFromProjectIds } from "../../src/shared/private-connect/runtime-grants";
import { connectRuntime } from "../support/runtime-event-queue";
import {
  cleanupTurnControllerTestDirectories,
  createTurnControllerTestRuntime,
} from "../support/turn-controller-runtime";
import { startTestRuntime } from "../support/test-runtime";
import type { RunningRuntime } from "../../src/server";

const SECRET = "fake-token-kQ9xZ2mB7vN4pL1sR8tW";
const directories: string[] = [];
const runtimes: RunningRuntime[] = [];

afterEach(async () => {
  await cleanupTurnControllerTestDirectories();
  for (const runtime of runtimes.splice(0)) {
    await runtime.close().catch(() => undefined);
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function secretCall(signal = new AbortController().signal): ProviderHostToolCall {
  return {
    providerThreadId: "thread",
    providerTurnId: "turn",
    toolCallId: randomUUID(),
    tool: SECRET_REQUEST_TOOL_NAME,
    arguments: {
      title: "Production API key",
      description: "Paste your API key in the local Inertia desktop window.",
    },
    signal,
    requestApproval: async () => "approve",
  };
}

describe("Private Connect status & ConversationShell for pending secret waits", () => {
  it("reports pendingInput on shell snapshots and waitingForLocalAction on Private Connect conversation.get while a secret card is open", async () => {
    const runtime = await createTurnControllerTestRuntime({}, { id: randomUUID });
    const service = new AgentSecretService({
      store: runtime.store,
      dataDirectory: runtime.directory,
      turns: runtime.controller.secretRequests,
      broadcast: (event: RuntimeMutationEvent) => runtime.events.push(event),
      waitMs: () => 60_000,
    });
    service.start();
    try {
      const queued = runtime.controller.queue({
        conversationId: runtime.conversationId,
        content: "Deploy the release.",
      });
      expect(runtime.controller.start(queued.turn.id)).toBe(true);
      const conversation = runtime.store.conversation(runtime.conversationId);
      const turn = runtime.store.agentTurn(queued.turn.id);

      const shell = (): AppSnapshot => {
        const snapshot = runtime.store.shellSnapshot();
        const pendingSecrets = service.pendingConversationIds();
        return {
          ...snapshot,
          conversations: snapshot.conversations.map((item) => ({
            ...item,
            pendingInput: pendingSecrets.has(item.id),
          })),
        };
      };

      const gateway = new PrivateConnectRuntimeGateway({
        shell,
        ...privateConnectStoreReads(runtime.store),
        isConversationActive: (id) => runtime.controller.isActive(id),
        preparePrompt: async () => undefined,
        queuePrompt: () => ({ turnId: turn.id }),
        inputs: () => [],
      });
      const subject: PrivateConnectRuntimeAuthorization = {
        deviceId: "11111111-1111-4111-8111-111111111111",
        sessionId: "22222222-2222-4222-8222-222222222222",
        scopes: ["view", "prompt"],
        projectIds: [conversation.projectId],
        grants: privateConnectRuntimeGrantsFromProjectIds([conversation.projectId]),
        grantVersion: 1,
        expiresAt: "2030-01-01T00:00:00.000Z",
      };

      const pendingCall = service.invoke({ conversation, turn }, secretCall());
      const [pending] = runtime.store.transcriptRepository.secretRequests.pendingAll();
      expect(pending).toBeDefined();
      expect(service.pendingCount()).toBe(1);
      expect(shell().conversations.find(({ id }) => id === conversation.id)?.pendingInput).toBe(true);

      const stateResponse = await gateway.request(subject, {
        type: "state.get",
        requestId: randomUUID(),
      });
      expect(stateResponse.ok).toBe(true);
      if (!stateResponse.ok || stateResponse.result.kind !== "state") throw new Error("expected state");
      const projected = stateResponse.result.state.conversations.find(({ id }) => id === conversation.id);
      expect(projected?.status).toBe("needs-input");

      const detailResponse = await gateway.request(subject, {
        type: "conversation.get",
        requestId: randomUUID(),
        conversationId: conversation.id,
      });
      expect(detailResponse.ok).toBe(true);
      if (!detailResponse.ok || detailResponse.result.kind !== "conversation") throw new Error("expected detail");
      expect(detailResponse.result.detail.waitingForLocalAction).toBe(true);
      expect(detailResponse.result.detail.questions).toEqual([]);
      expect(detailResponse.result.detail.inputRequestId).toBeNull();
      expect(JSON.stringify(detailResponse)).not.toContain(SECRET);

      // Deliver secret -> pendingInput and waitingForLocalAction clear immediately.
      await service.deliver({
        conversationId: conversation.id,
        requestId: pending!.id,
        secret: SECRET,
        vaulted: false,
      });
      await pendingCall;

      expect(service.pendingCount()).toBe(0);
      expect(shell().conversations.find(({ id }) => id === conversation.id)?.pendingInput).toBe(false);

      const clearedDetail = await gateway.request(subject, {
        type: "conversation.get",
        requestId: randomUUID(),
        conversationId: conversation.id,
      });
      expect(clearedDetail.ok).toBe(true);
      if (!clearedDetail.ok || clearedDetail.result.kind !== "conversation") throw new Error("expected detail");
      expect(clearedDetail.result.detail.waitingForLocalAction).toBe(false);
    } finally {
      service.shutdown();
      runtime.store.close();
    }
  });

  it("awaits initial secret restore before publishing runtime.ready in startRuntime", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-secret-startup-ready-"));
    directories.push(root);
    const dataDirectory = join(root, "data");
    const workspace = join(root, "workspace");
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(workspace, { recursive: true });

    let resolved = false;
    const store = new RuntimeStore(join(dataDirectory, "inertia.sqlite"), workspace, { recoverInterruptedRuns: false });
    let requestId: string;
    try {
      const project = store.createProject("Restore", workspace);
      const conversation = store.createConversation(project.id, "Restore chat");
      const turn = store.beginAgentTurn({
        conversationId: conversation.id,
        runId: randomUUID(),
        content: "Use key",
        providerId: "codex",
        modelSelection: conversation.modelSelection,
        reasoningEffort: "",
        interactionMode: "build",
        accessMode: "supervised",
        configurationRevision: 0,
        association: "authoritative",
      }).turn;
      const created = store.transcriptRepository.secretRequests.create({
        conversationId: conversation.id,
        runId: turn.runId,
        turnId: turn.id,
        providerId: "codex",
        title: "Deploy key",
        description: "Vaulted deploy key.",
        fileName: "deploy-key",
        ttlHours: 24,
      });
      requestId = created.request.id;
      store.transcriptRepository.secretRequests.transition(requestId, ["pending"], "saved", {
        fileToken: "a".repeat(32),
        expiresAt: new Date(Date.now() + 12 * 60 * 60_000).toISOString(),
        vaulted: true,
      });
    } finally {
      store.close();
    }

    const runtime = await startTestRuntime({
      dataDirectory,
      defaultWorkspacePath: workspace,
      enableProviders: false,
      runtimeGenerationId: "00000000-0000-4000-8000-000000000199:1",
      systemBootId: "test:00000000-0000-4000-8000-000000000199",
      backendCredentials: {
        resolve: async () => {
          await new Promise((resolve) => setTimeout(resolve, 40));
          resolved = true;
          return SECRET;
        },
        has: async () => true,
        status: async () => ({ hasSecret: true, credentialGeneration: "gen-1" }),
        clear: async () => true,
        forget: async () => true,
      },
    });
    runtimes.push(runtime);
    expect(resolved).toBe(true);
    const restoredPath = agentSecretFilePath(agentSecretRoot(dataDirectory), "a".repeat(32), "deploy-key");
    expect(existsSync(restoredPath)).toBe(true);
    expect(readFileSync(restoredPath, "utf8")).toBe(SECRET);

    // Verify websocket snapshot works cleanly and exposes lifecycleDiagnostics.interactionCount.
    const { socket, events } = await connectRuntime(runtime.websocketUrl);
    try {
      const snapshotEvent = await events.next(
        (event): event is Extract<typeof event, { type: "snapshot.updated" }> => event.type === "snapshot.updated",
        "initial snapshot",
      );
      expect(snapshotEvent.snapshot.lifecycleDiagnostics?.ownedResources.interactions).toBe(0);
      expect(snapshotEvent.snapshot.lifecycleDiagnostics?.unresolvedInteractionCount).toBe(0);
    } finally {
      socket.close();
    }
  }, 30_000);
});
