import type { AgentApprovalDecision } from "./interactions";
import type { AgentHarnessRun } from "./agent-harness";
import type { AgentHarnessRegistry } from "./agent-harness-registry";
import {
  providerCapabilityManifest,
  type ProviderCapabilityId,
} from "./capability-manifest";
import { validateProviderRunInput } from "./adapters";
import { PROVIDER_INFO } from "./catalog";
import {
  hasConsistentProviderTerminalOutcome,
  hasExactProviderRunIdentity,
  ProviderRuntimeError,
  providerRunIdentity,
  providerRunTerminal,
  providerTerminalOutcome,
  type ProviderBackendLaunchOptions,
  type ProviderCompactionResult,
  type ProviderEvent,
  type ProviderGoalMutation,
  type ProviderGoalSnapshot,
  type ProviderId,
  type ProviderManagerOptions,
  type ProviderRunCallbacks,
  type ProviderRunIdentity,
  type ProviderRunInput,
  type ProviderRunResult,
  type ProviderSteerInput,
} from "./contracts";
import {
  createProviderEmitter,
  providerCallbacksFromHarness,
} from "./emitter";
import type { ProviderMetadataCache } from "./metadata";
import { providerChildEnvironment } from "../environment";
import { nativeBackendProfile } from "../../shared/model-routing";
import { PROVIDER_COMPACTION_OPERATION_TIMEOUT_MS } from "../../shared/runtime-command-timeouts";

interface ProviderRunInstallationUse {
  release(): boolean;
  quarantine(reason: string): void;
}

interface ActiveRun {
  result: Promise<ProviderRunResult>;
  lifecycleSettlement: Promise<void>;
  resolveLifecycleSettlement: () => void;
  harnessRun: AgentHarnessRun | null;
  harnessStartInvoked: boolean;
  launchAbort: AbortController;
  markPendingCancellation: () => void;
  runId: string;
  turnId: string;
  input: ProviderRunInput;
  negotiatedCapabilities: Set<ProviderCapabilityId>;
  installationUse: ProviderRunInstallationUse;
  processCleanupConfirmed: boolean;
  cancelRequested: boolean;
  settled: boolean;
  detach: () => boolean;
  quarantine: (reason: string) => void;
  hardKillTimer?: NodeJS.Timeout;
}

export type OwnedProviderStopResult =
  | "missing"
  | "identity-mismatch"
  | "settled"
  | "force-detached";

export interface ProviderRunCoordinatorOptions {
  cancelGraceMs: number;
  harnessRegistry: AgentHarnessRegistry;
  metadataCache: ProviderMetadataCache;
  resolveBackendLaunchOptions:
    | ProviderManagerOptions["resolveBackendLaunchOptions"];
  commandFor(providerId: ProviderId): string;
  resolvedCommandFor(providerId: ProviderId): string | undefined;
  rememberResolvedCommand(providerId: ProviderId, executable: string): void;
  processEnvironment(): NodeJS.ProcessEnv | undefined;
  capabilityAvailable(
    input: ProviderRunInput,
    capabilityId: ProviderCapabilityId,
    configured?: readonly ProviderCapabilityId[],
    negotiated?: readonly ProviderCapabilityId[],
  ): boolean;
  capabilityAdmissible(
    input: ProviderRunInput,
    capabilityId: ProviderCapabilityId,
    configured?: readonly ProviderCapabilityId[],
  ): boolean;
  acquireInstallationUse(
    input: ProviderRunInput,
    executable: string,
  ): ProviderRunInstallationUse;
}

const MAX_OWNED_STOP_GRACE_MS = 30_000;
const FORCE_DETACH_GRACE_MS = 250;
const MAX_CLEANUP_RECEIPTS = 256;

function capabilitiesForEvent(
  event: ProviderEvent,
): readonly ProviderCapabilityId[] {
  switch (event.type) {
    case "text":
    case "text-snapshot":
      return ["text-streaming"];
    case "activity":
      return event.kind === "tool" || event.kind === "command"
        ? ["tool-activity"]
        : event.kind === "reasoning"
          ? ["reasoning"]
          : [];
    case "approval":
    case "approval-resolved":
      return ["approvals"];
    case "input":
    case "input-resolved":
      return ["structured-input"];
    case "plan":
      return ["plans"];
    case "goal-updated":
    case "goal-cleared":
      return ["goals"];
    case "reasoning-summary":
      return ["reasoning"];
    case "usage":
      return ["usage-tokens"];
    case "subagent":
      return ["subagent-create"];
    case "session":
      return ["native-session-id"];
    case "metadata":
      return [
        ...(event.metadata.models ? ["model-discovery" as const] : []),
        ...(event.metadata.rateLimits ? ["rate-limits" as const] : []),
      ];
    default:
      return [];
  }
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof value === "object"
    && value !== null
    && "then" in value
    && typeof (value as { then?: unknown }).then === "function";
}

