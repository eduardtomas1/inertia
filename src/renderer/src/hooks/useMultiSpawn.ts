import {
  useCallback,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type {
  AppSettings,
  AppSnapshot,
  ChatAttachment,
  ServerEvent,
  TurnRequestContext,
} from "@shared/contracts";
import {
  clearMultiSpawnPreset,
  multiSpawnConversationPayload,
  validateMultiSpawnDraft,
  writeMultiSpawnPreset,
  type MultiSpawnDraft,
} from "../utils/multiSpawn";
import { resultEvent } from "../lib/runtimeCommands";
import type { CommandWithoutId } from "../lib/runtimeCommands";
import { runtimeCommandDelivery } from "../utils/connectionMessages";

interface CreatedSide {
  index: 0 | 1;
  conversationId: string;
  title: string;
}

interface CreationFailure {
  message: string;
  deliveryAmbiguous: boolean;
}

export interface MultiSpawnController {
  open: boolean;
  submitting: boolean;
  error: string | null;
  openDialog: () => void;
  closeDialog: () => void;
  submit: (draft: MultiSpawnDraft) => Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "That chat could not be launched.";
}

function partialFailureMessage(
  created: readonly CreatedSide[],
  failures: readonly string[],
): string {
  const createdNames = created.map(({ title }) => `“${title}”`).join(" and ");
  const summary = created.length === 2
    ? "Both chat shells were created. One detail needs attention."
    : `Only ${createdNames} was created.`;
  return `${summary} ${failures.join(" ")}`;
}

function reconciliationMessage(failures: readonly string[]): string {
  return "The connection changed while Inertia was creating the duo. "
    + "Refresh before trying again so an acknowledged chat is not duplicated. "
    + failures.join(" ");
}

export function useMultiSpawn({
  snapshot,
  settings,
  run,
  sendMessage,
  splitSelectionTransitionsRef,
  updateSplitConversationId,
  showWorkspace,
  closeSidebar,
  focusWorkspace,
  discardDraftConversation,
  setActionError,
}: {
  snapshot: AppSnapshot | null;
  settings: AppSettings;
  run: (
    key: string,
    command: CommandWithoutId,
  ) => Promise<ServerEvent>;
  sendMessage: (
    conversationId: string,
    content: string,
    attachments: ChatAttachment[],
    context?: TurnRequestContext,
    skillIds?: readonly string[],
    activate?: boolean,
  ) => Promise<void>;
  splitSelectionTransitionsRef: MutableRefObject<number>;
  updateSplitConversationId: (conversationId: string | null) => void;
  showWorkspace: () => void;
  closeSidebar: () => void;
  focusWorkspace: () => void;
  discardDraftConversation: () => void;
  setActionError: Dispatch<SetStateAction<string | null>>;
}): MultiSpawnController {
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submittingRef = useRef(false);
  const activateCreatedConversations = useCallback(async (
    primaryConversationId: string,
    secondaryConversationId: string | null,
  ): Promise<void> => {
    splitSelectionTransitionsRef.current += 1;
    try {
      await run("multi-spawn:select", {
        type: "conversation.select",
        payload: { conversationId: primaryConversationId },
      });
      updateSplitConversationId(secondaryConversationId);
      showWorkspace();
      closeSidebar();
    } finally {
      window.setTimeout(() => {
        splitSelectionTransitionsRef.current = Math.max(
          0,
          splitSelectionTransitionsRef.current - 1,
        );
      }, 0);
    }
  }, [
    closeSidebar,
    run,
    showWorkspace,
    splitSelectionTransitionsRef,
    updateSplitConversationId,
  ]);

  const openDialog = useCallback(() => {
    if (!snapshot?.activeProjectId || submittingRef.current) return;
    setError(null);
    setOpen(true);
  }, [snapshot?.activeProjectId]);

  const closeDialog = useCallback(() => {
    if (submittingRef.current) return;
    setError(null);
    setOpen(false);
  }, []);

  const submit = useCallback(async (draft: MultiSpawnDraft): Promise<void> => {
    if (submittingRef.current || !snapshot) return;
    const validationError = validateMultiSpawnDraft(draft);
    if (validationError) {
      setError(validationError);
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    setActionError(null);

    try {
      const creations: (
        | { status: "fulfilled"; value: CreatedSide }
        | { status: "rejected"; reason: CreationFailure }
      )[] = [];
      for (const [index, side] of draft.sides.entries()) {
        try {
          const event = resultEvent(await run(
            `multi-spawn:create:${index}`,
            {
              type: "conversation.create",
              payload: multiSpawnConversationPayload(side, settings),
            },
          ));
          if (event.result.kind !== "conversation.created") {
            throw new Error("The local service returned an unexpected chat response.");
          }
          creations.push({ status: "fulfilled", value: {
            index: index as 0 | 1,
            conversationId: event.result.conversationId,
            title: side.title.trim(),
          } });
        } catch (reason) {
          const delivery = runtimeCommandDelivery(reason);
          creations.push({ status: "rejected", reason: {
            message: errorMessage(reason),
            deliveryAmbiguous: delivery === "ambiguous" || delivery === null,
          } });
        }
      }
      const created = creations.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : []);
      const creationFailures = creations.flatMap((result) =>
        result.status === "rejected" ? [result.reason.message] : []);
      const requiresReconciliation = creations.some((result) =>
        result.status === "rejected" && result.reason.deliveryAmbiguous);
      if (created.length === 0) {
        const message = creationFailures.join(" ")
          || "Neither chat could be created.";
        if (requiresReconciliation) {
          setOpen(false);
          setActionError(reconciliationMessage([message]));
          focusWorkspace();
        } else {
          setError(message);
        }
        return;
      }

      const ordered = [...created].sort((left, right) =>
        left.index - right.index);
      const launchFailures = [...creationFailures];
      // Keep an unrelated unsent draft intact until at least one durable duo
      // chat exists. From this point the workspace is intentionally switching.
      discardDraftConversation();
      try {
        await activateCreatedConversations(
          ordered[0]!.conversationId,
          ordered[1]?.conversationId ?? null,
        );
      } catch (activationError) {
        launchFailures.push(
          `Workspace: ${errorMessage(activationError)}`,
        );
      }
      setOpen(false);
      focusWorkspace();

      const sends = await Promise.allSettled(ordered.map((side) =>
        sendMessage(
          side.conversationId,
          draft.prompt.trim(),
          [],
          undefined,
          undefined,
          false,
        )));
      const sendFailures = sends.flatMap((result, index) =>
        result.status === "rejected"
          ? [`${ordered[index]!.title}: ${errorMessage(result.reason)}`]
          : []);
      const failures = [...launchFailures, ...sendFailures];
      if (requiresReconciliation) {
        failures.unshift(
          "Refresh before recreating the missing chat because its delivery was not confirmed.",
        );
      }
      const presetStored = draft.rememberPreset
        ? writeMultiSpawnPreset(window.localStorage, draft)
        : clearMultiSpawnPreset(window.localStorage);
      if (!presetStored) {
        failures.push(
          draft.rememberPreset
            ? "The default duo could not be saved locally."
            : "The previous default duo could not be cleared locally.",
        );
      }
      if (failures.length > 0) {
        setActionError(partialFailureMessage(ordered, failures));
      }
    } catch (caught) {
      const message = errorMessage(caught);
      setError(message);
      setActionError(message);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }, [
    activateCreatedConversations,
    discardDraftConversation,
    focusWorkspace,
    run,
    sendMessage,
    setActionError,
    settings,
    snapshot,
  ]);

  return {
    open,
    submitting,
    error,
    openDialog,
    closeDialog,
    submit,
  };
}
