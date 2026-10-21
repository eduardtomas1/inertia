export const STEERABLE_HARNESS_IDS = [
  "codex-app-server",
  "claude-agent-sdk",
  "opencode-sdk",
] as const;

export function supportsActiveParentFollowUp(harnessId: string | null): boolean {
  return harnessId !== null && (STEERABLE_HARNESS_IDS as readonly string[]).includes(harnessId);
}
