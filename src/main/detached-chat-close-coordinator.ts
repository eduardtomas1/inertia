import type { BrowserWindow } from "electron";

import type { DetachedChatMain } from "./detached-chat-main.js";

/** Lets detached renderers synchronously hand off their drafts before exit. */
export function coordinateMainWindowClose(
  window: BrowserWindow,
  detachedChats: DetachedChatMain,
  beforeClose: (window: BrowserWindow) => void,
): void {
  let prepared = false;
  let preparing = false;
  window.on("close", (event) => {
    beforeClose(window);
    if (prepared || detachedChats.summaries().length === 0) return;
    event.preventDefault();
    if (preparing) return;
    preparing = true;
    void detachedChats.closeAll().catch((error: unknown) => {
      console.error("Failed to close detached chats cleanly", error);
    }).finally(() => {
      preparing = false;
      prepared = true;
      if (!window.isDestroyed()) window.close();
    });
  });
}

export async function closeDetachedChatsForShutdown(
  detachedChats: DetachedChatMain | null,
): Promise<void> {
  try {
    await detachedChats?.shutdown();
  } catch (error) {
    console.error("Failed to close detached chats cleanly", error);
  }
}
