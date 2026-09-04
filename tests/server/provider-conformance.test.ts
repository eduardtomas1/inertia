// @inertia-test-suite portable
import { describe, expect, it } from "vitest";

import {
  AgentHarnessRegistry,
  ProviderManager,
  createDefaultAgentHarnessRegistry,
  type AgentHarness,
  type AgentHarnessRun,
  type ProviderManagerOptions,
  type ProviderRunInput,
  type ProviderRunResult,
  type ProviderSteerInput,
} from "../../src/server/providers";
import { createAgentHarnessEmitter } from "../../src/server/provider/agent-harness";
import { providerRunTerminal } from "../../src/server/provider/contracts";
import {
  MODEL_CAPABILITY_IDS,
  modelSelectionSchema,
  withModelSelectionFastMode,
  type ModelBackendProfile,
} from "../../src/shared/model-routing";
import { backendCompatibilityProbeResultSchema } from
  "../../src/shared/backend-probe";
import { ProviderInstallationLeaseCoordinator } from
  "../../src/server/provider/installation-lease";
import type { TurnProviderRuntime } from "../../src/server/runtime/turns/turn-controller-types";
import { nativeProviderRunInput } from "./model-route-fixture";
import { backendProbeTestAuthority } from "../helpers/backend-probe-authority";

const PRODUCTION_HARNESSES = createDefaultAgentHarnessRegistry()
  .list()
  .map((harness) => ({
    providerId: harness.providerId,
    harnessId: harness.id,
    capabilities: harness.capabilities,
  }));

function bindProbeToDetectedInstallation(
  manager: ProviderManager,
  providerId: ProviderRunInput["providerId"],
  probe: ReturnType<typeof backendCompatibilityProbeResultSchema.parse>,
): void {
  const installationFingerprint = manager.providerInstallationFingerprint(providerId);
  expect(installationFingerprint).not.toBeNull();
  manager.removeBackendProbeResults(probe.profileId);
  manager.recordBackendProbeResult({
    ...probe,
    authority: {
      ...probe.authority!,
      installationFingerprint,
    },
  });
}

function inputFor(
  route: (typeof PRODUCTION_HARNESSES)[number],
): ProviderRunInput {
  return nativeProviderRunInput({
    providerId: route.providerId,
    harnessId: route.harnessId,
    conversationId: `conversation-${route.providerId}`,
    runId: `run-${route.providerId}`,
    turnId: `turn-${route.providerId}`,
    cwd: "/workspace",
    prompt: "Verify exact lifecycle identity",
    interactionMode: "build",
    access: "supervised",
  });
}

function inactiveExtension(
  harnessId: AgentHarness["id"],
  observations: {
    approvals: string[];
    inputs: string[];
    steers: ProviderSteerInput[];
  },
): AgentHarnessRun["extension"] {
  const acceptedApprovals = new Set<string>();
  const acceptedInputs = new Set<string>();
  const respondToApproval = (requestId: string): boolean => {
    if (requestId !== "approval-1" || acceptedApprovals.has(requestId)) {
      return false;
    }
    acceptedApprovals.add(requestId);
    observations.approvals.push(requestId);
    return true;
  };
  const respondToInput = (requestId: string): boolean => {
    if (requestId !== "input-1" || acceptedInputs.has(requestId)) return false;
    acceptedInputs.add(requestId);
    observations.inputs.push(requestId);
    return true;
  };
  const steer = async (input: ProviderSteerInput): Promise<boolean> => {
    observations.steers.push(input);
    return true;
  };
  if (harnessId === "codex-app-server") {
    return {
      kind: "codex-app-server",
      respondToApproval,
      respondToInput,
      steer,
      setGoal: async () => {
        throw new Error("Not exercised by lifecycle conformance.");
      },
      clearGoal: async () => false,
    };
  }
  if (
    harnessId === "claude-agent-sdk"
    || harnessId === "cursor-acp"
    || harnessId === "kimi-acp"
    || harnessId === "opencode-sdk"
  ) {
    return {
      kind: harnessId,
      respondToApproval,
      respondToInput,
      steer,
    };
  }
  return {
    kind: "cli",
    providerId: harnessId === "codex-cli"
      ? "codex"
      : harnessId === "claude-cli"
        ? "claude"
        : harnessId === "cursor-cli"
          ? "cursor"
          : "opencode",
  };
}

