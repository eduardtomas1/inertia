import { describe, expect, it } from "vitest";

import { parseRuntimeLifecycleDiagnosticSnapshot } from "../../src/shared/lifecycle-diagnostics";
import {
  runtimeLifecycleDiagnosticSnapshot,
  type RuntimeLifecycleDiagnosticInput,
} from "../../src/server/lifecycle-diagnostics";
import type { ContinuationReasonCode } from "../../src/shared/continuation-policy";
import {
  nativeModelSelection,
  providerNativeModelSelection,
  versionedContinuationIdentityForSelection,
} from "../../src/shared/model-routing";
import { lifecycleBuildMetadataFromEnvironment } from
  "../../src/shared/lifecycle-build-metadata";
import { PROVIDER_MAINTENANCE_PROVIDER_IDS } from
  "../../src/shared/provider-maintenance";

function diagnosticInput(): RuntimeLifecycleDiagnosticInput {
  return {
    runtimeGenerationId: "11111111-1111-4111-8111-111111111111:1",
    systemBootId: "22222222-2222-4222-8222-222222222222",
    runtimeStartedAt: "2030-01-01T00:00:00.000Z",
    runtimeSafetyLock: false,
    confirmedCleanupReceiptConsumed: false,
    providerInfo: [
      {
        id: "codex",
        label: "Codex",
        command: "codex",
        available: true,
        version: "1.2.3",
        executable: "/private/provider",
        installState: "installed",
        authState: "authenticated",
        canRun: true,
        statusMessage: null,
        models: [],
        rateLimits: [],
        metadataState: {
          models: {
            freshness: "fresh",
            provenance: "provider",
            updatedAt: "2030-01-01T00:00:00.000Z",
            lastAttemptedAt: "2030-01-01T00:00:00.000Z",
            refreshing: false,
          },
          rateLimits: {
            freshness: "fresh",
            provenance: "provider",
            updatedAt: "2030-01-01T00:00:00.000Z",
            lastAttemptedAt: "2030-01-01T00:00:00.000Z",
            refreshing: false,
          },
        },
        capabilityContract: {
          schemaVersion: 1,
          harnessId: "codex-app-server",
          manifestDigest: "a".repeat(64),
          installationVerified: true,
          installedVersion: "1.2.3",
          currentlyAvailableCount: 20,
          declaredCapabilityCount: 28,
          hostToolBridgeAvailable: true,
        },
      },
    ],
    conversations: [
      {
        id: "conversation-secret-id",
        projectId: "project-secret-id",
        title: "private prompt title",
        providerId: "codex",
        modelSelection: nativeModelSelection({
          providerId: "codex",
          modelId: "gpt-test",
          reasoningEffort: "high",
        }),
        continuationIdentity: null,
        model: "gpt-test",
        reasoningEffort: "high",
        interactionMode: "build",
        accessMode: "supervised",
        status: "running",
        attentionKind: null,
        branch: null,
        worktreePath: "/private/worktree",
        providerSessionId: null,
        archivedAt: null,
        settledAt: null,
        completedAt: null,
        lastViewedAt: null,
        createdAt: "2030-01-01T00:00:00.000Z",
        updatedAt: "2030-01-01T00:00:00.000Z",
        latestTurn: null,
        pendingApproval: false,
        pendingInput: false,
      },
    ],
    runs: [],
    providerMaintenanceStates: [],
    providerMaintenanceRecoveryCount: 0,
    selectedConversationId: "conversation-secret-id",
    activeConversationIds: ["conversation-secret-id"],
    runningProviderConversationIds: new Set(["conversation-secret-id"]),
    providerRunOwnershipConversationIds: ["conversation-secret-id"],
    terminalOwnershipCount: 0,
    interactionCount: 0,
    capturedAt: new Date("2030-01-01T00:00:05.000Z"),
  };
}

function recordContinuationReason(
  input: RuntimeLifecycleDiagnosticInput,
  continuationReasonCode: ContinuationReasonCode,
): void {
  const conversation = input.conversations[0]!;
  const modelSelection = conversation.modelSelection;
  input.conversations = [{
    ...conversation,
    latestTurn: {
      id: "turn-safe-id",
      runId: "run-safe-id",
      status: "completed",
      runState: {
        state: "completed",
        providerState: null,
        revision: 2,
      },
      providerId: conversation.providerId,
      harnessId: modelSelection.harnessId,
      backendProfileId: modelSelection.backendProfileId,
      modelSelection,
      continuationIdentity: versionedContinuationIdentityForSelection(
        modelSelection,
        null,
        false,
        "b".repeat(64),
      ),
      continuationReasonCode,
      model: modelSelection.modelId,
      reasoningEffort: modelSelection.reasoningEffort ?? "",
      requestedAt: "2030-01-01T00:00:01.000Z",
      startedAt: "2030-01-01T00:00:02.000Z",
      completedAt: "2030-01-01T00:00:04.000Z",
      terminalReason: "provider-completed",
      updatedAt: "2030-01-01T00:00:04.000Z",
    },
  }];
}

