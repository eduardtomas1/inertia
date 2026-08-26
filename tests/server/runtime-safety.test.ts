import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { ConversationAttachmentStore } from "../../src/node/conversation-attachment-store";
import { RuntimeGenerationLeaseJournal } from "../../src/node/runtime-generation-leases";
import {
  captureModernDarwinRecoverySnapshot,
  ModernDarwinRecoveryAuthorityJournal,
} from "../../src/node/runtime-modern-recovery-authorities";
import {
  RuntimeOwnedProcessJournal,
  type DarwinProcessIdentity,
} from "../../src/node/runtime-owned-processes";
import { RuntimeStore } from "../../src/server/database";
import { RUNTIME_COMMAND_TYPES } from "../../src/server/runtime/commands/command-router";
import {
  RUNTIME_SAFETY_READ_COMMAND_TYPES,
  runtimeSafetyAllowsCommand,
} from "../../src/server/runtime/commands/runtime-safety";
import { startTestRuntime } from "../support/test-runtime";

describe("runtime recovery safety command boundary", () => {
  it("defaults every command except exact conversation detail reads to denied", () => {
    const allowed = RUNTIME_COMMAND_TYPES.filter(runtimeSafetyAllowsCommand);
    expect(allowed).toEqual([...RUNTIME_SAFETY_READ_COMMAND_TYPES]);
    expect(RUNTIME_COMMAND_TYPES).toHaveLength(
      RUNTIME_COMMAND_TYPES.filter((type) => !runtimeSafetyAllowsCommand(type))
        .length + RUNTIME_SAFETY_READ_COMMAND_TYPES.length,
    );
  });

  it("preserves durable attachments while prior-runtime cleanup is unconfirmed", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-runtime-safety-"));
    const dataDirectory = join(root, "data");
    const workspaceDirectory = join(root, "workspace");
    mkdirSync(workspaceDirectory);
    const attachmentId = randomUUID();
    const attachmentStore = await ConversationAttachmentStore.open(dataDirectory);
    await attachmentStore.retain([{
      attachment: {
        id: attachmentId,
        name: "preserved.png",
        path: attachmentId,
        mimeType: "image/png",
        size: 8,
      },
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    }]);
    const reconcile = vi.spyOn(
      ConversationAttachmentStore.prototype,
      "reconcile",
    );
    try {
      const runtime = await startTestRuntime({
        dataDirectory,
        defaultWorkspacePath: workspaceDirectory,
        enableProviders: false,
        priorRuntimeCleanupUnconfirmed: true,
        runtimeGenerationId: "00000000-0000-4000-8000-000000000001:1",
        systemBootId: "test:00000000-0000-4000-8000-000000000001",
      });
      try {
        expect(reconcile).not.toHaveBeenCalled();
        await expect(attachmentStore.preview(attachmentId)).resolves
          .toMatchObject({
            attachment: { id: attachmentId },
            bytes: Buffer.from([
              0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
            ]),
          });
      } finally {
        await runtime.close();
      }
    } finally {
      reconcile.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("retires only receipt-bound legacy ownership and reconciles its run as interrupted", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-runtime-safety-"));
    const dataDirectory = join(root, "data");
    const workspaceDirectory = join(root, "workspace");
    const databasePath = join(dataDirectory, "inertia.sqlite");
    const legacyGenerationId =
      "20000000-0000-4000-8000-000000000002:7";
    const currentGenerationId =
      "30000000-0000-4000-8000-000000000003:8";
    const currentBootId =
      "test:00000000-0000-4000-8000-000000000001";
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(workspaceDirectory);
    const seed = new RuntimeStore(databasePath, workspaceDirectory, {
      recoverInterruptedRuns: false,
    });
    const project = seed.createProject("Legacy runtime", workspaceDirectory);
    const conversation = seed.createConversation(project.id, "Interrupted legacy run");
    const userMessage = seed.createMessage(conversation.id, "Continue safely");
    const turn = seed.createAgentTurn({
      id: "legacy-runtime-turn",
      conversationId: conversation.id,
      runId: "legacy-runtime-run",
      userMessageId: userMessage.id,
      providerId: "codex",
      harnessId: "codex-app-server",
      backendProfileId: "codex-local",
      model: "gpt-test",
      reasoningEffort: "high",
      interactionMode: "build",
      accessMode: "supervised",
      configurationRevision: 0,
      association: "authoritative",
    });
    seed.updateAgentTurnLifecycle(turn.id, { status: "running" });
    seed.updateConversation(conversation.id, { status: "running" });
    seed.providerRunOwnership.record(
      turn.id,
      conversation.id,
      turn.runId,
      legacyGenerationId,
      "unavailable",
      new Date().toISOString(),
    );
    seed.close();
    expect(new RuntimeGenerationLeaseJournal(dataDirectory).publish(
      legacyGenerationId,
      "unavailable",
    )).toBe(true);
    const consumed = vi.fn();

    try {
      const runtime = await startTestRuntime({
        dataDirectory,
        defaultWorkspacePath: workspaceDirectory,
        enableProviders: false,
        runtimeGenerationId: currentGenerationId,
        systemBootId: currentBootId,
        manuallyRetiredRuntimeGenerationIds: [legacyGenerationId],
        onLegacyRecoveryAuthorityConsumed: consumed,
      });
      await runtime.close();

      expect(consumed).toHaveBeenCalledWith(
        legacyGenerationId,
        currentGenerationId,
      );
      const reopened = new RuntimeStore(databasePath, workspaceDirectory, {
        recoverInterruptedRuns: false,
      });
      expect(reopened.providerRunOwnership.all()).toEqual([]);
      expect(reopened.agentTurn(turn.id)).toMatchObject({
        status: "interrupted",
        terminalReason: "runtime-restart",
        runState: {
          state: "interrupted",
          providerState: "runtime-restart",
        },
      });
      reopened.close();
      const retainedLeases = new RuntimeGenerationLeaseJournal(dataDirectory)
        .all();
      expect(retainedLeases.some(({ runtimeGenerationId }) =>
        runtimeGenerationId === legacyGenerationId)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts a missing legacy lease only as an idempotent authority replay", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-runtime-safety-"));
    const dataDirectory = join(root, "data");
    const workspaceDirectory = join(root, "workspace");
    mkdirSync(workspaceDirectory);
    const consumed = vi.fn();
    try {
      const runtime = await startTestRuntime({
        dataDirectory,
        defaultWorkspacePath: workspaceDirectory,
        enableProviders: false,
        runtimeGenerationId: "30000000-0000-4000-8000-000000000003:9",
        systemBootId: "test:00000000-0000-4000-8000-000000000001",
        manuallyRetiredRuntimeGenerationIds: [
          "20000000-0000-4000-8000-000000000002:8",
        ],
        onLegacyRecoveryAuthorityConsumed: consumed,
      });
      await runtime.close();
      expect(consumed).toHaveBeenCalledOnce();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reconciles the maximum legacy batch through the reserved current lease", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-runtime-safety-"));
    const dataDirectory = join(root, "data");
    const workspaceDirectory = join(root, "workspace");
    const legacyGenerationIds = Array.from({ length: 32 }, (_, index) => (
      `20000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}:1`
    ));
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(workspaceDirectory);
    const leases = new RuntimeGenerationLeaseJournal(dataDirectory);
    for (const generationId of legacyGenerationIds) {
      expect(leases.publish(generationId, "unavailable")).toBe(true);
    }
    const consumed = vi.fn();
    try {
      const runtime = await startTestRuntime({
        dataDirectory,
        defaultWorkspacePath: workspaceDirectory,
        enableProviders: false,
        runtimeGenerationId: "30000000-0000-4000-8000-000000000003:12",
        systemBootId: "test:00000000-0000-4000-8000-000000000001",
        manuallyRetiredRuntimeGenerationIds: legacyGenerationIds,
        onLegacyRecoveryAuthorityConsumed: consumed,
      });
      await runtime.close();

      expect(consumed).toHaveBeenCalledTimes(32);
      expect(new RuntimeGenerationLeaseJournal(dataDirectory).all())
        .toEqual([
          expect.objectContaining({
            runtimeGenerationId:
              "30000000-0000-4000-8000-000000000003:12",
          }),
        ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("retains the legacy lease when interrupted-run recovery fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-runtime-safety-"));
    const dataDirectory = join(root, "data");
    const workspaceDirectory = join(root, "workspace");
    const legacyGenerationId =
      "20000000-0000-4000-8000-000000000002:10";
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(workspaceDirectory);
    expect(new RuntimeGenerationLeaseJournal(dataDirectory).publish(
      legacyGenerationId,
      "unavailable",
    )).toBe(true);
    try {
      await expect(startTestRuntime({
        dataDirectory,
        defaultWorkspacePath: workspaceDirectory,
        enableProviders: false,
        runtimeGenerationId: "30000000-0000-4000-8000-000000000003:11",
        systemBootId: "test:00000000-0000-4000-8000-000000000001",
        manuallyRetiredRuntimeGenerationIds: [legacyGenerationId],
        testOnlyBeforeLegacyInterruptedRecovery: () => {
          throw new Error("injected interrupted recovery failure");
        },
      })).rejects.toThrow("injected interrupted recovery failure");
      expect(new RuntimeGenerationLeaseJournal(dataDirectory).all())
        .toContainEqual(expect.objectContaining({
          runtimeGenerationId: legacyGenerationId,
          systemBootId: "unavailable",
        }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to manually retire a modern lease without mutating it", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-runtime-safety-"));
    const dataDirectory = join(root, "data");
    const workspaceDirectory = join(root, "workspace");
    const modernGenerationId =
      "20000000-0000-4000-8000-000000000002:9";
    const bootId = "test:00000000-0000-4000-8000-000000000001";
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(workspaceDirectory);
    expect(new RuntimeGenerationLeaseJournal(dataDirectory).publish(
      modernGenerationId,
      bootId,
    )).toBe(true);
    try {
      await expect(startTestRuntime({
        dataDirectory,
        defaultWorkspacePath: workspaceDirectory,
        enableProviders: false,
        runtimeGenerationId: "30000000-0000-4000-8000-000000000003:10",
        systemBootId: bootId,
        manuallyRetiredRuntimeGenerationIds: [modernGenerationId],
      })).rejects.toThrow("cannot retire a modern runtime lease");
      expect(new RuntimeGenerationLeaseJournal(dataDirectory).all())
        .toContainEqual(expect.objectContaining({
          runtimeGenerationId: modernGenerationId,
          systemBootId: bootId,
        }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reconciles mixed legacy and modern ownership before both DB-first acknowledgements", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-runtime-safety-"));
    const dataDirectory = join(root, "data");
    const workspaceDirectory = join(root, "workspace");
    const databasePath = join(dataDirectory, "inertia.sqlite");
    const legacyGeneration = "40000000-0000-4000-8000-000000000004:8";
    const modernGeneration = "40000000-0000-4000-8000-000000000004:9";
    const currentGeneration = "50000000-0000-4000-8000-000000000005:10";
    // A missing current OS boot probe must not demote a modern Darwin session
    // recorded while the probe worked into legacy recovery or bypass its exact
    // snapshot-bound acknowledgement.
    const bootId = "unavailable";
    const recordedModernBootId =
      "test:00000000-0000-4000-8000-000000000009";
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(workspaceDirectory);
    const leases = new RuntimeGenerationLeaseJournal(dataDirectory);
    expect(leases.publish(legacyGeneration, "unavailable")).toBe(true);
    expect(leases.publish(modernGeneration, recordedModernBootId)).toBe(true);
    expect(new RuntimeOwnedProcessJournal(dataDirectory, {
      platform: "darwin",
    }).startSession(modernGeneration, recordedModernBootId)).toBe(true);
    const snapshot = captureModernDarwinRecoverySnapshot(
      dataDirectory,
      bootId,
    );
    expect(snapshot).not.toBeNull();
    const modernDescriptor = snapshot
      ? new ModernDarwinRecoveryAuthorityJournal(dataDirectory)
        .publish(snapshot)
      : null;
    expect(modernDescriptor).not.toBeNull();
    expect(leases.publish(currentGeneration, bootId)).toBe(true);
    expect(new RuntimeOwnedProcessJournal(dataDirectory, {
      platform: "darwin",
    }).startSession(currentGeneration, bootId)).toBe(true);

    const seed = new RuntimeStore(databasePath, workspaceDirectory, {
      recoverInterruptedRuns: false,
    });
    const project = seed.createProject("Mixed recovery", workspaceDirectory);
    const turnIds: string[] = [];
    for (const [kind, generationId, generationBootId] of [
      ["legacy", legacyGeneration, "unavailable"],
      ["modern", modernGeneration, recordedModernBootId],
    ] as const) {
      const conversation = seed.createConversation(
        project.id,
        `${kind} interrupted run`,
      );
      const userMessage = seed.createMessage(
        conversation.id,
        `Continue ${kind} safely`,
      );
      const turn = seed.createAgentTurn({
        id: `${kind}-mixed-runtime-turn`,
        conversationId: conversation.id,
        runId: `${kind}-mixed-runtime-run`,
        userMessageId: userMessage.id,
        providerId: "codex",
        harnessId: "codex-app-server",
        backendProfileId: "codex-local",
        model: "gpt-test",
        reasoningEffort: "high",
        interactionMode: "build",
        accessMode: "supervised",
        configurationRevision: 0,
        association: "authoritative",
      });
      seed.updateAgentTurnLifecycle(turn.id, { status: "running" });
      seed.updateConversation(conversation.id, { status: "running" });
      seed.providerRunOwnership.record(
        turn.id,
        conversation.id,
        turn.runId,
        generationId,
        generationBootId,
        new Date().toISOString(),
      );
      turnIds.push(turn.id);
    }
    seed.close();

    const acknowledgements: Array<{
      kind: "legacy" | "modern";
      ownershipCount: number;
      turnStatuses: Array<string | undefined>;
    }> = [];
    const observeDatabase = (kind: "legacy" | "modern"): void => {
      const observed = new RuntimeStore(databasePath, workspaceDirectory, {
        recoverInterruptedRuns: false,
      });
      acknowledgements.push({
        kind,
        ownershipCount: observed.providerRunOwnership.all().length,
        turnStatuses: turnIds.map((turnId) => observed.agentTurn(turnId)?.status),
      });
      observed.close();
    };

    try {
      const runtime = await startTestRuntime({
        dataDirectory,
        defaultWorkspacePath: workspaceDirectory,
        enableProviders: false,
        runtimeGenerationId: currentGeneration,
        systemBootId: bootId,
        manuallyRetiredRuntimeGenerationIds: [legacyGeneration],
        manualModernDarwinRecovery: modernDescriptor!,
        onLegacyRecoveryAuthorityConsumed: () => observeDatabase("legacy"),
        onModernDarwinRecoveryAuthorityAcknowledged: () => {
          observeDatabase("modern");
        },
      });
      await runtime.close();

      expect(acknowledgements).toEqual([
        {
          kind: "legacy",
          ownershipCount: 0,
          turnStatuses: ["interrupted", "interrupted"],
        },
        {
          kind: "modern",
          ownershipCount: 0,
          turnStatuses: ["interrupted", "interrupted"],
        },
      ]);
      expect(new RuntimeGenerationLeaseJournal(dataDirectory).all())
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ runtimeGenerationId: modernGeneration }),
          expect.objectContaining({ runtimeGenerationId: currentGeneration }),
        ]));
      expect(new RuntimeGenerationLeaseJournal(dataDirectory).all())
        .not.toContainEqual(expect.objectContaining({
          runtimeGenerationId: legacyGeneration,
        }));
      expect(new ModernDarwinRecoveryAuthorityJournal(dataDirectory).pending())
        .toMatchObject({
          operationId: modernDescriptor!.operationId,
          snapshotDigest: modernDescriptor!.snapshotDigest,
        });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps exact modern leaves through a DB-first crash and replays the ACK idempotently", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-runtime-safety-"));
    const dataDirectory = join(root, "data");
    const workspaceDirectory = join(root, "workspace");
    const databasePath = join(dataDirectory, "inertia.sqlite");
    const oldGeneration = "40000000-0000-4000-8000-000000000004:1";
    const currentGeneration = "50000000-0000-4000-8000-000000000005:2";
    const currentBootId = "test:00000000-0000-4000-8000-000000000001";
    const pid = 701;
    const processIdentity: DarwinProcessIdentity = {
      platform: "darwin",
      pid,
      parentPid: 77,
      processGroupId: pid,
      sessionId: pid,
      startTimeSeconds: "1800000701",
      startTimeMicroseconds: 123_456,
    };
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(workspaceDirectory);
    const leases = new RuntimeGenerationLeaseJournal(dataDirectory);
    expect(leases.publish(oldGeneration, currentBootId)).toBe(true);
    const owned = new RuntimeOwnedProcessJournal(dataDirectory, {
      platform: "darwin",
      darwinGuardianPath: "/private/tmp/inertia-test-guardian",
      readDarwinIdentity: (target) => target === pid ? processIdentity : null,
    });
    expect(owned.startSession(oldGeneration, currentBootId)).toBe(true);
    const ownershipId = owned.begin(oldGeneration, currentBootId);
    owned.claim(ownershipId, oldGeneration, currentBootId, pid, 77);
    const oldSnapshot = captureModernDarwinRecoverySnapshot(
      dataDirectory,
      currentBootId,
    )!;
    const authorityJournal = new ModernDarwinRecoveryAuthorityJournal(
      dataDirectory,
    );
    const authorityDescriptor = authorityJournal.publish(oldSnapshot)!;
    // Main publishes the new supervised generation only after the exact old
    // snapshot is consent-bound.
    expect(leases.publish(currentGeneration, currentBootId)).toBe(true);
    expect(owned.startSession(currentGeneration, currentBootId)).toBe(true);

    const seed = new RuntimeStore(databasePath, workspaceDirectory, {
      recoverInterruptedRuns: false,
    });
    const project = seed.createProject("Modern recovery", workspaceDirectory);
    const conversation = seed.createConversation(project.id, "Interrupted run");
    const userMessage = seed.createMessage(conversation.id, "Continue safely");
    const turn = seed.createAgentTurn({
      id: "modern-runtime-turn",
      conversationId: conversation.id,
      runId: "modern-runtime-run",
      userMessageId: userMessage.id,
      providerId: "codex",
      harnessId: "codex-app-server",
      backendProfileId: "codex-local",
      model: "gpt-test",
      reasoningEffort: "high",
      interactionMode: "build",
      accessMode: "supervised",
      configurationRevision: 0,
      association: "authoritative",
    });
    seed.updateAgentTurnLifecycle(turn.id, { status: "running" });
    seed.updateConversation(conversation.id, { status: "running" });
    seed.providerRunOwnership.record(
      turn.id,
      conversation.id,
      turn.runId,
      oldGeneration,
      currentBootId,
      new Date().toISOString(),
    );
    seed.close();

    try {
      await expect(startTestRuntime({
        dataDirectory,
        defaultWorkspacePath: workspaceDirectory,
        enableProviders: false,
        runtimeGenerationId: currentGeneration,
        systemBootId: currentBootId,
        manualModernDarwinRecovery: authorityDescriptor,
        testOnlyBeforeModernDarwinRecoveryAcknowledged: () => {
          throw new Error("crash after provider ownership clear");
        },
      })).rejects.toThrow("crash after provider ownership clear");
      expect(new RuntimeGenerationLeaseJournal(dataDirectory).all())
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ runtimeGenerationId: oldGeneration }),
          expect.objectContaining({ runtimeGenerationId: currentGeneration }),
        ]));
      expect(new RuntimeOwnedProcessJournal(dataDirectory, {
        platform: "darwin",
      }).records(oldGeneration)).toHaveLength(1);
      const afterCrash = new RuntimeStore(databasePath, workspaceDirectory, {
        recoverInterruptedRuns: false,
      });
      expect(afterCrash.providerRunOwnership.all()).toEqual([]);
      expect(afterCrash.agentTurn(turn.id)?.status).toBe("running");
      afterCrash.close();

      const acknowledged = vi.fn();
      const runtime = await startTestRuntime({
        dataDirectory,
        defaultWorkspacePath: workspaceDirectory,
        enableProviders: false,
        runtimeGenerationId: currentGeneration,
        systemBootId: currentBootId,
        manualModernDarwinRecovery: authorityDescriptor,
        onModernDarwinRecoveryAuthorityAcknowledged: acknowledged,
      });
      await runtime.close();
      expect(acknowledged).toHaveBeenCalledWith(
        authorityDescriptor,
        currentGeneration,
      );
      expect(new RuntimeOwnedProcessJournal(dataDirectory, {
        platform: "darwin",
      }).records(oldGeneration)).toHaveLength(1);
      const afterReplay = new RuntimeStore(databasePath, workspaceDirectory, {
        recoverInterruptedRuns: false,
      });
      expect(afterReplay.agentTurn(turn.id)).toMatchObject({
        status: "interrupted",
        terminalReason: "runtime-restart",
      });
      afterReplay.close();

      const pending = new ModernDarwinRecoveryAuthorityJournal(dataDirectory)
        .pending()!;
      expect(new ModernDarwinRecoveryAuthorityJournal(dataDirectory)
        .beginRetirement(
          pending,
          dataDirectory,
          currentGeneration,
          {
            guardianPath: "/private/tmp/inertia-test-guardian",
            platform: "darwin",
            readDarwinIdentity: () => null,
            pidExists: () => false,
          },
        )).toBe(true);
      expect(new ModernDarwinRecoveryAuthorityJournal(dataDirectory)
        .completeRetirement(dataDirectory, pending)).toBe(true);
      expect(new RuntimeGenerationLeaseJournal(dataDirectory).all()).toEqual([
        expect.objectContaining({ runtimeGenerationId: currentGeneration }),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