function controlledManager(
  route: (typeof PRODUCTION_HARNESSES)[number],
  returnedProviderId: ProviderRunInput["providerId"] = route.providerId,
  attestInstallation = false,
  resolveBackendLaunchOptions?: ProviderManagerOptions["resolveBackendLaunchOptions"],
  additionalOptions: ProviderManagerOptions = {},
) {
  let emit!: NonNullable<Parameters<AgentHarness["start"]>[0]["callbacks"]>["onEvent"];
  let resolve!: (result: ProviderRunResult) => void;
  let reject!: (error: Error) => void;
  const cancellations: boolean[] = [];
  const starts: Parameters<AgentHarness["start"]>[0][] = [];
  const observations = {
    approvals: [] as string[],
    inputs: [] as string[],
    steers: [] as ProviderSteerInput[],
  };
  const harness: AgentHarness = {
    id: route.harnessId,
    providerId: route.providerId,
    capabilities: route.capabilities,
    supports: () => true,
    start: (options) => {
      starts.push(options);
      return {
        harnessId: route.harnessId,
        providerId: returnedProviderId,
        result: new Promise<ProviderRunResult>((accept, fail) => {
          emit = options.callbacks?.onEvent;
          resolve = accept;
          reject = fail;
        }),
        cancel: (force) => cancellations.push(force),
        extension: inactiveExtension(route.harnessId, observations),
      };
    },
  };
  return {
    cancellations,
    starts,
    observations,
    emit: (event: Parameters<NonNullable<typeof emit>>[0]) => emit?.(event),
    manager: ProviderManager.createForTests(
      {
        ...additionalOptions,
        cancelGraceMs: 30_000,
        resolveBackendLaunchOptions,
        ...(attestInstallation
          ? {
              commands: {
                [route.providerId]: `/tools/${route.providerId}`,
              },
              installationLeases:
                new ProviderInstallationLeaseCoordinator(),
              detectProvider: async () => ({
                provider: {
                  id: route.providerId,
                  name: route.providerId,
                  command: route.providerId,
                },
                available: true,
                version: "1.0.0",
                executable: `/tools/${route.providerId}`,
                installState: "installed" as const,
                authState: "authenticated" as const,
                canRun: true,
                cleanupConfirmed: true,
              }),
            }
          : {}),
      },
      new AgentHarnessRegistry([harness]),
    ),
    reject: (error: Error) => reject(error),
    resolve: (result: ProviderRunResult) => resolve(result),
  };
}

function compileTimeProviderContractAssertions(): void {
  type RunIdentity = Pick<ProviderRunInput, "conversationId" | "runId" | "turnId">;
  type TerminalIdentity = Pick<
    ProviderRunResult,
    "providerId" | "conversationId" | "runId" | "turnId" | "terminalReason" | "cleanupConfirmed"
  >;
  type RequiredOwnershipProbe = Pick<TurnProviderRuntime, "ownsRun" | "stopOwned">;

  // @ts-expect-error runId is mandatory for every production run.
  const missingRunId: RunIdentity = { conversationId: "conversation", turnId: "turn" };
  // @ts-expect-error terminal results must carry exact identity and outcome.
  const missingTerminalIdentity: TerminalIdentity = {
    providerId: "codex",
    conversationId: "conversation",
    cleanupConfirmed: true,
  };
  // @ts-expect-error production runtimes must expose both exact ownership operations.
  const missingOwnershipProbe: RequiredOwnershipProbe = {};
  // @ts-expect-error emitters cannot infer lifecycle identity.
  createAgentHarnessEmitter("codex", "conversation", {});
  // @ts-expect-error production construction requires installation authority.
  const missingInstallationAuthority = ProviderManager.createProduction({});
  // @ts-expect-error direct construction cannot bypass the production factory.
  const directConstruction = new ProviderManager();
  void missingRunId;
  void missingTerminalIdentity;
  void missingOwnershipProbe;
  void missingInstallationAuthority;
  void directConstruction;
}

