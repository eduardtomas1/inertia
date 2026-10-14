import { providerEnvironment } from "../environment";
import {
  PROVIDER_IDS,
  type ProviderDetection,
  type ProviderDetectionOptions,
  type ProviderId,
} from "./contracts";

export type DetectAllProvidersOptions = Omit<ProviderDetectionOptions, "command"> & {
  onDetection?: (detection: ProviderDetection) => void;
};

export async function detectAllProviders(
  detect: (
    providerId: ProviderId,
    options: Omit<ProviderDetectionOptions, "command">,
  ) => Promise<ProviderDetection>,
  lifetimeSignal: AbortSignal,
  { onDetection, ...options }: DetectAllProvidersOptions,
): Promise<ProviderDetection[]> {
  if (options.refreshEnvironment) await providerEnvironment(true);
  if (lifetimeSignal.aborted) {
    throw new Error("Provider discovery was cancelled.");
  }
  const settled = await Promise.allSettled(PROVIDER_IDS.map(async (id) => {
    const detection = await detect(id, { ...options, refreshEnvironment: false });
    onDetection?.(detection);
    return detection;
  }));
  const failed = settled.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failed) throw failed.reason;
  return settled.map((result) => (result as PromiseFulfilledResult<ProviderDetection>).value);
}