/**
 * Owns the exact provider-run tuple from admission through terminal process
 * cleanup. ProviderManager retains discovery and installation policy while
 * this coordinator keeps all run-state transitions in one bounded component.
 */
export class ProviderRunCoordinator {
  private readonly activeRuns = new Map<string, ActiveRun>();
  /**
   * Bounded exact-owner receipts close the race where a provider result
   * confirms cleanup and removes its active entry immediately before the
   * lifecycle owner asks stopOwned() for the same barrier.
   */
  private readonly cleanupReceipts = new Map<string, ProviderRunIdentity>();

  constructor(private readonly options: ProviderRunCoordinatorOptions) {}

  isRunning(conversationId: string): boolean {
    return this.activeRuns.has(conversationId);
  }

  ownsRun(
    conversationId: string,
    identity: { runId: string; turnId: string },
  ): boolean {
    const active = this.activeRuns.get(conversationId);
    return Boolean(
      active
      && !active.settled
      && active.runId === identity.runId
      && active.turnId === identity.turnId,
    );
  }

  activeConversationIds(): string[] {
    return [...this.activeRuns.keys()];
  }

  run(
    input: ProviderRunInput,
    callbacks: ProviderRunCallbacks = {},
  ): Promise<ProviderRunResult> {
    const conversationId = validateProviderRunInput(input);
    if (this.activeRuns.has(conversationId)) {
      throw new ProviderRuntimeError(
        "already_running",
        "This conversation already has an active provider run.",
      );
    }
    if (
      input.backendProfile.source === "custom"
      && (
        input.modelSelection.modelId === "provider-default"
        || input.model !== input.modelSelection.modelId
      )
    ) {
      throw new ProviderRuntimeError(
        "invalid_input",
        "The custom backend run does not match the exact probed model identity.",
      );
    }
    const providerId = input.providerId;
    const runId = input.runId;
    const turnId = input.turnId;
    const requiredCapabilities: ProviderCapabilityId[] = [
      ...(
        input.backendProfile.source === "custom"
        && input.harnessId === "codex-app-server"
          ? ["provider-native-tools" as const]
          : []
      ),
      ...(providerCapabilityManifest(input.harnessId)
        ? ["text-streaming" as const]
        : []),
      ...(input.interactionMode === "plan" ? ["plans" as const] : []),
      ...(input.reasoningEffort || input.modelSelection.reasoningEffort
        ? ["reasoning" as const]
        : []),
      ...(input.sessionId ? ["session-resume" as const] : []),
      ...(input.imagePaths?.length ? ["images" as const] : []),
      ...(input.goalStart ? ["goals" as const] : []),
      ...(input.supportedFastMode !== undefined
        ? ["performance-modes" as const]
        : []),
      ...(input.operation?.kind === "compact" ? ["compaction" as const] : []),
      ...(input.skills?.length ? ["provider-native-tools" as const] : []),
      ...(callbacks.hostTools ? ["host-tool-bridge" as const] : []),
    ];
    const unavailable = requiredCapabilities.find((capabilityId) =>
      !this.options.capabilityAdmissible(
        input,
        capabilityId,
        capabilityId === "host-tool-bridge" ? [capabilityId] : [],
      ));
    if (unavailable) {
      throw new ProviderRuntimeError(
        "invalid_input",
        `The exact provider installation does not attest '${unavailable}'.`,
      );
    }
    const expectedIdentity = providerRunIdentity(input);
    const executable = this.options.commandFor(providerId);
    const nativeProfile = nativeBackendProfile(providerId);
    const ownsLegacyProviderMetadata = input.backendProfile.id === nativeProfile.id
      && input.backendProfile.configurationRevision === nativeProfile.configurationRevision;
    const runMetadataScope = this.options.metadataCache.scopeForSelection(
      input.modelSelection,
      input.backendProfile,
      executable,
    );
    const managerCallbacks: ProviderRunCallbacks = {
      ...callbacks,
      onMetadata: (event) => {
        this.options.metadataCache.learnScoped(
          runMetadataScope,
          event.metadata,
          event.source,
          { merge: !event.complete },
        );
        if (ownsLegacyProviderMetadata) {
          this.options.metadataCache.learn(
            event.providerId,
            this.options.resolvedCommandFor(event.providerId)
              ?? this.options.commandFor(event.providerId),
            event.metadata,
            event.source,
            { merge: !event.complete },
          );
        }
        callbacks.onMetadata?.(event);
      },
    };
    let active!: ActiveRun;
    let protocolViolation: ProviderRuntimeError | null = null;
    const compatibilityEmitter = createProviderEmitter(
      providerId,
      conversationId,
      managerCallbacks,
      runId,
      turnId,
      {
        accept: (event) => {
          const negotiated = [...active.negotiatedCapabilities];
          return capabilitiesForEvent(event).every((capabilityId) =>
            this.options.capabilityAvailable(
              input,
              capabilityId,
              [],
              negotiated,
            ));
        },
        reject: (event) => {
          const negotiated = [...active.negotiatedCapabilities];
          const capabilityId = capabilitiesForEvent(event).find((candidate) =>
            !this.options.capabilityAvailable(
              input,
              candidate,
              [],
              negotiated,
            ));
          if (!capabilityId) return;
          protocolViolation ??= new ProviderRuntimeError(
            "invalid_input",
            `Provider protocol violation: '${capabilityId}' is not attested for this installation.`,
          );
          if (active) {
            active.cancelRequested = true;
            compatibilityEmitter.close();
            this.cancelStartedHarness(active);
          }
        },
      },
    );
    const harness = this.options.harnessRegistry.resolve(input);
    const baseEnvironment = providerChildEnvironment(
      providerId,
      this.options.processEnvironment() ?? process.env,
    );
    let launchOptions: ProviderBackendLaunchOptions = {
      environment: baseEnvironment,
    };
    let launchDisposed = false;
    let launchReleased = false;
    const releaseLaunch = (): void => {
      if (launchReleased) return;
      launchReleased = true;
      try {
        launchOptions.releaseAfterStart?.();
      } catch {
        // Clearing the resolver-owned copy is best effort and idempotent.
      }
    };
    const disposeLaunch = (): void => {
      if (launchDisposed) return;
      launchDisposed = true;
      try {
        launchOptions.dispose?.();
      } catch {
        // Cleanup is best effort and must never mask the provider result.
      }
    };
    const installationUse = this.options.acquireInstallationUse(input, executable);
    if (!this.options.resolvedCommandFor(providerId)) {
      this.options.rememberResolvedCommand(providerId, executable);
    }
    const settle = (): boolean => {
      if (active.settled) return true;
      if (
        !active.processCleanupConfirmed
        || !active.installationUse.release()
      ) {
        active.cancelRequested = true;
        compatibilityEmitter.close();
        active.installationUse.quarantine(
          "provider-run-installation-release-mismatch",
        );
        return false;
      }
      active.settled = true;
      active.launchAbort.abort();
      compatibilityEmitter.close();
      disposeLaunch();
      if (active.hardKillTimer) clearTimeout(active.hardKillTimer);
      if (this.activeRuns.get(conversationId) === active) {
        this.activeRuns.delete(conversationId);
      }
      this.rememberCleanupReceipt(expectedIdentity);
      active.resolveLifecycleSettlement();
      return true;
    };
    const cancelledBeforeStart = (): ProviderRunResult => {
      compatibilityEmitter.status("cancelled");
      return {
        ...providerRunTerminal(input, "cancelled"),
        text: "",
        textTruncated: false,
        exitCode: null,
        signal: null,
        cleanupConfirmed: true,
      };
    };
    const startHarness = (
      resolvedLaunchOptions: ProviderBackendLaunchOptions,
    ): Promise<ProviderRunResult> => {
      launchOptions = resolvedLaunchOptions;
      if (active.cancelRequested || active.settled) {
        releaseLaunch();
        disposeLaunch();
        return Promise.resolve(cancelledBeforeStart());
      }
      let harnessRun: AgentHarnessRun;
      try {
        if (input.backendProfile.source === "custom") {
          const selectedModelId = input.modelSelection.modelId;
          const launchedModelId = launchOptions.modelArgument === undefined
            ? input.model
            : launchOptions.modelArgument ?? undefined;
          const launchIdentity = launchOptions.modelArgumentIdentity
            ?? launchedModelId;
          if (launchIdentity !== selectedModelId) {
            throw new ProviderRuntimeError(
              "invalid_input",
              "The custom backend run does not match the exact probed model identity.",
            );
          }
        }
        if (
          launchOptions.harnessConfiguration?.kind === "codex-responses"
          && harness.id !== "codex-app-server"
        ) {
          throw new ProviderRuntimeError(
            "invalid_input",
            "Codex backend configuration was supplied to a different harness.",
          );
        }
        const launchInput = launchOptions.modelArgument === undefined
          ? input
          : {
              ...input,
              model: launchOptions.modelArgument ?? undefined,
            };
        active.harnessStartInvoked = true;
        harnessRun = harness.start({
          input: launchInput,
          executable,
          // The harness owns this copy for the lifetime of its child process.
          // The resolver-owned source is scrubbed immediately below.
          environment: { ...launchOptions.environment },
          providerNativeToolsAvailable: this.options.capabilityAvailable(
            input,
            "provider-native-tools",
          ),
          ...(launchOptions.harnessConfiguration
            ? { harnessConfiguration: launchOptions.harnessConfiguration }
            : {}),
          callbacks: providerCallbacksFromHarness(
            compatibilityEmitter,
            (observation) => {
              if (active.settled || active.cancelRequested) return;
              if (!observation.available) {
                active.negotiatedCapabilities.delete(
                  observation.capabilityId,
                );
                return;
              }
              const candidate = new Set(active.negotiatedCapabilities);
              candidate.add(observation.capabilityId);
              if (!this.options.capabilityAvailable(
                input,
                observation.capabilityId,
                [],
                [...candidate],
              )) {
                protocolViolation ??= new ProviderRuntimeError(
                  "invalid_input",
                  `Provider protocol violation: '${observation.capabilityId}' cannot be negotiated for this installation.`,
                );
                active.cancelRequested = true;
                compatibilityEmitter.close();
                this.cancelStartedHarness(active);
                return;
              }
              active.negotiatedCapabilities.add(observation.capabilityId);
            },
          ),
          ...(callbacks.hostTools ? { hostTools: callbacks.hostTools } : {}),
        });
      } finally {
        releaseLaunch();
      }
      active.harnessRun = harnessRun;
      if (harnessRun.harnessId !== harness.id || harnessRun.providerId !== providerId) {
        active.quarantine("provider-run-harness-owner-mismatch");
        this.cancelStartedHarness(active);
        disposeLaunch();
        throw new ProviderRuntimeError(
          "lifecycle_corruption",
          `Agent harness '${harness.id}' returned a mismatched run owner.`,
        );
      }
      if (protocolViolation) this.cancelStartedHarness(active);
      if (active.cancelRequested) {
        this.cancelStartedHarness(active);
      } else {
        try {
          callbacks.onStarted?.();
        } catch {
          // Start acknowledgement observers cannot invalidate an owned run.
        }
      }
      return harnessRun.result;
    };

    const launchAbort = new AbortController();
    let resolveLifecycleSettlement!: () => void;
    const lifecycleSettlement = new Promise<void>((resolve) => {
      resolveLifecycleSettlement = resolve;
    });
    active = {
      result: Promise.resolve(null as never),
      lifecycleSettlement,
      resolveLifecycleSettlement,
      harnessRun: null,
      harnessStartInvoked: false,
      launchAbort,
      markPendingCancellation: () => compatibilityEmitter.status("cancelling"),
      runId,
      turnId,
      input,
      negotiatedCapabilities: new Set(),
      installationUse,
      processCleanupConfirmed: false,
      cancelRequested: false,
      settled: false,
      detach: settle,
      quarantine: (reason) => {
        active.cancelRequested = true;
        compatibilityEmitter.close();
        active.installationUse.quarantine(reason);
      },
    };
    this.activeRuns.set(conversationId, active);
    this.cleanupReceipts.delete(conversationId);

    let launched: Promise<ProviderRunResult>;
    try {
      const resolved = this.options.resolveBackendLaunchOptions?.(
        input,
        baseEnvironment,
        { signal: launchAbort.signal },
      ) ?? launchOptions;
      launched = isPromiseLike(resolved)
        ? Promise.resolve(resolved).then(
            startHarness,
            (error: unknown) => {
              if (active.cancelRequested) return cancelledBeforeStart();
              throw error;
            },
          )
        : startHarness(resolved);
    } catch (error) {
      if (!active.harnessStartInvoked) {
        active.processCleanupConfirmed = true;
        settle();
      } else {
        active.quarantine("provider-run-start-terminal-outcome-unavailable");
      }
      throw error;
    }
    const result = launched.then(
      (value) => {
        if (
          !hasExactProviderRunIdentity(value, expectedIdentity)
          || !hasConsistentProviderTerminalOutcome(value)
        ) {
          // A terminal promise with a different owner cannot prove anything
          // about this run. Keep the admission occupied, close callbacks, and
          // attempt bounded cleanup of the exact harness we actually started.
          active.quarantine("provider-run-terminal-owner-mismatch");
          this.cancelStartedHarness(active);
          throw new ProviderRuntimeError(
            "lifecycle_corruption",
            "The provider returned a terminal result for a different run owner.",
          );
        }
        if (value.status === "completed") {
          const negotiated = [...active.negotiatedCapabilities];
          const missingRequiredObservation = requiredCapabilities.find(
            (capabilityId) => !this.options.capabilityAvailable(
              input,
              capabilityId,
              capabilityId === "host-tool-bridge" ? [capabilityId] : [],
              negotiated,
            ),
          );
          if (missingRequiredObservation) {
            protocolViolation ??= new ProviderRuntimeError(
              "invalid_input",
              `Provider protocol violation: '${missingRequiredObservation}' completed without exact-run capability evidence.`,
            );
          }
        }
        if (!value.cleanupConfirmed) {
          active.quarantine("provider-run-cleanup-unconfirmed");
          if (active.hardKillTimer) clearTimeout(active.hardKillTimer);
        } else {
          active.processCleanupConfirmed = true;
          if (!settle()) {
            throw new ProviderRuntimeError(
              "lifecycle_corruption",
              "The provider result could not release exact installation authority.",
            );
          }
        }
        if (protocolViolation) throw protocolViolation;
        return value;
      },
      (error: unknown) => {
        if (!active.harnessStartInvoked) {
          active.processCleanupConfirmed = true;
          settle();
        } else {
          active.quarantine("provider-run-terminal-outcome-unavailable");
          this.cancelStartedHarness(active);
        }
        throw error;
      },
    );
    active.result = result;
    return result;
  }

