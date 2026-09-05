import {
  providerNativeBackendProfile,
  providerNativeHarnessId,
} from "../../../shared/model-routing";
import { KIMI_CLAUDE_BUILTIN_PROFILE_ID } from "../../../shared/claude-backend-profiles";
import type { ProviderId } from "../../../shared/contracts";
import type { ModelBackendProfile } from "../../../shared/model-routing";
import type { ProviderHostToolBridge } from "../../provider/contracts";
import type { ActiveTurn, TurnControllerHooks } from "./turn-controller-types";

/**
 * Resolves exact-turn host authority before durable provider ownership begins.
 * A custom backend cannot inherit this provider-level native contract; it
 * needs a future dedicated host-bridge attestation before tools can be passed.
 */
export function resolveTurnHostTools(
  active: ActiveTurn,
  hooks: TurnControllerHooks,
): ProviderHostToolBridge | undefined {
  const capabilityContract = hooks.providerInfo().find(
    ({ id }) => id === active.providerInput.providerId,
  )?.capabilityContract;
  const hostToolsAttested = capabilityContract !== undefined
    && capabilityContract.installationVerified
    && capabilityContract.hostToolBridgeAvailable
    && capabilityContract.harnessId === active.providerInput.harnessId
    && routeUsesTrustedHostBridge({
      providerId: active.providerInput.providerId,
      harnessId: active.providerInput.harnessId,
      backendProfile: active.providerInput.backendProfile,
    });
  if (!hostToolsAttested) return undefined;
  return hooks.hostToolsForTurn?.({
    conversation: active.conversation,
    turn: active.turn,
  });
}

/**
 * Host callbacks are provider authority, not a protocol-level capability.
 * Besides each provider's native profile, the only alternate trusted route is
 * Inertia's immutable built-in Kimi preset executed by the Claude SDK.
 */
export function routeUsesTrustedHostBridge(input: {
  providerId: ProviderId;
  harnessId: string;
  backendProfile: ModelBackendProfile;
}): boolean {
  if (input.backendProfile.source !== "built-in") return false;
  if (
    input.harnessId === providerNativeHarnessId(input.providerId)
    && input.backendProfile.id
      === providerNativeBackendProfile(input.providerId).id
  ) {
    return true;
  }
  return input.providerId === "claude"
    && input.harnessId === "claude-agent-sdk"
    && input.backendProfile.id === KIMI_CLAUDE_BUILTIN_PROFILE_ID;
}