describe("production provider lifecycle conformance", () => {
  it("fails closed when production construction lacks installation authority", () => {
    expect(() => ProviderManager.createProduction(
      {} as Parameters<typeof ProviderManager.createProduction>[0],
    )).toThrow(/requires installation authority/u);
  });

  it("keeps legacy CLI harnesses on their sunset path outside the production registry", () => {
    expect(PRODUCTION_HARNESSES.map(({ harnessId }) => harnessId)).toEqual([
      "codex-app-server",
      "claude-agent-sdk",
      "cursor-acp",
      "kimi-acp",
      "opencode-sdk",
    ]);
    expect(PRODUCTION_HARNESSES.some(({ harnessId }) => harnessId.endsWith("-cli")))
      .toBe(false);
  });

  it.each(PRODUCTION_HARNESSES)(
    "$harnessId preserves exact callback and terminal identity",
    async (route) => {
      const controlled = controlledManager(route);
      const input = inputFor(route);
      const text: string[] = [];
      const running = controlled.manager.run(input, {
        onText: (event) => text.push(event.text),
      });
      const base = {
        providerId: input.providerId,
        conversationId: input.conversationId,
        runId: input.runId,
        turnId: input.turnId,
      };

      expect(controlled.manager.ownsRun(input.conversationId, {
        runId: input.runId,
        turnId: input.turnId,
      })).toBe(true);
      expect(controlled.manager.ownsRun(input.conversationId, {
        runId: `${input.runId}-wrong`,
        turnId: input.turnId,
      })).toBe(false);
      expect(controlled.starts).toHaveLength(1);
      expect(controlled.starts[0]?.providerNativeToolsAvailable).toBe(true);
      controlled.emit({ ...base, type: "text", text: "accepted" });
      controlled.emit({ ...base, type: "text", text: "" });
      controlled.emit({ ...base, type: "text", text: "accepted" });
      controlled.emit({ ...base, runId: `${input.runId}-old`, type: "text", text: "rejected" });
      controlled.emit({ ...base, turnId: `${input.turnId}-old`, type: "text", text: "rejected" });
      controlled.resolve({
        ...providerRunTerminal(input, "completed"),
        text: "accepted",
        textTruncated: false,
        exitCode: 0,
        signal: null,
        cleanupConfirmed: true,
      });

      await expect(running).resolves.toMatchObject({
        ...base,
        status: "completed",
        terminalReason: {
          outcome: "completed",
          reason: "provider-completed",
        },
      });
      controlled.emit({ ...base, type: "text", text: "late" });
      expect(text).toEqual(["accepted", "", "accepted"]);
    },
  );

  it("keeps a text-only custom Claude backend inside its exact probe ceiling with native tools disabled", async () => {
    const route = PRODUCTION_HARNESSES.find(
      ({ harnessId }) => harnessId === "claude-agent-sdk",
    )!;
    const profile: ModelBackendProfile = {
      id: "custom:text-only",
      displayName: "Text-only Messages",
      protocol: "anthropic-messages",
      authenticationMode: "api-key",
      source: "custom",
      enabled: true,
      configurationRevision: 4,
      endpointIdentity: "endpoint:text-only:4",
    };
    const modelSelection = modelSelectionSchema.parse({
      ...inputFor(route).modelSelection,
      backendProfileId: profile.id,
      backendProfileDisplayName: profile.displayName,
      modelId: "text-model",
      backendConfigurationRevision: profile.configurationRevision,
      // The run payload is not capability authority. Deliberately forge rich
      // claims here to prove the manager consults its exact stored probe.
      capabilities: MODEL_CAPABILITY_IDS.map((id) => ({
        id,
        state: "verified" as const,
        provenance: "probe" as const,
        detail: null,
      })),
    });
    const checkedAt = "2031-03-02T01:02:03.000Z";
    const probe = backendCompatibilityProbeResultSchema.parse({
      profileId: profile.id,
      backendConfigurationRevision: profile.configurationRevision,
      endpointIdentity: profile.endpointIdentity,
      protocol: profile.protocol,
      modelId: modelSelection.modelId,
      compatibility: "partially-compatible",
      protocolVerified: true,
      modelVerified: true,
      capabilities: MODEL_CAPABILITY_IDS.map((id) => ({
        id,
        state: id === "streaming" ? "verified" : "unknown",
        provenance: id === "streaming" ? "probe" : "unknown",
        detail: null,
        checkedAt,
      })),
      contextWindow: {
        tokens: null,
        state: "unknown",
        provenance: "unknown",
        detail: null,
        checkedAt,
      },
      failure: null,
      checkedAt,
      authority: backendProbeTestAuthority(checkedAt),
    });
    const controlled = controlledManager(
      route,
      route.providerId,
      true,
      undefined,
      {
        backendProfiles: [profile],
        backendProbeResults: [probe],
        backendProbeNow: () => new Date(checkedAt),
      },
    );
    await controlled.manager.detect(route.providerId);
    bindProbeToDetectedInstallation(controlled.manager, route.providerId, probe);
    const resolved = controlled.manager.resolveModelRoute(modelSelection);
    const input: ProviderRunInput = {
      ...inputFor(route),
      backendProfile: resolved.backendProfile,
      backendCompatibility: resolved.compatibility,
      modelSelection,
      continuationIdentity: resolved.continuationIdentity,
      model: modelSelection.modelId,
    };

    expect(resolved.compatibility).toMatchObject({
      state: "partially-compatible",
      provenance: "probe",
    });
    expect(resolved.continuationIdentity.providerCompatibilityToken ?? null)
      .toBeNull();
    expect(controlled.manager.providerCapabilityAvailable(
      input,
      "text-streaming",
    )).toBe(true);
    for (const capabilityId of [
      "images",
      "goals",
      "plans",
      "approvals",
      "compaction",
      "host-tool-bridge",
    ] as const) {
      expect(controlled.manager.providerCapabilityAvailable(
        input,
        capabilityId,
        capabilityId === "host-tool-bridge" ? [capabilityId] : [],
      )).toBe(false);
      expect(controlled.manager.providerCapabilityAdmissible(
        input,
        capabilityId,
        capabilityId === "host-tool-bridge" ? [capabilityId] : [],
      )).toBe(false);
    }

    expect(() => controlled.manager.run({
      ...input,
      imagePaths: ["/workspace/image.png"],
    })).toThrow(/does not attest 'images'/u);
    expect(() => controlled.manager.run({
      ...input,
      goalStart: { objective: "Unprobed goal" },
    })).toThrow(/native goal start request is invalid/u);
    expect(() => controlled.manager.run({
      ...input,
      reasoningEffort: "high",
      modelSelection: {
        ...input.modelSelection,
        reasoningEffort: "high",
      },
    })).toThrow(/does not attest 'reasoning'/u);
    expect(() => controlled.manager.run({
      ...input,
      sessionId: "session-for-unprobed-compaction",
      operation: { kind: "compact" },
    })).toThrow(/does not attest 'session-resume'/u);
    expect(() => controlled.manager.run(input, {
      hostTools: {} as never,
    })).toThrow(/does not attest 'host-tool-bridge'/u);
    expect(() => controlled.manager.run({
      ...input,
      interactionMode: "plan",
    })).toThrow(/does not attest 'plans'/u);
    expect(() => controlled.manager.run({
      ...input,
      model: "different-model",
    })).toThrow(/exact probed model identity/u);
    expect(controlled.starts).toHaveLength(0);

    const text: string[] = [];
    const running = controlled.manager.run(input, {
      onText: (event) => text.push(event.text),
    });
    expect(controlled.starts).toHaveLength(1);
    expect(controlled.starts[0]?.providerNativeToolsAvailable).toBe(false);
    expect(controlled.starts[0]?.hostTools).toBeUndefined();
    const exact = {
      providerId: "claude" as const,
      conversationId: input.conversationId,
      runId: input.runId,
      turnId: input.turnId,
    };
    controlled.emit({ ...exact, type: "text", text: "verified text" });
    controlled.emit({
      ...exact,
      type: "extension",
      extension: "claude-agent-sdk",
      event: {
        type: "plan",
        explanation: null,
        steps: [],
      },
    });
    controlled.resolve({
      ...providerRunTerminal(input, "completed"),
      text: "verified text",
      textTruncated: false,
      exitCode: 0,
      signal: null,
      cleanupConfirmed: true,
    });
    await expect(running).rejects.toThrow(
      "Provider protocol violation: 'plans' is not attested",
    );
    expect(text).toEqual(["verified text"]);
    expect(controlled.cancellations).toEqual([false]);
  });

  it("rejects a text-only custom Codex route before native tools can start, even in the test factory", () => {
    const route = PRODUCTION_HARNESSES.find(
      ({ harnessId }) => harnessId === "codex-app-server",
    )!;
    const profile: ModelBackendProfile = {
      id: "custom:codex-text-only",
      displayName: "Text-only Responses",
      protocol: "openai-responses",
      authenticationMode: "api-key",
      source: "custom",
      enabled: true,
      configurationRevision: 7,
      endpointIdentity: "endpoint:codex-text-only:7",
    };
    const modelSelection = modelSelectionSchema.parse({
      ...inputFor(route).modelSelection,
      backendProfileId: profile.id,
      backendProfileDisplayName: profile.displayName,
      modelId: "text-model",
      backendConfigurationRevision: profile.configurationRevision,
    });
    const checkedAt = "2031-03-02T02:03:04.000Z";
    const probe = backendCompatibilityProbeResultSchema.parse({
      profileId: profile.id,
      backendConfigurationRevision: profile.configurationRevision,
      endpointIdentity: profile.endpointIdentity,
      protocol: profile.protocol,
      modelId: modelSelection.modelId,
      compatibility: "partially-compatible",
      protocolVerified: true,
      modelVerified: true,
      capabilities: MODEL_CAPABILITY_IDS.map((id) => ({
        id,
        state: id === "streaming" ? "verified" : "unknown",
        provenance: id === "streaming" ? "probe" : "unknown",
        detail: null,
        checkedAt,
      })),
      contextWindow: {
        tokens: null,
        state: "unknown",
        provenance: "unknown",
        detail: null,
        checkedAt,
      },
      failure: null,
      checkedAt,
      authority: backendProbeTestAuthority(checkedAt),
    });
    const controlled = controlledManager(
      route,
      route.providerId,
      false,
      undefined,
      {
        backendProfiles: [profile],
        backendProbeResults: [probe],
        backendProbeNow: () => new Date(checkedAt),
      },
    );
    const resolved = controlled.manager.resolveModelRoute(modelSelection);
    const input: ProviderRunInput = {
      ...inputFor(route),
      backendProfile: resolved.backendProfile,
      backendCompatibility: resolved.compatibility,
      modelSelection,
      continuationIdentity: resolved.continuationIdentity,
      model: modelSelection.modelId,
    };

    expect(resolved.compatibility).toMatchObject({
      state: "unavailable",
      reasonCode: "responses-tools-unverified",
    });

    expect(controlled.manager.providerCapabilityAvailable(
      input,
      "text-streaming",
    )).toBe(false);
    expect(controlled.manager.providerCapabilityAvailable(
      input,
      "provider-native-tools",
    )).toBe(false);
    expect(() => controlled.manager.run(input)).toThrow(
      /does not attest 'provider-native-tools'/u,
    );
    expect(controlled.starts).toHaveLength(0);
  });

  it("rejects a custom launch resolver that switches away from the probed model", async () => {
    const route = PRODUCTION_HARNESSES.find(
      ({ harnessId }) => harnessId === "claude-agent-sdk",
    )!;
    const profile: ModelBackendProfile = {
      id: "custom:model-boundary",
      displayName: "Model-bound Messages",
      protocol: "anthropic-messages",
      authenticationMode: "api-key",
      source: "custom",
      enabled: true,
      configurationRevision: 8,
      endpointIdentity: "endpoint:model-boundary:8",
    };
    const modelSelection = modelSelectionSchema.parse({
      ...inputFor(route).modelSelection,
      backendProfileId: profile.id,
      backendProfileDisplayName: profile.displayName,
      modelId: "model-b",
      backendConfigurationRevision: profile.configurationRevision,
    });
    const checkedAt = "2031-03-02T03:04:05.000Z";
    const probe = backendCompatibilityProbeResultSchema.parse({
      profileId: profile.id,
      backendConfigurationRevision: profile.configurationRevision,
      endpointIdentity: profile.endpointIdentity,
      protocol: profile.protocol,
      modelId: modelSelection.modelId,
      compatibility: "partially-compatible",
      protocolVerified: true,
      modelVerified: true,
      capabilities: MODEL_CAPABILITY_IDS.map((id) => ({
        id,
        state: id === "streaming" ? "verified" : "unknown",
        provenance: id === "streaming" ? "probe" : "unknown",
        detail: null,
        checkedAt,
      })),
      contextWindow: {
        tokens: null,
        state: "unknown",
        provenance: "unknown",
        detail: null,
        checkedAt,
      },
      failure: null,
      checkedAt,
      authority: backendProbeTestAuthority(checkedAt),
    });
    const controlled = controlledManager(
      route,
      route.providerId,
      true,
      () => ({ environment: {}, modelArgument: "model-a" }),
      {
        backendProfiles: [profile],
        backendProbeResults: [probe],
        backendProbeNow: () => new Date(checkedAt),
      },
    );
    await controlled.manager.detect(route.providerId);
    bindProbeToDetectedInstallation(controlled.manager, route.providerId, probe);
    const resolved = controlled.manager.resolveModelRoute(modelSelection);
    const input: ProviderRunInput = {
      ...inputFor(route),
      backendProfile: resolved.backendProfile,
      backendCompatibility: resolved.compatibility,
      modelSelection,
      continuationIdentity: resolved.continuationIdentity,
      model: modelSelection.modelId,
    };

    expect(() => controlled.manager.run(input)).toThrow(
      /exact probed model identity/u,
    );
    expect(controlled.starts).toHaveLength(0);
  });

  it.each(PRODUCTION_HARNESSES)(
    "$harnessId serializes repeated cancellation and exact cleanup",
    async (route) => {
      const controlled = controlledManager(route);
      const input = inputFor(route);
      const running = controlled.manager.run(input);

      expect(controlled.manager.cancel(input.conversationId)).toBe(true);
      expect(controlled.manager.cancel(input.conversationId)).toBe(false);
      expect(controlled.cancellations).toEqual([false]);
      controlled.resolve({
        ...providerRunTerminal(input, "cancelled"),
        text: "",
        textTruncated: false,
        exitCode: null,
        signal: null,
        cleanupConfirmed: true,
      });

      await expect(running).resolves.toMatchObject({
        status: "cancelled",
        cleanupConfirmed: true,
      });
      expect(controlled.manager.isRunning(input.conversationId)).toBe(false);
    },
  );

  it.each(PRODUCTION_HARNESSES)(
    "$harnessId retains a bounded exact cleanup receipt across result/stop races",
    async (route) => {
      const controlled = controlledManager(route);
      const input = inputFor(route);
      const running = controlled.manager.run(input);
      controlled.resolve({
        ...providerRunTerminal(input, "completed"),
        text: "done",
        textTruncated: false,
        exitCode: 0,
        signal: null,
        cleanupConfirmed: true,
      });

      await expect(running).resolves.toMatchObject({
        status: "completed",
        cleanupConfirmed: true,
      });
      await expect(controlled.manager.stopOwned(input.conversationId, {
        runId: input.runId,
        turnId: input.turnId,
      })).resolves.toBe("settled");
      await expect(controlled.manager.stopOwned(input.conversationId, {
        runId: `${input.runId}-stale`,
        turnId: input.turnId,
      })).resolves.toBe("missing");
    },
  );

  it.each(PRODUCTION_HARNESSES)(
    "$harnessId cancels before asynchronous launch without spawning",
    async (route) => {
      let releaseLaunch!: () => void;
      const launchGate = new Promise<void>((resolve) => {
        releaseLaunch = resolve;
      });
      const controlled = controlledManager(
        route,
        route.providerId,
        false,
        async (_input, environment) => {
          await launchGate;
          return { environment };
        },
      );
      const input = inputFor(route);
      const running = controlled.manager.run(input);

      expect(controlled.manager.cancel(input.conversationId)).toBe(true);
      releaseLaunch();
      await expect(running).resolves.toMatchObject({
        status: "cancelled",
        cleanupConfirmed: true,
      });
      expect(controlled.cancellations).toEqual([]);
      expect(controlled.manager.isRunning(input.conversationId)).toBe(false);
    },
  );

  it.each(PRODUCTION_HARNESSES)(
    "$harnessId binds interaction response, replay, and cancellation to the exact run",
    async (route) => {
      const controlled = controlledManager(route);
      const input = inputFor(route);
      const running = controlled.manager.run(input);
      const exact = { runId: input.runId, turnId: input.turnId };

      expect(controlled.manager.respondToApproval(
        input.conversationId,
        "approval-1",
        "approve",
        { ...exact, runId: `${input.runId}-old` },
      )).toBe(false);
      expect(controlled.manager.respondToApproval(
        input.conversationId,
        "unknown",
        "approve",
        exact,
      )).toBe(false);
      expect(controlled.manager.respondToApproval(
        input.conversationId,
        "approval-1",
        "approve",
        exact,
      )).toBe(true);
      expect(controlled.manager.respondToApproval(
        input.conversationId,
        "approval-1",
        "approve",
        exact,
      )).toBe(false);
      expect(controlled.manager.respondToInput(
        input.conversationId,
        "input-1",
        { answer: ["yes"] },
        { ...exact, turnId: `${input.turnId}-old` },
      )).toBe(false);
      expect(controlled.manager.respondToInput(
        input.conversationId,
        "input-1",
        { answer: ["yes"] },
        exact,
      )).toBe(true);
      expect(controlled.observations).toMatchObject({
        approvals: ["approval-1"],
        inputs: ["input-1"],
      });
      expect(controlled.manager.cancel(input.conversationId)).toBe(true);
      expect(controlled.manager.respondToInput(
        input.conversationId,
        "input-after-cancel",
        {},
        exact,
      )).toBe(false);
      controlled.resolve({
        ...providerRunTerminal(input, "cancelled"),
        text: "",
        textTruncated: false,
        exitCode: null,
        signal: null,
        cleanupConfirmed: true,
      });
      await running;
    },
  );

  it.each(PRODUCTION_HARNESSES)(
    "$harnessId applies its declared follow-up exception at the exact run",
    async (route) => {
      const controlled = controlledManager(route, route.providerId, true);
      const input = inputFor(route);
      await controlled.manager.detect(route.providerId);
      const running = controlled.manager.run(input);
      const followUp = { content: "continue", imagePaths: [] };
      const supportsFollowUp = [
        "codex-app-server",
        "claude-agent-sdk",
        "opencode-sdk",
      ].includes(route.harnessId);

      await expect(controlled.manager.steer(
        input.conversationId,
        followUp,
        { runId: `${input.runId}-old`, turnId: input.turnId },
      )).resolves.toBe(false);
      await expect(controlled.manager.steer(
        input.conversationId,
        followUp,
        { runId: input.runId, turnId: input.turnId },
      )).resolves.toBe(supportsFollowUp);
      expect(controlled.observations.steers).toHaveLength(
        supportsFollowUp ? 1 : 0,
      );
      controlled.resolve({
        ...providerRunTerminal(input, "completed"),
        text: "",
        textTruncated: false,
        exitCode: 0,
        signal: null,
        cleanupConfirmed: true,
      });
      await running;
    },
  );

  it.each(PRODUCTION_HARNESSES)(
    "$harnessId binds capability truth to exact detected version evidence",
    async (route) => {
      const controlled = controlledManager(route, route.providerId, true);
      const input = inputFor(route);
      expect(controlled.manager.providerCapabilityAvailable(
        input,
        "approvals",
      )).toBe(false);
      await controlled.manager.detect(route.providerId);
      expect(controlled.manager.providerCapabilityAvailable(
        input,
        "approvals",
      )).toBe(true);
      controlled.manager.setCommand(
        route.providerId,
        `/tools/${route.providerId}-replacement`,
      );
      expect(controlled.manager.providerCapabilityAvailable(
        input,
        "approvals",
      )).toBe(false);
      expect(() => controlled.manager.run({
        ...input,
        sessionId: "session-from-stale-installation",
      })).toThrow(/does not attest 'text-streaming'/u);
    },
  );

  it.each(PRODUCTION_HARNESSES.filter(({ harnessId }) =>
    harnessId === "cursor-acp" || harnessId === "kimi-acp"))(
    "$harnessId admits an exact negotiation attempt without advertising availability",
    async (route) => {
      const controlled = controlledManager(route, route.providerId, true);
      const input = inputFor(route);
      expect(controlled.manager.providerCapabilityAdmissible(
        input,
        "compaction",
      )).toBe(false);
      await controlled.manager.detect(route.providerId);
      expect(controlled.manager.providerCapabilityAvailable(
        input,
        "compaction",
      )).toBe(false);
      expect(controlled.manager.providerCapabilityAdmissible(
        input,
        "compaction",
      )).toBe(true);
    },
  );

  it.each(PRODUCTION_HARNESSES.filter(({ harnessId }) =>
    harnessId === "codex-app-server" || harnessId === "claude-agent-sdk"))(
    "$harnessId rejects first-session speed selection without exact-run evidence",
    async (route) => {
      for (const fast of [false, true]) {
        const controlled = controlledManager(route, route.providerId, true);
        const base = inputFor(route);
        const providerValue = route.providerId === "codex"
          ? "priority" as const
          : "fast" as const;
        const modelSelection = withModelSelectionFastMode(
          base.modelSelection,
          fast ? providerValue : null,
        );
        const input = {
          ...base,
          modelSelection,
          continuationIdentity: {
            ...base.continuationIdentity,
            performanceModeIdentity: fast
              ? `fast:${providerValue}`
              : null,
          },
          supportedFastMode: providerValue,
        };
        await controlled.manager.detect(route.providerId);
        const running = controlled.manager.run(input);
        controlled.resolve({
          ...providerRunTerminal(input, "completed"),
          text: "",
          textTruncated: false,
          exitCode: 0,
          signal: null,
          cleanupConfirmed: true,
        });

        await expect(running).rejects.toMatchObject({
          code: "invalid_input",
          message: expect.stringContaining("performance-modes"),
        });
      }
    },
  );

  it("accepts a negotiated Cursor event after an exact-run observation", async () => {
    const route = PRODUCTION_HARNESSES.find(
      ({ harnessId }) => harnessId === "cursor-acp",
    )!;
    const controlled = controlledManager(route, route.providerId, true);
    const input = inputFor(route);
    const requests: string[] = [];
    await controlled.manager.detect(route.providerId);
    const running = controlled.manager.run(input, {
      onInput: ({ request }) => requests.push(request.requestId),
    });
    const base = {
      providerId: "cursor" as const,
      conversationId: input.conversationId,
      runId: input.runId,
      turnId: input.turnId,
    };
    controlled.emit({
      ...base,
      type: "capability-observation",
      capabilityId: "structured-input",
      available: true,
    });
    controlled.emit({
      ...base,
      type: "extension",
      extension: "cursor-acp",
      event: {
        type: "input",
        request: {
          requestId: "input-1",
          questions: [],
          autoResolutionMs: null,
        },
      },
    });

    expect(requests).toEqual(["input-1"]);
    expect(controlled.manager.respondToInput(
      input.conversationId,
      "input-1",
      {},
      { runId: input.runId, turnId: input.turnId },
    )).toBe(true);
    controlled.resolve({
      ...providerRunTerminal(input, "completed"),
      text: "",
      textTruncated: false,
      exitCode: 0,
      signal: null,
      cleanupConfirmed: true,
    });
    await expect(running).resolves.toMatchObject({ status: "completed" });
  });

  it("does not admit negotiated evidence from a different run", async () => {
    const route = PRODUCTION_HARNESSES.find(
      ({ harnessId }) => harnessId === "cursor-acp",
    )!;
    const controlled = controlledManager(route, route.providerId, true);
    const input = inputFor(route);
    await controlled.manager.detect(route.providerId);
    const running = controlled.manager.run(input);
    const base = {
      providerId: "cursor" as const,
      conversationId: input.conversationId,
      runId: input.runId,
      turnId: input.turnId,
    };
    controlled.emit({
      ...base,
      runId: `${input.runId}-stale`,
      type: "capability-observation",
      capabilityId: "structured-input",
      available: true,
    });
    controlled.emit({
      ...base,
      type: "extension",
      extension: "cursor-acp",
      event: {
        type: "input",
        request: {
          requestId: "input-1",
          questions: [],
          autoResolutionMs: null,
        },
      },
    });
    controlled.resolve({
      ...providerRunTerminal(input, "cancelled"),
      text: "",
      textTruncated: false,
      exitCode: null,
      signal: null,
      cleanupConfirmed: true,
    });

    await expect(running).rejects.toMatchObject({ code: "invalid_input" });
    expect(controlled.cancellations).toContain(false);
  });

  it("rejects a completed ACP operation without exact-run capability evidence", async () => {
    const route = PRODUCTION_HARNESSES.find(
      ({ harnessId }) => harnessId === "cursor-acp",
    )!;
    const controlled = controlledManager(route, route.providerId, true);
    const input = {
      ...inputFor(route),
      sessionId: "cursor-session",
    };
    await controlled.manager.detect(route.providerId);
    const running = controlled.manager.run(input);
    controlled.resolve({
      ...providerRunTerminal(input, "completed"),
      text: "",
      textTruncated: false,
      exitCode: 0,
      signal: null,
      cleanupConfirmed: true,
    });

    await expect(running).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("session-resume"),
    });
    expect(controlled.manager.isRunning(input.conversationId)).toBe(false);
  });

  it("rejects a completed OpenCode image run without model evidence", async () => {
    const route = PRODUCTION_HARNESSES.find(
      ({ harnessId }) => harnessId === "opencode-sdk",
    )!;
    const controlled = controlledManager(route, route.providerId, true);
    const input = {
      ...inputFor(route),
      imagePaths: ["/workspace/reference.png"],
    };
    await controlled.manager.detect(route.providerId);
    const running = controlled.manager.run(input);
    controlled.resolve({
      ...providerRunTerminal(input, "completed"),
      text: "",
      textTruncated: false,
      exitCode: 0,
      signal: null,
      cleanupConfirmed: true,
    });

    await expect(running).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("images"),
    });
    expect(controlled.manager.isRunning(input.conversationId)).toBe(false);
  });

  it.each(PRODUCTION_HARNESSES.filter(({ harnessId }) =>
    harnessId === "codex-app-server" || harnessId === "claude-agent-sdk"))(
    "$harnessId rejects a completed speed transition without exact-run evidence",
    async (route) => {
      const controlled = controlledManager(route, route.providerId, true);
      const base = inputFor(route);
      const input = {
        ...base,
        sessionId: `${route.providerId}-standard-session`,
        supportedFastMode: route.providerId === "codex"
          ? "priority" as const
          : "fast" as const,
        performanceModeTransition: "to-standard" as const,
      };
      await controlled.manager.detect(route.providerId);
      const running = controlled.manager.run(input);
      controlled.resolve({
        ...providerRunTerminal(input, "completed"),
        text: "",
        textTruncated: false,
        exitCode: 0,
        signal: null,
        cleanupConfirmed: true,
      });

      await expect(running).rejects.toMatchObject({
        code: "invalid_input",
        message: expect.stringContaining("performance-modes"),
      });
      expect(controlled.manager.isRunning(input.conversationId)).toBe(false);
    },
  );

  it.each(PRODUCTION_HARNESSES)(
    "$harnessId keeps admission quarantined when terminal cleanup is unconfirmed",
    async (route) => {
      const controlled = controlledManager(route);
      const input = inputFor(route);
      const running = controlled.manager.run(input);
      controlled.resolve({
        ...providerRunTerminal(input, "failed"),
        text: "",
        textTruncated: false,
        exitCode: 1,
        signal: null,
        cleanupConfirmed: false,
      });

      await expect(running).resolves.toMatchObject({
        status: "failed",
        cleanupConfirmed: false,
      });
      expect(controlled.manager.isRunning(input.conversationId)).toBe(true);
      expect(() => controlled.manager.run(input)).toThrow(/already has an active/u);
    },
  );

  it.each(PRODUCTION_HARNESSES)(
    "$harnessId cancels and quarantines a stream that closes without terminal truth",
    async (route) => {
      const controlled = controlledManager(route);
      const input = inputFor(route);
      const running = controlled.manager.run(input);

      controlled.reject(new Error("provider transport closed"));
      await expect(running).rejects.toThrow("provider transport closed");
      expect(controlled.cancellations).toEqual([false]);
      expect(controlled.manager.isRunning(input.conversationId)).toBe(true);
      expect(() => controlled.manager.run(input)).toThrow(/already has an active/u);
    },
  );

  it.each(PRODUCTION_HARNESSES.filter(({ providerId }) =>
    providerId !== "codex"))(
    "$harnessId rejects an unattested provider-authored optional operation",
    async (route) => {
      const controlled = controlledManager(route, route.providerId, true);
      const input = inputFor(route);
      await controlled.manager.detect(route.providerId);
      const running = controlled.manager.run(input);
      const base = {
        providerId: input.providerId,
        conversationId: input.conversationId,
        runId: input.runId,
        turnId: input.turnId,
      };
      if (route.providerId === "claude") {
        controlled.emit({
          ...base,
          type: "goal-updated",
          sessionId: "session",
          goal: {
            objective: "unsupported",
            status: "active",
            tokenBudget: null,
            tokensUsed: 0,
            timeUsedSeconds: 0,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        });
      } else {
        controlled.emit({
          ...base,
          type: "subagent",
          sequence: 1,
          providerTaskId: "task",
          providerAgentId: null,
          parentProviderAgentId: null,
          parentProviderToolUseId: null,
          providerToolUseId: null,
          providerRole: null,
          providerName: null,
          status: "running",
          isLive: true,
          description: null,
          progress: null,
          result: null,
        });
      }
      controlled.resolve({
        ...providerRunTerminal(input, "cancelled"),
        text: "",
        textTruncated: false,
        exitCode: null,
        signal: null,
        cleanupConfirmed: true,
      });

      await expect(running).rejects.toMatchObject({ code: "invalid_input" });
      expect(controlled.cancellations).toContain(false);
      expect(controlled.manager.isRunning(input.conversationId)).toBe(false);
    },
  );

  it.each(PRODUCTION_HARNESSES)(
    "$harnessId quarantines a mismatched harness-run owner",
    (route) => {
      const mismatchedProvider = route.providerId === "codex"
        ? "claude"
        : "codex";
      const controlled = controlledManager(route, mismatchedProvider);
      const input = inputFor(route);

      expect(() => controlled.manager.run(input)).toThrowError(
        /mismatched run owner/u,
      );
      expect(controlled.cancellations).toEqual([false]);
      expect(controlled.manager.isRunning(input.conversationId)).toBe(true);
    },
  );

  it.each(PRODUCTION_HARNESSES)(
    "$harnessId quarantines a mismatched terminal owner",
    async (route) => {
      const controlled = controlledManager(route);
      const input = inputFor(route);
      const running = controlled.manager.run(input);
      controlled.resolve({
        ...providerRunTerminal(input, "completed"),
        runId: `${input.runId}-other`,
        text: "untrusted",
        textTruncated: false,
        exitCode: 0,
        signal: null,
        cleanupConfirmed: true,
      });

      await expect(running).rejects.toMatchObject({
        code: "lifecycle_corruption",
      });
      expect(controlled.cancellations).toEqual([false]);
      expect(controlled.manager.isRunning(input.conversationId)).toBe(true);
      expect(() => controlled.manager.run(input)).toThrowError(/already has an active provider run/u);
    },
  );

  it.each(PRODUCTION_HARNESSES)(
    "$harnessId quarantines inconsistent terminal truth",
    async (route) => {
      const controlled = controlledManager(route);
      const input = inputFor(route);
      const running = controlled.manager.run(input);
      controlled.resolve({
        ...providerRunTerminal(input, "completed"),
        terminalReason: {
          outcome: "cancelled",
          reason: "provider-cancelled",
        },
        text: "untrusted",
        textTruncated: false,
        exitCode: 0,
        signal: null,
        cleanupConfirmed: true,
      });

      await expect(running).rejects.toMatchObject({
        code: "lifecycle_corruption",
      });
      expect(controlled.cancellations).toEqual([false]);
      expect(controlled.manager.isRunning(input.conversationId)).toBe(true);
    },
  );

  it.each(PRODUCTION_HARNESSES)(
    "$harnessId rejects non-boolean cleanup evidence",
    async (route) => {
      const controlled = controlledManager(route);
      const input = inputFor(route);
      const running = controlled.manager.run(input);
      controlled.resolve({
        ...providerRunTerminal(input, "completed"),
        text: "untrusted",
        textTruncated: false,
        exitCode: 0,
        signal: null,
        cleanupConfirmed: "true" as unknown as true,
      });

      await expect(running).rejects.toMatchObject({
        code: "lifecycle_corruption",
      });
      expect(controlled.cancellations).toEqual([false]);
      expect(controlled.manager.isRunning(input.conversationId)).toBe(true);
    },
  );

  it("keeps exact identity fields mandatory at compile time", () => {
    expect(compileTimeProviderContractAssertions).toBeTypeOf("function");
  });
});