  compact(
    input: ProviderRunInput,
    instruction?: string,
    callbacks: ProviderRunCallbacks = {},
  ): Promise<ProviderCompactionResult> {
    const operationInput: ProviderRunInput = {
      ...input,
      prompt: "/compact",
      // Compaction is a non-durable control operation with an authoritative
      // caller-allocated correlation turn, never a user-tool execution turn.
      access: "supervised",
      operation: {
        kind: "compact",
        ...(instruction ? { instruction } : {}),
      },
    };
    const instructionForwarded = (
      operationInput.providerId === "claude"
      || operationInput.providerId === "kimi"
    ) && instruction !== undefined;
    let interactionError: string | undefined;
    const rejectInteractiveCompaction = (
      interaction: "approval" | "input",
    ): void => {
      if (interactionError) return;
      interactionError = `Provider compaction requested interactive ${interaction} that a non-durable control operation cannot answer.`;
      this.cancel(input.conversationId);
    };
    const providerResult = this.run(operationInput, {
      ...callbacks,
      onApproval: () => rejectInteractiveCompaction("approval"),
      onInput: () => rejectInteractiveCompaction("input"),
    });
    const timer = setTimeout(() => {
      this.cancel(input.conversationId);
    }, PROVIDER_COMPACTION_OPERATION_TIMEOUT_MS);
    timer.unref();
    return providerResult.then((result) => {
      const requestedSessionId = operationInput.sessionId!;
      const sessionError = result.sessionId === requestedSessionId
        ? undefined
        : "The provider did not confirm compaction of the exact selected session.";
      const operationError = interactionError ?? sessionError;
      const status = operationError ? "failed" as const : result.status;
      const error = operationError ?? result.error;
      const message = status !== "completed"
        ? error ?? "The provider could not compact this chat."
        : instruction && !instructionForwarded
          ? `${PROVIDER_INFO[result.providerId].name} compacted the context, but does not accept a focus instruction through this integration, so the instruction was not forwarded.`
          : instructionForwarded
            ? "Context compacted with the focus instruction."
            : "Context compacted.";
      return {
        providerId: result.providerId,
        conversationId: result.conversationId,
        runId: result.runId,
        turnId: result.turnId,
        status,
        terminalReason: status === result.status
          ? result.terminalReason
          : providerTerminalOutcome(status),
        instructionForwarded,
        message,
        ...(error ? { error } : {}),
        cleanupConfirmed: result.cleanupConfirmed,
      };
    }).finally(() => clearTimeout(timer));
  }

