import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { ModelSelection } from "../../shared/model-routing";
import { providerChildEnvironment, providerEnvironment } from "../environment";
import { providerInstanceId } from "../orchestration-v2/provider-instance";
import type { AgentHarnessRegistry } from "./agent-harness-registry";
import { ProviderRuntimeError, type ProviderManagerOptions, type ProviderBackendLaunchOptions, type ProviderRunInput } from "./contracts";
import type { ProviderManagerInstallationAuthority } from "./provider-manager-installation";
import type { ResolvedModelRoute } from "./provider-manager-types";
import type { NativeConversationLaunch, NativeConversationRequest, NativeConversationResult } from "./native-conversation-operations";

export interface NativeConversationExecutionContext {
  cwd: string;
  sourceCwd?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface NativeConversationServiceOptions {
  registry: AgentHarnessRegistry;
  installation: ProviderManagerInstallationAuthority;
  route: ResolvedModelRoute;
  resolveRoute(): ResolvedModelRoute;
  executable: string;
  installationVersion?: string | null;
  lifetimeSignal: AbortSignal;
  isRunning(conversationId: string): boolean;
  gate?: ProviderManagerOptions["conversationProviderGate"];
  resolveLaunch?: ProviderManagerOptions["resolveBackendLaunchOptions"];
}

/** Caller owns the durable conversation/workspace mutation lock. Instance binding is checked again here. */
export async function executeNativeConversation(request: NativeConversationRequest, selection: ModelSelection,
  context: NativeConversationExecutionContext, options: NativeConversationServiceOptions): Promise<NativeConversationResult> {
  const { route } = options;
  const requireInstance = (current: ResolvedModelRoute): void => {
    if (request.source.identity.providerInstanceId !== providerInstanceId(current.providerId, current.continuationIdentity)) {
      throw new ProviderRuntimeError("invalid_input", "The native history belongs to a different provider instance.");
    }
  };
  requireInstance(route);
  const source = request.source.identity.conversationId;
  options.gate?.(source, route.providerId);
  options.installation.assertRecoveryComplete(route.providerId);
  if (options.isRunning(source) || request.kind === "fork" && options.isRunning(request.targetConversationId)) {
    throw new ProviderRuntimeError("invalid_input", "Stop the active provider run before changing native history.");
  }
  const signal = context.signal ? AbortSignal.any([options.lifetimeSignal, context.signal]) : options.lifetimeSignal;
  signal.throwIfAborted();
  if (await realpath(context.cwd) !== resolve(context.cwd)
    || context.sourceCwd && await realpath(context.sourceCwd) !== resolve(context.sourceCwd)) throw new ProviderRuntimeError("invalid_input", "Native history requires canonical workspaces.");
  const input: ProviderRunInput = { providerId: route.providerId, harnessId: route.harnessId,
    conversationId: source, runId: request.operationId, turnId: request.operationId,
    cwd: context.cwd, prompt: "Native conversation control", modelSelection: selection,
    backendProfile: route.backendProfile, backendCompatibility: route.compatibility, continuationIdentity: route.continuationIdentity,
    access: "supervised", interactionMode: "build", sessionId: request.source.nativeConversationId,
    ...(selection.modelId !== "provider-default" ? { model: selection.modelId } : {}),
    ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}) };
  const operation = options.registry.resolve(input).nativeConversation;
  if (!operation) return { status: "unsupported", reason: "native-history-control-unavailable", identity: request.source.identity,
    operationId: request.operationId, ...(request.kind === "fork" ? { targetConversationId: request.targetConversationId } : {}) };
  const admission = options.installation.acquire(route.providerId, options.executable, route.backendProfile,
    "provider-server", options.installation.operationIdentity("provider-server"));
  const transfer = options.installation.transfer(admission);
  let launchOptions: ProviderBackendLaunchOptions | undefined;
  let launchReleased = false;
  try {
    const base = providerChildEnvironment(route.providerId, (await providerEnvironment()).env);
    signal.throwIfAborted();
    launchOptions = await options.resolveLaunch?.(input, base, { signal }) ?? { environment: base };
    signal.throwIfAborted();
    options.gate?.(source, route.providerId);
    requireInstance(options.resolveRoute());
    if (options.isRunning(source) || request.kind === "fork" && options.isRunning(request.targetConversationId)) throw new ProviderRuntimeError("invalid_input", "The provider conversation became active.");
    const launch: NativeConversationLaunch = { executable: options.executable, installationVersion: options.installationVersion, environment: { ...launchOptions.environment },
      cwd: context.cwd, sourceCwd: context.sourceCwd, signal, timeoutMs: context.timeoutMs, installationUse: transfer,
      harnessConfiguration: launchOptions.harnessConfiguration };
    // execute owns the copied private environment until its operation and cleanup finish.
    const result = operation.execute(request, launch);
    launchOptions.releaseAfterStart?.();
    launchReleased = true;
    return await result;
  } finally {
    transfer.abandonBeforeSpawn();
    if (!launchReleased) launchOptions?.releaseAfterStart?.();
    launchOptions?.dispose?.();
  }
}
