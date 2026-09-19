import type { SDKMessage, SDKStartupFailureReason } from "@anthropic-ai/claude-agent-sdk";

export const CLAUDE_STARTUP_FAILURE_RESULTS = {
  CLAUDE_CODE_STARTUP_FAILURE_RESULTS: "1",
} as const;

const STARTUP_FAILURE_MESSAGES: Record<SDKStartupFailureReason, string> = {
  org_pin_api_key_conflict: "Claude Code's API key conflicts with your organization's sign-in policy. Remove the key or sign in with your organization account.",
  org_verify_failed: "Claude Code couldn't verify your organization. Check your connection and sign in again.",
  org_pin_mismatch: "This Claude account isn't in the organization Claude Code requires. Sign in with the right account.",
  managed_settings_invalid: "Claude Code's managed settings are invalid. Ask your administrator to fix them.",
  remote_settings_required_unavailable: "Claude Code couldn't load the settings your organization requires. Check your connection and try again.",
  gateway_signin_required: "Sign in to your Claude gateway, then try again.",
  gateway_access_denied: "Your Claude gateway denied access for this account.",
  proxy_invalid: "Claude Code's proxy setting isn't a valid URL. Fix it, then try again.",
  temp_dir_unusable: "Claude Code can't write to the temporary folder. Check its permissions and free space.",
  cwd_unavailable: "Claude Code can't open this project's folder. Check that it still exists.",
  shell_tool_missing: "Claude Code couldn't find a shell to run commands.",
  session_held_by_background: "This Claude session is still busy with background work. Wait for it to finish or start a new chat.",
  worktree_resume_refused: "Claude Code wouldn't resume this chat's session here. Start a new chat to continue.",
  worktree_unverified: "Claude Code couldn't verify the worktree for this chat. Start a new chat to continue.",
  cli_version_too_old: "This Claude Code version is too old. Update Claude Code, then try again.",
  bypass_root: "Claude Code won't run with full access as the root user. Choose another access mode.",
};

export function claudeStartupFailure(
  result: Extract<SDKMessage, { type: "result" }>,
): { reason: SDKStartupFailureReason; message: string } | undefined {
  if (result.subtype === "success" || !result.startup_failure_reason) return undefined;
  const message = STARTUP_FAILURE_MESSAGES[result.startup_failure_reason];
  return message ? { reason: result.startup_failure_reason, message } : undefined;
}
