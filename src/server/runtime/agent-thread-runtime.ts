import type {
  AgentInputRequest,
  ProviderInfo,
  RuntimeMutationEvent,
} from "../../shared/contracts";
import type { ConversationAttachmentStore } from "../../node/conversation-attachment-store";
import type { RuntimeStore } from "../database";
import type { ProviderManager } from "../providers";
import type { ProviderTerminalResumeRegistry } from "../provider/terminal-resume";
import { AgentThreadManager } from "./agent-thread-manager";
import type { BackendProfileController } from "./backends/backend-profile-controller";
import {
  ConversationCreationService,
} from "./conversation-creation-service";
import type { TurnController } from "./turns/turn-controller";
import type { WorkspaceRunController } from "./workspace-run-controller";
import {
  ConversationContextRequestCoordinator,
} from "./conversation-context-request-coordinator";
import type {
  RuntimeAgentBrowserBroker,
} from "./agent-browser-broker-client";
import type { AgentContextWatcherPolicy } from "./agent-context-tool";
import { AgentSecretService } from "./agent-secrets/agent-secret-service";
import type { RuntimeBackendCredentialBroker } from "../runtime-types";

interface AgentThreadRuntimeDependencies {
  store: RuntimeStore;
  providers: ProviderManager;
  backendProfileController: BackendProfileController;
  workspaceRuns: Pick<WorkspaceRunController<never>, "trackSourceControl">;
  dataDirectory: string;
  turns: TurnController;
  providerTerminalResumes: ProviderTerminalResumeRegistry;
  pendingInputs: Map<string, AgentInputRequest>;
  conversationAttachments?: Pick<ConversationAttachmentStore, "preview">;
  agentBrowser?: RuntimeAgentBrowserBroker;
  watcherPolicy?: AgentContextWatcherPolicy;
  backendCredentials?: RuntimeBackendCredentialBroker;
  lifetime?: AbortSignal;
  providerInfo(): readonly ProviderInfo[];
  broadcastSnapshot(): void;
  broadcastConversationShell(conversationId: string): void;
  broadcast(event: RuntimeMutationEvent): void;
}

export interface AgentThreadRuntime {
  creation: ConversationCreationService;
  manager: AgentThreadManager;
  contextRequests: ConversationContextRequestCoordinator;
  secrets: AgentSecretService;
}

/** Compose the one privileged creation path shared by UI and agent tools. */
export function createAgentThreadRuntime(
  dependencies: AgentThreadRuntimeDependencies,
): AgentThreadRuntime {
  const creation = new ConversationCreationService(dependencies);
  const contextRequests = new ConversationContextRequestCoordinator({
    pendingInputs: dependencies.pendingInputs,
    contextPackets: dependencies.store.contextPackets,
    broadcast: dependencies.broadcast,
    broadcastConversationShell: dependencies.broadcastConversationShell,
  });
  const secrets = new AgentSecretService({
    store: dependencies.store,
    dataDirectory: dependencies.dataDirectory,
    turns: dependencies.turns,
    broadcast: dependencies.broadcast,
    ...(dependencies.backendCredentials ? { credentials: dependencies.backendCredentials } : {}),
    ...(dependencies.lifetime ? { signal: dependencies.lifetime } : {}),
  });
  secrets.start();
  void secrets.restore();
  return {
    creation,
    contextRequests,
    secrets,
    manager: new AgentThreadManager({
      ...dependencies,
      contextRequests,
      creation,
      agentSecrets: secrets,
    }),
  };
}
