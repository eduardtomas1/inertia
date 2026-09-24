import type { ModelBackendProfile } from "../../shared/contracts";
import { providerFailureMessage } from "./adapters";
import {
  MAX_PROVIDER_FAILURE_DETAIL_CHARS,
  sanitizeProviderFailureDetail,
} from "./activity-detail";

/**
 * The native Anthropic route shows the harness's own sentence; a custom
 * backend shows the profile's classified message instead.
 */
export function claudeRouteFailureMessage(
  usesNativeAnthropic: boolean,
  error: string,
  backendProfile: ModelBackendProfile,
): string {
  return usesNativeAnthropic
    ? error
    : providerFailureMessage("claude", undefined, error, "", backendProfile);
}

/**
 * A custom backend's public message is the profile's generic sentence, so the
 * harness's own reason would otherwise be lost; keep it in the technical
 * detail, redacted and bounded like the stderr tail it precedes.
 */
export function claudeRouteFailureDetail(input: {
  usesNativeAnthropic: boolean;
  rawError: string;
  message: string;
  detail: string | null;
  launchCredentials: readonly string[];
  workspaceRoot: string;
}): string | null {
  if (input.usesNativeAnthropic || input.message === input.rawError) return input.detail;
  const cause = sanitizeProviderFailureDetail(
    input.rawError,
    input.launchCredentials,
    { workspaceRoot: input.workspaceRoot, maxChars: MAX_PROVIDER_FAILURE_DETAIL_CHARS },
  );
  if (!cause || cause === input.detail) return input.detail;
  return input.detail ? `${cause}\n${input.detail}` : cause;
}
