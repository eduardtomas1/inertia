import type { ProviderInfo, ServerEvent } from "../../shared/contracts";
import type WebSocket from "ws";
import type { RuntimeStore } from "../database";
import type { ProviderManager } from "../providers";
import type { BackendProfileController, BackendCredentialBroker } from "../runtime/backends/backend-profile-controller";
import { createUsageLimitCommandHandler } from "../runtime/commands/usage-limit-commands";
import { UsageLimitsService } from "./limits-service";
import { NativeUsageReader } from "./native";

export function usageLimitsRuntime(store: RuntimeStore, providers: ProviderManager, backends: BackendProfileController, providerInfo: () => ProviderInfo[], cwd: string, signal: AbortSignal, enabled: boolean, credentials: BackendCredentialBroker | undefined, send: (socket: WebSocket, event: ServerEvent) => void) {
  return createUsageLimitCommandHandler(new UsageLimitsService({
    repository: store.usageLimits, credentials,
    native: new NativeUsageReader(providers, cwd, signal), providers: providerInfo,
    customProfiles: () => backends.profiles(providerInfo()).filter((profile) => profile.preset !== "native").map((profile) => ({ id: profile.id, label: profile.displayName })),
    signal, enabled,
  }), send);
}
