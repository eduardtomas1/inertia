import type { ProviderInfo } from "../../shared/contracts";
import type { RuntimeStore } from "../database";
import type { ProviderManager } from "../providers";
import { AgentThreadManager } from "./agent-thread-manager";
import type { BackendProfileController } from "./backends/backend-profile-controller";
import {
  ConversationCreationService,
} from "./conversation-creation-service";
import type { TurnController } from "./turns/turn-controller";
import type { WorkspaceRunController } from "./workspace-run-controller";

interface AgentThreadRuntimeDependencies {
  store: RuntimeStore;
  providers: ProviderManager;
  backendProfileController: BackendProfileController;
  workspaceRuns: Pick<WorkspaceRunController<never>, "trackSourceControl">;
  dataDirectory: string;
  turns: TurnController;
  providerInfo(): readonly ProviderInfo[];
  broadcastSnapshot(): void;
  broadcastConversationShell(conversationId: string): void;
}

export interface AgentThreadRuntime {
  creation: ConversationCreationService;
  manager: AgentThreadManager;
}

/** Compose the one privileged creation path shared by UI and agent tools. */
export function createAgentThreadRuntime(
  dependencies: AgentThreadRuntimeDependencies,
): AgentThreadRuntime {
  const creation = new ConversationCreationService(dependencies);
  return {
    creation,
    manager: new AgentThreadManager({ ...dependencies, creation }),
  };
}
