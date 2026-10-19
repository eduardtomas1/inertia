import type WebSocket from "ws";

import type {
  AppUnderTestLogsAppendedEvent,
  AppUnderTestMutationEvent,
  AppUnderTestWindowsUpdatedEvent,
} from "../../../shared/app-under-test";
import type { ServerEvent } from "../../../shared/contracts";
import type { RuntimeStore } from "../../database";
import type { RuntimeCommandHandler } from "../commands/command-router";
import { createAppUnderTestCommandHandler } from "../commands/app-under-test-commands";
import { createCdpTransportFactory } from "./cdp-window-transport";
import { AppUnderTestLaunchManager, type AppUnderTestLaunchManagerOptions } from "./launch-manager";
import type { CdpTransportFactory } from "./window-transport";

export interface AppUnderTestRuntimeWiringOptions {
  dataDirectory: string;
  store: Pick<RuntimeStore, "conversation" | "conversationPath" | "project">;
  /** True once the runtime began shutting down; nothing is emitted after that. */
  closed(): boolean;
  broadcast(event: AppUnderTestMutationEvent): void;
  runtimeSync: {
    sendToConversationSubscribers(
      conversationId: string,
      event: AppUnderTestLogsAppendedEvent | AppUnderTestWindowsUpdatedEvent,
    ): void;
  };
  send(socket: WebSocket, event: ServerEvent): void;
  onCleanupUnconfirmed?: (() => void) | undefined;
  // Test seams; production callers omit them.
  cdpTransports?: CdpTransportFactory;
  launchManager?: Partial<AppUnderTestLaunchManagerOptions>;
}

export interface AppUnderTestRuntimeWiring {
  launches: AppUnderTestLaunchManager;
  commandHandler: RuntimeCommandHandler;
  /** Chat archive: stops its launches and forgets its App session. */
  forgetConversation(conversationId: string): void;
  /**
   * Chat delete or project removal, awaited before a worktree is removed:
   * resolves false while a launch of the chat is not proved stopped.
   */
  clearConversation(conversationId: string): Promise<boolean>;
  /** Runtime shutdown drain; rejects when cleanup of a launch could not be proved. */
  dispose(): Promise<void>;
}

/**
 * Wires the runtime-owned "app under test" launches into the runtime:
 * processes belong to this runtime like terminals, so chat delete or archive,
 * cancellation and shutdown stop their trees. Mutation events are broadcast
 * and replayed; high-volume log lines and window lists go only to sockets
 * subscribed to the chat.
 */
export function createAppUnderTestRuntimeWiring(options: AppUnderTestRuntimeWiringOptions): AppUnderTestRuntimeWiring {
  const { store } = options;
  const launches = new AppUnderTestLaunchManager({
    dataDirectory: options.dataDirectory,
    workspace: (conversationId) => {
      const conversation = store.conversation(conversationId);
      return {
        root: store.conversationPath(conversationId),
        actions: store.project(conversation.projectId).preferences?.actions ?? [],
      };
    },
    emit: (event) => {
      if (options.closed()) return;
      if (event.type === "app-under-test.logs.appended" || event.type === "app-under-test.windows.updated") {
        options.runtimeSync.sendToConversationSubscribers(event.conversationId, event);
      } else {
        options.broadcast(event);
      }
    },
    cdpTransports: options.cdpTransports ?? createCdpTransportFactory(),
    ...(options.onCleanupUnconfirmed ? { onCleanupUnconfirmed: options.onCleanupUnconfirmed } : {}),
    ...options.launchManager,
  });
  return {
    launches,
    commandHandler: createAppUnderTestCommandHandler({
      launches,
      assertConversation: (conversationId) => { store.conversation(conversationId); },
      send: options.send,
    }),
    forgetConversation: (conversationId) => {
      void launches.clear(conversationId).catch(() => undefined);
    },
    clearConversation: async (conversationId) => await launches.clear(conversationId).catch(() => false),
    dispose: async () => {
      if (!await launches.dispose()) throw new Error("App under test cleanup could not be confirmed.");
    },
  };
}