describe("runtime lifecycle diagnostics", () => {
  it("retains valid diagnostics for all six supported providers", () => {
    const input = diagnosticInput();
    input.conversations = PROVIDER_MAINTENANCE_PROVIDER_IDS.map((providerId) => ({
      ...input.conversations[0]!,
      id: providerId,
      providerId,
      modelSelection: providerNativeModelSelection({ providerId, modelId: "test" }),
    }));
    input.activeConversationIds = input.conversations.map(({ id }) => id);
    input.providerMaintenanceStates = PROVIDER_MAINTENANCE_PROVIDER_IDS.map(
      (providerId) => ({ providerId, state: "idle" }),
    );

    const snapshot = runtimeLifecycleDiagnosticSnapshot(input);

    expect(snapshot.activeProviders.map(({ providerId }) => providerId).sort())
      .toEqual([...PROVIDER_MAINTENANCE_PROVIDER_IDS].sort());
    expect(snapshot.providerMaintenance).toEqual(input.providerMaintenanceStates);
    expect(parseRuntimeLifecycleDiagnosticSnapshot(snapshot)).toEqual(snapshot);
  });

  it("projects bounded lifecycle evidence without raw identities or content", () => {
    const snapshot = runtimeLifecycleDiagnosticSnapshot(diagnosticInput());
    const serialized = JSON.stringify(snapshot);

    expect(parseRuntimeLifecycleDiagnosticSnapshot(snapshot)).toEqual(snapshot);
    expect(snapshot).toMatchObject({
      schemaVersion: 1,
      runtimeUptimeMs: 5_000,
      systemBootRelationship: "current",
      cleanupProofMethod: "current-generation-lease",
      actionableState: "safe-and-ready",
      unresolvedTurnCount: 1,
      activeProviders: [
        {
          providerId: "codex",
          harnessId: "codex-app-server",
          version: "1.2.3",
          capabilityManifestDigest: "a".repeat(64),
          installationVerified: true,
        },
      ],
    });
    expect(snapshot.runtimeGenerationHash).toMatch(/^[0-9a-f]{12}$/u);
    expect(snapshot.buildMetadata).toBeNull();
    expect(serialized).not.toContain("conversation-secret-id");
    expect(serialized).not.toContain("project-secret-id");
    expect(serialized).not.toContain("private prompt title");
    expect(serialized).not.toContain("/private/");
  });

  it("embeds only bounded GitHub Actions build provenance", () => {
    const sourceRevision = "ABCDEF0123456789ABCDEF0123456789ABCDEF01";
    const buildMetadata = lifecycleBuildMetadataFromEnvironment({
      GITHUB_ACTIONS: "true",
      GITHUB_SHA: sourceRevision,
      GITHUB_RUN_ID: "1234567890",
      GITHUB_RUN_ATTEMPT: "3",
      GITHUB_REF_TYPE: "tag",
      GITHUB_REF_NAME: "v1.2.3",
      GITHUB_WORKFLOW: "private workflow text",
      GITHUB_SERVER_URL: "https://example.invalid/private",
    });
    expect(buildMetadata).toEqual({
      source: "github-actions",
      sourceRevision: sourceRevision.toLowerCase(),
      runId: "1234567890",
      runAttempt: 3,
      releaseTag: "v1.2.3",
    });

    const input = diagnosticInput();
    input.buildMetadata = buildMetadata;
    const snapshot = runtimeLifecycleDiagnosticSnapshot(input);
    expect(snapshot.buildMetadata).toEqual(buildMetadata);
    expect(JSON.stringify(snapshot)).not.toContain("private workflow text");
    expect(JSON.stringify(snapshot)).not.toContain("example.invalid");
  });

  it("omits partial or attacker-shaped build environment values", () => {
    expect(lifecycleBuildMetadataFromEnvironment({
      GITHUB_ACTIONS: "true",
      GITHUB_SHA: "prompt=/home/person/private",
      GITHUB_RUN_ID: "run-secret",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_REF_TYPE: "branch",
      GITHUB_REF_NAME: "private/customer-name",
    })).toBeNull();
  });

  it("surfaces cleanup uncertainty as a finite actionable state", () => {
    const input = diagnosticInput();
    input.runtimeSafetyLock = true;
    input.runningProviderConversationIds = new Set();
    const snapshot = runtimeLifecycleDiagnosticSnapshot(input);

    expect(snapshot).toMatchObject({
      systemBootRelationship: "unresolved",
      cleanupProofMethod: "unconfirmed",
      quarantineReason: "prior-runtime-cleanup-unconfirmed",
      actionableState: "previous-runtime-cleanup-unconfirmed",
      startupBlockerCodes: [
        "prior-runtime-cleanup-unconfirmed",
        "provider-cleanup-pending",
      ],
    });
  });

  it("detects equal-count provider ownership with different identities", () => {
    const input = diagnosticInput();
    input.providerRunOwnershipConversationIds = ["stale-owner-secret-id"];
    input.runningProviderConversationIds = new Set([
      "different-running-secret-id",
    ]);
    const snapshot = runtimeLifecycleDiagnosticSnapshot(input);
    const serialized = JSON.stringify(snapshot);

    expect(snapshot).toMatchObject({
      startupBlockerCodes: ["provider-cleanup-pending"],
      actionableState: "waiting-for-provider-cleanup",
      ownedResources: { providerRuns: 1 },
    });
    expect(serialized).not.toContain("stale-owner-secret-id");
    expect(serialized).not.toContain("different-running-secret-id");
  });

  it("keeps malformed start-time input inside the strict diagnostic schema", () => {
    const input = diagnosticInput();
    input.runtimeStartedAt = "prompt=/home/person/private";
    const snapshot = runtimeLifecycleDiagnosticSnapshot(input);

    expect(snapshot.runtimeStartedAt).toBeNull();
    expect(snapshot.runtimeUptimeMs).toBe(0);
    expect(parseRuntimeLifecycleDiagnosticSnapshot(snapshot)).toEqual(snapshot);
    expect(JSON.stringify(snapshot)).not.toContain("person");
  });

  it("surfaces unresolved maintenance recovery as a quarantined startup lock", () => {
    const input = diagnosticInput();
    input.providerMaintenanceRecoveryCount = 2;
    const snapshot = runtimeLifecycleDiagnosticSnapshot(input);

    expect(snapshot).toMatchObject({
      startupBlockerCodes: ["provider-installation-quarantined"],
      quarantineReason: "provider-maintenance-recovery-required",
      actionableState: "recovery-requires-manual-attention",
      ownedResources: { maintenanceOperations: 2 },
    });
  });

  it("surfaces in-memory maintenance quarantine without installation identity", () => {
    const input = diagnosticInput();
    input.providerMaintenanceStates = [{
      providerId: "claude",
      state: "quarantined",
    }];
    const snapshot = runtimeLifecycleDiagnosticSnapshot(input);
    const serialized = JSON.stringify(snapshot);

    expect(snapshot).toMatchObject({
      startupBlockerCodes: ["provider-installation-quarantined"],
      quarantineReason: "provider-maintenance-quarantined",
      actionableState: "recovery-requires-manual-attention",
      ownedResources: { maintenanceOperations: 1 },
      providerMaintenance: [{
        providerId: "claude",
        state: "quarantined",
      }],
    });
    expect(serialized).not.toContain("installationIdentity");
    expect(serialized).not.toContain("/private/");
  });

  it.each([
    [
      "provider-installation-changed",
      "provider-installation-changed",
      "provider-installation-changed",
    ],
    [
      "backend-endpoint-changed",
      "session-resume-rejected-for-compatibility",
      null,
    ],
    ["first-turn", "safe-and-ready", null],
  ] as const)(
    "projects selected-turn continuation evidence for %s",
    (reasonCode, actionableState, quarantineReason) => {
      const input = diagnosticInput();
      recordContinuationReason(input, reasonCode);

      expect(runtimeLifecycleDiagnosticSnapshot(input)).toMatchObject({
        actionableState,
        quarantineReason,
      });
    },
  );

  it("rejects unknown keys and arbitrary provider-derived version text", () => {
    const snapshot = runtimeLifecycleDiagnosticSnapshot(diagnosticInput());
    expect(
      parseRuntimeLifecycleDiagnosticSnapshot({
        ...snapshot,
        prompt: "do not copy this",
      }),
    ).toBeNull();

    const input = diagnosticInput();
    input.providerInfo[0]!.version = "token=/home/person/private";
    expect(
      runtimeLifecycleDiagnosticSnapshot(input).activeProviders[0]?.version,
    ).toBeNull();
  });
});
