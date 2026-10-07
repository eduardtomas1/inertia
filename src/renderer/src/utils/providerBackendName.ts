import type { ModelSelection, ProviderId } from "@shared/contracts";
import { providerNativeBackendProfile } from "../../../shared/model-routing";

export function providerBackendName(
  providerId: ProviderId,
  selection: Pick<ModelSelection, "backendProfileId" | "backendProfileDisplayName">,
): string | null {
  return selection.backendProfileId === providerNativeBackendProfile(providerId).id
    ? null
    : selection.backendProfileDisplayName;
}
