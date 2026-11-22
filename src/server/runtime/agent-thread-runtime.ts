import { join } from "node:path";

import type {
  AgentApprovalRequest,
  AgentInputRequest,
  ProviderInfo,
  RuntimeMutationEvent,
} from "../../shared/contracts";
import type { ConversationAttachmentStore } from "../../node/conversation-attachment-store";
import type { RuntimeStore } from "../database";
import type { ProviderManager } from "../providers";
import type { ProviderTerminalResumeRegistry } from "../provider/terminal-resume";
import { createCadHosts } from "../cad/cad-hosts";
import { environmentValue } from "../environment";
import { CadService } from "../cad/cad-service";
import { AgentThreadManager } from "./agent-thread-manager";
import type { ManagedMessageQueue } from "./managed-send-modes";
import type { BackendProfileController } from "./backends/backend-profile-controller";
import {
  ConversationCreationService,
} from "./conversation-creation-service";
import type { TurnController } from "./turns/turn-controller";
import type { WorkspaceRunController } from "./workspace-run-controller";
import type { TurnGitArtifactManager } from "../turn-git-artifacts";
import {
  ConversationContextRequestCoordinator,
} from "./conversation-context-request-coordinator";
import type {
  RuntimeAgentBrowserBroker,
} from "./agent-browser-broker-client";
import type { AgentContextWatcherPolicy } from "./agent-context-tool";
import { AgentSecretService } from "./agent-secrets/agent-secret-service";
import { CadHostTools } from "./cad-host-tools";
import type { RuntimeBackendCredentialBroker } from "../runtime-types";

interface AgentThreadRuntimeDependencies {
  store: RuntimeStore;
  providers: ProviderManager;
  backendProfileController: BackendProfileController;
  workspaceRuns: Pick<WorkspaceRunController<never>, "trackSourceControl" | "listActions">;
  turnGitArtifacts?: Pick<TurnGitArtifactManager, "turnDiff" | "liveTurnDiff" | "settledTurnDiffWithin">;
  dataDirectory: string;
  agentSecretDirectory?: string | undefined;
  turns: TurnController;
  providerTerminalResumes: ProviderTerminalResumeRegistry;
  pendingInputs: Map<string, AgentInputRequest>;
  pendingApprovals: ReadonlyMap<string, AgentApprovalRequest>;
  /** The queue runtime, which starts after the manager. */
  messageQueue(): ManagedMessageQueue | undefined;
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
    dataDirectory: dependencies.agentSecretDirectory ?? dependencies.dataDirectory,
    turns: dependencies.turns.secretRequests,
    broadcast: dependencies.broadcast,
    ...(dependencies.backendCredentials ? { credentials: dependencies.backendCredentials } : {}),
    ...(dependencies.lifetime ? { signal: dependencies.lifetime } : {}),
  });
  secrets.start();
  void secrets.restore();
  const cadDirectory = join(dependencies.dataDirectory, "cad");
  // AutoCAD and SketchUp desktop run only on Windows and macOS; elsewhere the pack is never offered.
  const cadTools = process.platform === "win32" || process.platform === "darwin"
    ? new CadHostTools(new CadService({
      hosts: createCadHosts(cadDirectory),
      stateDirectory: cadDirectory,
      exports: {
        programFiles: environmentValue(process.env, "ProgramFiles"),
        systemRoot: environmentValue(process.env, "SystemRoot"),
      },
    }))
    : undefined;
  return {
    creation,
    contextRequests,
    secrets,
    manager: new AgentThreadManager({
      ...dependencies,
      contextRequests,
      creation,
      agentSecrets: secrets,
      ...(cadTools ? { cadTools } : {}),
    }),
  };
}
