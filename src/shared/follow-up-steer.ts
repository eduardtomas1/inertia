/**
 * Harnesses whose active turn accepts an acknowledged parent follow-up
 * ("steer"). The runtime admission check and the renderer composer share
 * this list so they cannot drift apart.
 */
export const STEERABLE_HARNESS_IDS = [
  "codex-app-server",
  "claude-agent-sdk",
  "opencode-sdk",
] as const;

export type SteerableHarnessId = (typeof STEERABLE_HARNESS_IDS)[number];

export function supportsActiveParentFollowUp(harnessId: string | null): boolean {
  return harnessId !== null && (STEERABLE_HARNESS_IDS as readonly string[]).includes(harnessId);
}
