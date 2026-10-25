import type {
  ContinuationIdentity,
  HarnessBackendCompatibility,
  KnownHarnessId,
  ModelBackendProfile,
} from "../../shared/model-routing";
import type { ProviderDetectionOptions, ProviderId } from "./contracts";
import type { ProviderInstallationVerificationAuthority } from "./installation-lease";
import type { ProviderMetadataRequestOptions } from "./metadata";

export interface ResolvedModelRoute {
  providerId: ProviderId;
  harnessId: KnownHarnessId;
  backendProfile: ModelBackendProfile;
  compatibility: HarnessBackendCompatibility;
  continuationIdentity: ContinuationIdentity;
}

export interface ProviderInstallationReadContext {
  /** Exact process-local authority issued only after a maintenance command. */
  installationVerificationAuthority?: ProviderInstallationVerificationAuthority;
}

export type ProviderManagerDetectionOptions = Omit<
  ProviderDetectionOptions,
  "command"
> & ProviderInstallationReadContext;

export type ProviderManagerMetadataRequestOptions =
  ProviderMetadataRequestOptions & ProviderInstallationReadContext;
