import type { ProviderId } from "@shared/contracts";

import { ProviderBrandIcon } from "./ProviderBrandIcon";

/** Dense Usage surfaces reuse the same packaged, provenance-tracked marks as Work. */
export function ProviderMark({
  providerId,
  size = 16,
}: {
  providerId: ProviderId;
  size?: number;
}): React.JSX.Element {
  return (
    <ProviderBrandIcon
      className="usage-provider-mark"
      providerId={providerId}
      size={size}
      decorative
    />
  );
}
