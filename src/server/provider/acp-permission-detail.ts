import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";

/** Include edit patches and targets even when the provider omits rawInput. */
export function acpPermissionDetail(
  params: Pick<RequestPermissionRequest, "toolCall">,
  fallback: string,
): string {
  const { rawInput, content, locations } = params.toolCall;
  const value = content === undefined && locations === undefined ? rawInput : {
    ...(rawInput === undefined ? {} : { input: rawInput }),
    ...(content === undefined ? {} : { content }),
    ...(locations === undefined ? {} : { locations }),
  };
  try {
    return value === undefined ? fallback : JSON.stringify(value);
  } catch {
    // A serialization failure must be rejected by approval-display validation.
    return "\u0000";
  }
}