  cancel(conversationId: string): boolean {
    const active = this.activeRuns.get(conversationId);
    if (!active || active.settled || active.cancelRequested) return false;
    active.cancelRequested = true;
    if (!active.harnessRun) {
      active.markPendingCancellation();
      active.launchAbort.abort();
      return true;
    }
    this.cancelStartedHarness(active);
    return true;
  }

  async steer(
    conversationId: string,
    input: ProviderSteerInput,
    identity: { runId: string; turnId: string },
  ): Promise<boolean> {
    const active = this.activeRuns.get(conversationId);
    if (
      !active
      || active.settled
      || active.cancelRequested
      || active.runId !== identity.runId
      || active.turnId !== identity.turnId
      || !this.options.capabilityAvailable(
        active.input,
        "follow-up-steer",
        [],
        [...active.negotiatedCapabilities],
      )
    ) return false;
    const extension = active.harnessRun?.extension;
    const steer = extension && "steer" in extension
      ? extension.steer
      : undefined;
    if (!steer) return false;
    try {
      return await steer(input);
    } catch {
      return false;
    }
  }

  async setGoal(
    conversationId: string,
    input: ProviderGoalMutation,
    identity: { runId: string; turnId: string },
  ): Promise<ProviderGoalSnapshot | null> {
    const active = this.activeRuns.get(conversationId);
    if (
      !active
      || active.settled
      || active.cancelRequested
      || active.runId !== identity.runId
      || active.turnId !== identity.turnId
      || !this.options.capabilityAvailable(
        active.input,
        "goals",
        [],
        [...active.negotiatedCapabilities],
      )
    ) return null;
    const extension = active.harnessRun?.extension;
    if (!extension || extension.kind !== "codex-app-server") return null;
    return await extension.setGoal(input);
  }

