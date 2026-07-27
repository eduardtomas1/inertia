import type {
  ProviderMaintenanceOperation,
  ProviderMaintenanceProviderId,
} from "@shared/contracts";

export function providerMaintenanceOperationMap(
  operations: readonly ProviderMaintenanceOperation[] | undefined,
): Map<ProviderMaintenanceProviderId, ProviderMaintenanceOperation> {
  return new Map((operations ?? []).map((operation) => [
    operation.providerId,
    operation,
  ]));
}
