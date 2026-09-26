import type { ComposerRouteReadiness } from "../../utils/composerReadiness";
import type { ComposerProps } from "./types";

export async function repairComposerRoute(options: Pick<ComposerProps,
  "conversation" | "onOpenProviderSetup" | "onConnectProvider" | "onOpenBackendSetup"
  | "onProbeBackendProfile" | "onRefreshProvider"
> & {
  readiness: ComposerRouteReadiness;
  profileId: string | undefined;
  pending: boolean;
  setPending: (pending: boolean) => void;
}): Promise<void> {
  if (options.readiness.ready || !options.readiness.action || options.pending) return;
  const action = options.readiness.action;
  if (action === "install") return options.onOpenProviderSetup(options.conversation.providerId);
  if (action === "connect") return options.onConnectProvider(options.conversation.providerId);
  if (action === "add-key" || action === "configure") {
    if (options.profileId) options.onOpenBackendSetup(options.profileId);
    return;
  }
  options.setPending(true);
  try {
    if (action === "probe" && options.profileId) {
      await options.onProbeBackendProfile(options.profileId, options.conversation.modelSelection.modelId);
    } else options.onRefreshProvider(options.conversation.providerId);
  } finally {
    options.setPending(false);
  }
}