  async clearGoal(
    conversationId: string,
    identity: { runId: string; turnId: string },
  ): Promise<boolean | "superseded"> {
    const active = this.activeRuns.get(conversationId);
    if (
      !active
      || active.settled
      || active.cancelRequested
      || active.runId !== identity.runId
      || active.turnId !== identity.turnId
      || !this.options.capabilityAvailable(
        active.input,
        "goals",
        [],
        [...active.negotiatedCapabilities],
      )
    ) return false;
    const extension = active.harnessRun?.extension;
    if (!extension || extension.kind !== "codex-app-server") return false;
    return await extension.clearGoal() ? true : "superseded";
  }

  async stopSubagent(
    conversationId: string,
    providerTaskId: string,
    identity: { runId: string; turnId: string },
  ): Promise<boolean> {
    const active = this.activeRuns.get(conversationId);
    if (
      !active
      || active.settled
      || active.cancelRequested
      || active.runId !== identity.runId
      || active.turnId !== identity.turnId
      || !this.options.capabilityAvailable(
        active.input,
        "subagent-stop",
        [],
        [...active.negotiatedCapabilities],
      )
    ) return false;
    const extension = active.harnessRun?.extension;
    const stopSubagent = extension && "stopSubagent" in extension
      ? extension.stopSubagent
      : undefined;
    if (!stopSubagent) return false;
    try {
      return await stopSubagent(providerTaskId);
    } catch {
      return false;
    }
  }

