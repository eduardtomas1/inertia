import type { ProviderInfo } from "./contracts/app";
import type { ProviderId } from "./provider";

export type DefaultProviderState = Pick<ProviderInfo, "id" | "available" | "installState" | "authState" | "canRun">;

function runnable(provider: DefaultProviderState): boolean {
  return provider.available && provider.installState === "installed" && provider.canRun;
}

export function providerMayRun(provider: DefaultProviderState): boolean {
  return runnable(provider) || provider.installState === "checking" || provider.authState === "checking";
}

export function effectiveDefaultProviderId(
  storedProviderId: ProviderId,
  providers: readonly DefaultProviderState[],
): ProviderId {
  const stored = providers.find(({ id }) => id === storedProviderId);
  if (stored && providerMayRun(stored)) {
    return storedProviderId;
  }
  return providers.find(runnable)?.id ?? storedProviderId;
}
