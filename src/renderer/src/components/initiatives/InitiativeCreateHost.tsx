import type { AppSnapshot, ServerEvent } from "@shared/contracts";

import { useLoadedSurface } from "../../hooks/useLoadedSurface";
import type { CommandWithoutId } from "../../lib/runtimeCommands";
import { closeNewInitiativeRequest, useNewInitiativeRequest } from "../../utils/initiativeDialog";
import { loadInitiativeCreateDialog } from "../lazySurfaceLoaders";

/** Owns the single New initiative dialog for the main window. */
export function InitiativeCreateHost({ snapshot, run }: {
  snapshot: AppSnapshot | null;
  run: (key: string, command: CommandWithoutId, options?: { reportError?: boolean }) => Promise<ServerEvent>;
}): React.JSX.Element | null {
  const request = useNewInitiativeRequest();
  const InitiativeCreateDialog = useLoadedSurface(loadInitiativeCreateDialog, request !== null);
  if (!request || !InitiativeCreateDialog) return null;
  const chatTitle = request.conversationId
    ? snapshot?.conversations.find(({ id }) => id === request.conversationId)?.title
    : undefined;
  return (
    <InitiativeCreateDialog
      existingCount={snapshot?.initiatives?.length ?? 0}
      chatTitle={chatTitle}
      onCreate={async (name, color) => {
        const id = crypto.randomUUID();
        await run("initiative.create", {
          type: "initiative.create",
          payload: {
            id,
            name,
            color,
            ...(request.conversationId ? { conversationId: request.conversationId } : {}),
          },
        }, { reportError: false });
        request.onCreated?.(id);
      }}
      onClose={closeNewInitiativeRequest}
      returnFocus={request.returnFocus}
    />
  );
}