  /**
   * Stops one caller-owned provider run without allowing a malformed harness
   * result promise to wedge its owner forever.
   */
  async stopOwned(
    conversationId: string,
    identity: { runId: string; turnId: string },
    graceMs = this.options.cancelGraceMs,
  ): Promise<OwnedProviderStopResult> {
    const active = this.activeRuns.get(conversationId);
    if (!active || active.settled) {
      const receipt = this.cleanupReceipts.get(conversationId);
      return receipt
        && receipt.runId === identity.runId
        && receipt.turnId === identity.turnId
        ? "settled"
        : "missing";
    }
    if (active.runId !== identity.runId || active.turnId !== identity.turnId) {
      active.quarantine("provider-run-stop-owner-mismatch");
      this.cancelStartedHarness(active);
      return "identity-mismatch";
    }
    if (active.processCleanupConfirmed) {
      active.detach();
      return active.settled ? "settled" : "force-detached";
    }

    this.cancel(conversationId);
    if (await this.waitForSettlement(active, graceMs)) return "settled";

    if (active.hardKillTimer) {
      clearTimeout(active.hardKillTimer);
      active.hardKillTimer = undefined;
    }
    try {
      active.harnessRun?.cancel(true);
    } catch {
      // A malformed harness can throw while its owned process is already gone.
    }
    if (await this.waitForSettlement(active, FORCE_DETACH_GRACE_MS)) return "settled";

    // Retain this exact run as a process-local exclusion until authoritative
    // complete-tree cleanup is observed by its lifecycle owner.
    active.quarantine("provider-run-force-detached");
    return "force-detached";
  }

