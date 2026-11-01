import type { ContinuationIdentity } from "../../shared/model-routing";
import { commandFingerprint } from "./json";

/** Account/configuration and installation identity, independent of model and reasoning settings. */
export function providerInstanceId(providerId: string, identity: ContinuationIdentity): string {
  return commandFingerprint({ providerId, harnessId: identity.harnessId,
    backendProfileId: identity.backendProfileId, configurationRevision: identity.backendConfigurationRevision,
    endpointIdentity: identity.endpointIdentity, compatibilityToken: identity.providerCompatibilityToken ?? null });
}
