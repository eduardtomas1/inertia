export const AGENT_GOAL_STATUSES = [
  "active",
  "paused",
  "blocked",
  "usageLimited",
  "budgetLimited",
  "complete",
] as const;

export type AgentGoalStatus = (typeof AGENT_GOAL_STATUSES)[number];
export type AgentGoalSource = "codex-native" | "inertia-local";

/**
 * A truthful projection of one current goal. Native Codex goals mirror the
 * provider thread. Inertia-local goals are intentionally product-owned and
 * are never presented as provider context or silently injected into a turn.
 */
export interface AgentGoal {
  conversationId: string;
  source: AgentGoalSource;
  /** Exact native provider thread; null for explicitly Inertia-owned goals. */
  providerSessionId: string | null;
  objective: string;
  status: AgentGoalStatus;
  tokenBudget: number | null;
  tokensUsed: number | null;
  timeUsedSeconds: number | null;
  createdAt: string;
  updatedAt: string;
  synchronizedAt: string | null;
}

export type AgentSkillScope =
  | "user"
  | "repo"
  | "system"
  | "admin"
  | "provider";

/**
 * Renderer-safe skill metadata. `id` is an ephemeral runtime capability; the
 * provider-owned path and skill contents never cross the runtime boundary.
 */
export interface AgentSkillSummary {
  id: string;
  conversationId: string;
  name: string;
  description: string;
  shortDescription: string | null;
  scope: AgentSkillScope;
  enabled: boolean;
  source: "codex-native" | "claude-native";
}

export type AgentWorkflowGoalCapability =
  | {
      kind: "codex-native";
      available: true;
      label: "Codex native goal";
    }
  | {
      kind: "inertia-local";
      available: true;
      label: "Inertia local goal";
      reason: string;
    };

export type AgentWorkflowSkillsCapability =
  | {
      kind: "codex-native";
      available: true;
      label: "Codex skills";
    }
  | {
      kind: "claude-native";
      available: true;
      label: "Claude skills";
    }
  | {
      kind: "unavailable";
      available: false;
      label: "Skills unavailable";
      reason: string;
    };

export interface AgentWorkflowState {
  conversationId: string;
  goals: AgentGoal[];
  goalCapability: AgentWorkflowGoalCapability;
  skills: AgentSkillSummary[];
  skillsCapability: AgentWorkflowSkillsCapability;
  goalRefreshWarning: string | null;
  skillDiscovery: {
    truncated: boolean;
    warningCount: number;
    synchronizedAt: string | null;
  };
  refreshedAt: string;
}

/** Resolved only inside the privileged local runtime. */
export type ProviderSkillInput =
  | {
      source: "codex-native";
      name: string;
      path: string;
    }
  | {
      source: "claude-native";
      name: string;
    };
