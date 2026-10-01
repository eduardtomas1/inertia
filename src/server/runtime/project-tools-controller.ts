import type { Conversation } from "../../shared/contracts";
import { projectToolTokenReference, projectToolViewSchema, type ProjectTool, type ProjectToolsView } from "../../shared/project-tools";
import type { RuntimeStore } from "../database";
import { RuntimeRequestError } from "../runtime-errors";
import type { ProjectToolObservation, ProjectToolRun } from "../provider/project-tools";

interface RunEvidence {
  refresh?: () => Promise<void>;
  refreshing?: Promise<void>;
  runId: string;
  projectId: string;
  connections: readonly ProjectTool[];
  observations: Map<string, ProjectToolObservation & { checkedAt: string }>;
}

export class ProjectToolsController {
  private readonly runs = new Map<string, RunEvidence>();
  constructor(private readonly store: Pick<RuntimeStore, "project" | "conversation" | "projectTools">,
    private readonly credentials?: { resolve(reference: string, signal?: AbortSignal): Promise<string | null> }) {}

  begin(conversation: Conversation, runId: string): ProjectToolRun | undefined {
    this.runs.delete(conversation.id);
    const provider = conversation.providerId;
    if (!this.supported(conversation)) return undefined;
    const connections = this.store.projectTools.list(conversation.projectId)
      .filter((entry) => entry.providers.some((id) => id === provider));
    const evidence: RunEvidence = { runId, projectId: conversation.projectId, connections, observations: new Map() };
    this.runs.set(conversation.id, evidence);
    return {
      connections,
      setRefresh: (refresh) => { if (this.runs.get(conversation.id) === evidence) evidence.refresh = refresh; },
      resolveToken: (variable, signal) => this.credentials?.resolve(projectToolTokenReference(variable), signal) ?? Promise.resolve(null),
      report: (observation) => {
        if (this.runs.get(conversation.id) !== evidence) return;
        const connection = connections.find((entry) => entry.id === observation.id);
        if (!connection) return;
        const checkedAt = new Date().toISOString();
        const parsed = projectToolViewSchema.safeParse({ ...connection, ...observation, checkedAt });
        if (parsed.success) evidence.observations.set(connection.id, { ...observation, checkedAt });
      },
    };
  }

  async refresh(projectId: string, conversationId?: string): Promise<void> {
    this.view(projectId, conversationId); // Enforce project/chat ownership before any provider call.
    const evidence = conversationId ? this.runs.get(conversationId) : undefined;
    if (!evidence?.refresh) return;
    evidence.refreshing ??= evidence.refresh().finally(() => { evidence.refreshing = undefined; });
    await evidence.refreshing;
  }

  assertRemovable(projectId: string, id: string): void {
    if ([...this.runs.values()].some((run) => run.projectId === projectId
      && run.connections.some((connection) => connection.id === id))) {
      throw new RuntimeRequestError("This connection is loaded by a running chat. Stop the chat or let it finish before removing the connection.");
    }
  }

  finish(conversationId: string, runId: string): void {
    if (this.runs.get(conversationId)?.runId === runId) this.runs.delete(conversationId);
  }

  view(projectId: string, conversationId?: string): ProjectToolsView {
    this.store.project(projectId);
    const conversation = conversationId ? this.store.conversation(conversationId) : null;
    if (conversation && conversation.projectId !== projectId) throw new RuntimeRequestError("This chat does not belong to the selected project.");
    const run = conversationId ? this.runs.get(conversationId) : undefined;
    return { projectId, conversationId: conversationId ?? null, connections: this.store.projectTools.list(projectId).map((connection) => {
      const base = { ...connection, toolNames: [], checkedAt: null };
      const previous = run?.connections.find((entry) => entry.id === connection.id);
      // Any edit, including disabling a provider, leaves the old connection in
      // a running process until the run ends. Never claim immediate revocation.
      if (run && (previous || connection.providers.some((id) => id === conversation?.providerId))
        && previous?.revision !== connection.revision) return {
        ...base, state: "needs-restart" as const, reason: "This run keeps its original tool configuration. Stop it or let it finish; the next message loads your changes.",
      };
      if (conversation && (!this.supported(conversation) || !connection.providers.some((id) => id === conversation.providerId))) return {
        ...base, state: "unsupported" as const, reason: "Enable this connection for Claude or Codex. Other providers and compatibility CLI routes are not supported yet.",
      };
      const observation = run?.observations.get(connection.id);
      return observation ? { ...connection, ...observation } : {
        ...base, state: "configured" as const, reason: run
          ? "Waiting for this chat's provider to confirm its tools."
          : "Connects when you send the next message. Availability is checked on that chat's live provider connection.",
      };
    }) };
  }

  private supported(conversation: Conversation): boolean {
    return (conversation.providerId === "claude" && conversation.modelSelection.harnessId === "claude-agent-sdk")
      || (conversation.providerId === "codex" && conversation.modelSelection.harnessId === "codex-app-server");
  }
}
