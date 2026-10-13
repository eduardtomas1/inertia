import type { ProviderInfo, ServerEvent } from "../../shared/contracts";
import type WebSocket from "ws";
import type { RuntimeStore } from "../database";
import type { ProviderManager } from "../providers";
import type { BackendProfileController, BackendCredentialBroker } from "../runtime/backends/backend-profile-controller";
import { createUsageLimitCommandHandler } from "../runtime/commands/usage-limit-commands";
import { UsageLimitsService } from "./limits-service";
import { NativeUsageReader } from "./native";
import { NativeSubscriptionReader } from "./native-subscriptions";
import { USAGE_ACCOUNT_IDENTITY_SECRET_REFERENCE } from "../../node/backend-secret-reference";
import { createLimitResetRuntime } from "../runtime/limit-reset-runtime";
import { createRestartContinuationRuntime } from "../runtime/restart-continuation-runtime";
import type { TurnInteractionCommandDependencies } from "../runtime/commands/turn-interaction-commands";
import type { ProviderMaintenanceController } from "../provider/maintenance-controller";
import { createUpdatesCommandHandler } from "../runtime/commands/updates-commands";

interface ResumeRuntimeOptions {
  dependencies: TurnInteractionCommandDependencies;
  track<T>(operation: () => Promise<T>): Promise<T>;
  providerMaintenance: ProviderMaintenanceController;
}

export function usageLimitsRuntime(store: RuntimeStore, providers: ProviderManager, backends: BackendProfileController, providerInfo: () => ProviderInfo[], cwd: string, signal: AbortSignal, enabled: boolean, credentials: BackendCredentialBroker | undefined, send: (socket: WebSocket, event: ServerEvent) => void,
  resume: ResumeRuntimeOptions) {
  const service = new UsageLimitsService({
    repository: store.usageLimits, credentials,
    native: new NativeUsageReader(providers, cwd, signal, new NativeSubscriptionReader({
      openCodeAccount: (directory, model, lifetime) => providers.openCodeUsageAccount(directory, model, lifetime),
      accountKey: async (lifetime) => await credentials?.resolve(USAGE_ACCOUNT_IDENTITY_SECRET_REFERENCE, lifetime) ?? null,
    })), providers: providerInfo,
    customProfiles: () => backends.profiles(providerInfo()).filter((profile) => profile.preset !== "native").map((profile) => ({ id: profile.id, label: profile.displayName })),
    signal, enabled,
  });
  const limitReset = createLimitResetRuntime(resume.dependencies, service, { signal, track: resume.track });
  limitReset.start();
  const restartContinuation = createRestartContinuationRuntime(resume.dependencies, { signal, track: resume.track });
  restartContinuation.start();
  const updates = createUpdatesCommandHandler({
    store, turns: resume.dependencies.turns, maintenance: resume.providerMaintenance, restartContinuation, send,
  });
  return { service, handlers: [createUsageLimitCommandHandler(service, send), limitReset.handler, updates], restartContinuation };
}
