import type { AgentWorkflowSkillsCapability } from "./contracts";

export function agentSkillsCapability(
  providerId: string,
  harnessId: string,
): AgentWorkflowSkillsCapability {
  if (providerId === "codex" && harnessId === "codex-app-server") {
    return { kind: "codex-native", available: true, label: "Codex skills" };
  }
  if (providerId === "claude" && harnessId === "claude-agent-sdk") {
    return { kind: "claude-native", available: true, label: "Claude skills" };
  }
  return {
    kind: "unavailable",
    available: false,
    label: "Skills unavailable",
    reason: "This route does not expose safe structured skill invocation.",
  };
}
