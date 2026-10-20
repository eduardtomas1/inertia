import type { ModelSelection, ProviderInfo } from "../../../shared/contracts";
import { providerIdForHarness } from "../../../shared/model-routing";
import { watcherHarnessAllowed } from "../../../shared/watcher";
import type { BackendProfileController } from "../backends/backend-profile-controller";
import type { TurnProviderRuntime } from "../turns/turn-controller-types";
import { routeUsesTrustedHostBridge } from "../turns/turn-provider-host-tools";

export interface WatcherRouteDependencies {
  backendProfiles: Pick<BackendProfileController, "validateSelection" | "readiness">;
  providers: Pick<TurnProviderRuntime, "resolveModelRoute">;
  providerInfo(): readonly ProviderInfo[];
}

export type WatcherRouteReadiness =
  | {
      ready: true;
      selection: ModelSelection;
      providerId: NonNullable<ReturnType<typeof providerIdForHarness>>;
      /** False for custom backends, which never receive Inertia host tools. */
      contextAccess: boolean;
    }
  | { ready: false; message: string };

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

/**
 * The Duo preflight for one watcher route: a valid selection, a resolvable
 * route on a reviewed watcher harness, backend readiness and a runnable
 * provider. Nothing is spawned.
 */
export async function watcherRouteReadiness(
  dependencies: WatcherRouteDependencies,
  input: ModelSelection,
): Promise<WatcherRouteReadiness> {
  let selection: ModelSelection;
  let route: ReturnType<TurnProviderRuntime["resolveModelRoute"]>;
  try {
    selection = dependencies.backendProfiles.validateSelection(input);
    route = dependencies.providers.resolveModelRoute(selection);
  } catch (error) {
    return { ready: false, message: message(error, "The watcher's model route is unavailable.") };
  }
  if (!watcherHarnessAllowed(route.harnessId)) {
    return { ready: false, message: "This agent can't be a watcher yet." };
  }
  const providerId = providerIdForHarness(selection.harnessId);
  if (!providerId || providerId !== route.providerId) {
    return { ready: false, message: "The watcher's model route is unavailable." };
  }
  const provider = dependencies.providerInfo().find(({ id }) => id === providerId);
  let readiness: Awaited<ReturnType<BackendProfileController["readiness"]>>;
  try {
    readiness = await dependencies.backendProfiles.readiness(selection, provider);
  } catch (error) {
    return { ready: false, message: message(error, "The watcher's backend is unavailable.") };
  }
  if (readiness && !readiness.ready) {
    return { ready: false, message: readiness.message ?? "The watcher's backend is unavailable." };
  }
  if (!readiness && !provider?.canRun) {
    return {
      ready: false,
      message: provider?.statusMessage ?? "The watcher's route is not ready. Open Settings to finish setup.",
    };
  }
  return {
    ready: true,
    selection,
    providerId,
    contextAccess: routeUsesTrustedHostBridge({
      providerId: route.providerId,
      harnessId: route.harnessId,
      backendProfile: route.backendProfile,
    }),
  };
}
