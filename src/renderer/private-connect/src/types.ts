import type { PrivateConnectSafeQuestion } from "../../../shared/private-connect/questions";

export type Shell = {
  generatedAt: string;
  projects: Array<{ id: string; name: string }>;
  conversations: Array<{ id: string; projectId: string; title: string; providerLabel: string; runId: string | null; status: string; pendingLocalApproval: boolean; pendingLocalAction: boolean; updatedAt: string }>;
  capabilities: { scopes: string[]; preset: "monitor" | "collaborate"; expiresAt: string };
};

export type Detail = {
  conversation: Shell["conversations"][number];
  messages: Array<{ id: string; role: "user" | "assistant"; content: string; createdAt: string; turnId: string | null }>;
  activities?: Array<{ id: string; kind: string; title: string; status: string; createdAt: string }>;
  subagents?: Array<{ id: string; providerLabel: string; name: string | null; status: string; updatedAt: string }>;
  plan?: { steps: Array<{ label: string; status: "pending" | "inProgress" | "completed" }> } | null;
  questions: PrivateConnectSafeQuestion[];
  inputRequestId?: string | null;
  waitingForLocalAction: boolean;
};
