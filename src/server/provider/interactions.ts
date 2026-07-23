import type {
  AgentApprovalDecision,
  AgentInputQuestion,
  AgentPlanStep,
} from "../../shared/contracts";

export type { AgentApprovalDecision, AgentInputQuestion, AgentPlanStep };

export type AgentApprovalKind = "command" | "file-change" | "permissions";

export interface AgentApprovalNetworkScope {
  host: string;
  protocol: "http" | "https" | "socks5Tcp" | "socks5Udp";
}

export interface AgentApprovalPermissionRoot {
  path: string;
  access: "read" | "write";
}

/** Provider-neutral approval payload emitted by an interactive transport. */
export interface AgentApprovalRequest {
  requestId: string;
  kind: AgentApprovalKind;
  title: string;
  detail?: string;
  command?: string;
  cwd?: string;
  reason?: string;
  networkScope?: AgentApprovalNetworkScope;
  permissionRoots: AgentApprovalPermissionRoot[];
  availableDecisions: AgentApprovalDecision[];
}

/** Provider-neutral input payload emitted by an interactive transport. */
export interface AgentInputRequest {
  requestId: string;
  questions: AgentInputQuestion[];
  autoResolutionMs: number | null;
}