  private rememberCleanupReceipt(identity: ProviderRunIdentity): void {
    this.cleanupReceipts.delete(identity.conversationId);
    this.cleanupReceipts.set(identity.conversationId, identity);
    while (this.cleanupReceipts.size > MAX_CLEANUP_RECEIPTS) {
      const oldest = this.cleanupReceipts.keys().next().value;
      if (oldest === undefined) break;
      this.cleanupReceipts.delete(oldest);
    }
  }

  async disposeAll(): Promise<boolean> {
    const active = [...this.activeRuns.entries()];
    const results = await Promise.allSettled(active.map(([conversationId, run]) =>
      this.stopOwned(
        conversationId,
        { runId: run.runId, turnId: run.turnId },
        undefined,
      )));
    return !results.some((result) => (
      result.status === "rejected"
      || result.value !== "settled"
    )) && this.activeRuns.size === 0;
  }

  respondToApproval(
    conversationId: string,
    requestId: string,
    decision: AgentApprovalDecision,
    identity: { runId: string; turnId: string },
  ): boolean {
    const active = this.activeRuns.get(conversationId);
    if (!active || !active.harnessRun || active.settled || active.cancelRequested) return false;
    if (active.runId !== identity.runId || active.turnId !== identity.turnId) return false;
    if (!this.options.capabilityAvailable(
      active.input,
      "approvals",
      [],
      [...active.negotiatedCapabilities],
    )) return false;
    const extension = active.harnessRun.extension;
    if (!("respondToApproval" in extension)) return false;
    return extension.respondToApproval(requestId, decision);
  }

  respondToInput(
    conversationId: string,
    requestId: string,
    answers: Record<string, string[]>,
    identity: { runId: string; turnId: string },
  ): boolean {
    const active = this.activeRuns.get(conversationId);
    if (!active || !active.harnessRun || active.settled || active.cancelRequested) return false;
    if (active.runId !== identity.runId || active.turnId !== identity.turnId) return false;
    if (!this.options.capabilityAvailable(
      active.input,
      "structured-input",
      [],
      [...active.negotiatedCapabilities],
    )) return false;
    const extension = active.harnessRun.extension;
    if (!("respondToInput" in extension)) return false;
    return extension.respondToInput(requestId, answers);
  }

  private cancelStartedHarness(active: ActiveRun): void {
    const harnessRun = active.harnessRun;
    if (!harnessRun) return;
    try {
      harnessRun.cancel(false);
    } catch {
      // The provider may already have queued its terminal event.
    }
    active.hardKillTimer = setTimeout(() => {
      if (active.settled) return;
      try {
        harnessRun.cancel(true);
      } catch {
        // The process may have exited between the check and kill.
      }
    }, this.options.cancelGraceMs);
    active.hardKillTimer.unref();
  }

  private async waitForSettlement(
    active: ActiveRun,
    graceMs: number,
  ): Promise<boolean> {
    if (active.settled) return true;
    const boundedGraceMs = Math.max(0, Math.min(graceMs, MAX_OWNED_STOP_GRACE_MS));
    if (boundedGraceMs === 0) return active.settled;
    let timer: NodeJS.Timeout | undefined;
    const settled = await Promise.race([
      active.lifecycleSettlement.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), boundedGraceMs);
        timer.unref();
      }),
    ]);
    if (timer) clearTimeout(timer);
    return settled;
  }
}
