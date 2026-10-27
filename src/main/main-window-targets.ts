import type { MainWindowTarget, MainWindowTargetRequest } from "../shared/desktop.js";
import { DESKTOP_IPC } from "../shared/desktop-ipc.js";
import { DETACHED_CHAT_IPC } from "../shared/detached-chat-ipc.js";
import {
  activateMainWindow,
  activateThreadNotification,
  type ThreadNotificationActivationDependencies,
} from "./thread-notification-activation.js";

export type MainWindowTargetDependencies = Omit<
  ThreadNotificationActivationDependencies,
  "channel"
>;

export interface MainWindowTargetHandlers {
  onDock(conversationId: string): Promise<void>;
  onOpenInMainWindow(
    sourceConversationId: string,
    target: MainWindowTarget,
  ): Promise<void>;
}

export function mainWindowTargetHandlers(
  dependencies: MainWindowTargetDependencies,
): MainWindowTargetHandlers {
  return {
    onDock: (conversationId) => activateThreadNotification(conversationId, {
      ...dependencies,
      channel: DESKTOP_IPC.threadNotificationActivated,
    }),
    onOpenInMainWindow: (sourceConversationId, target) => activateMainWindow(
      { sourceConversationId, target } satisfies MainWindowTargetRequest,
      { ...dependencies, channel: DETACHED_CHAT_IPC.mainWindowTarget },
    ),
  };
}
