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
  ServerEvent,
} from "@shared/contracts";
import {
  clearMultiSpawnPreset,
  clearPendingMultiSpawnLaunchId,
  multiSpawnConversationPayload,
  readPendingMultiSpawnLaunchId,
  validateMultiSpawnDraft,
  writeMultiSpawnPreset,
  writePendingMultiSpawnLaunchId,
  type MultiSpawnDraft,
} from "../utils/multiSpawn";
import { resultEvent } from "../lib/runtimeCommands";
import type { CommandWithoutId } from "../lib/runtimeCommands";
import { runtimeCommandDelivery } from "../utils/connectionMessages";

type DuoPreparedResult = Extract<
  Extract<ServerEvent, { type: "request.result" }>["result"],
  { kind: "duo.prepared" }
>;
type DuoStatusResult = Extract<
  Extract<ServerEvent, { type: "request.result" }>["result"],
  { kind: "duo.status" }
>;

export interface MultiSpawnController {
  open: boolean;
  submitting: boolean;
  cancelling: boolean;
  error: string | null;
  openDialog: () => void;
  closeDialog: () => void;
  submit: (draft: MultiSpawnDraft) => Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "That duo could not be launched.";
}

function reconciliationMessage(detail: string): string {
  return "The connection changed while Inertia was preparing the duo. "
    + "The launch will not be retried automatically. Refresh to reconcile its "
    + `two chats safely. ${detail}`;
}

function launchStatusMessage(status: DuoStatusResult): string | null {
  if (status.state === "running") return null;
  if (status.error) return status.error;
  if (status.state === "cancelled") {
    return "The duo launch was cancelled before both providers began.";
  }
  if (status.state === "interrupted" || status.state === "recovery-required") {
    return "The duo needs recovery after an interrupted launch. Both chats remain visible; refresh before starting new work.";
  }
  if (status.state === "failed") {
    return "Neither side will be retried automatically. Open the two saved chats to inspect the launch failure.";
  }
  if (status.state === "prepared") {
    return "Both chats are saved and idle. The ambiguous launch was not dispatched automatically; open the saved chats to recover or start again deliberately.";
  }
  return `The duo is ${status.state}. Refresh before starting another launch.`;
}

function launchNeedsFurtherReconciliation(status: DuoStatusResult): boolean {
  return status.state === "preparing" || status.state === "dispatching";
}

function orderedPreparedSides(result: DuoPreparedResult): DuoPreparedResult["sides"] {
  const ordered = [...result.sides].sort((left, right) =>
    left.ordinal - right.ordinal);
  if (
    ordered.length !== 2
    || ordered[0]?.ordinal !== 0
    || ordered[1]?.ordinal !== 1
  ) {
    throw new Error("The local service returned an invalid duo assignment.");
  }
  return ordered as DuoPreparedResult["sides"];
}

export function useMultiSpawn({
  snapshot,
  settings,
  run,
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
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submittingRef = useRef(false);
  const cancellingRef = useRef(false);
  const activeLaunchIdRef = useRef<string | null>(null);
  const cancelRequestedRef = useRef(false);

  const activatePreparedConversations = useCallback(async (
    primaryConversationId: string,
    secondaryConversationId: string,
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

  const reconcilePendingLaunch = useCallback(async (
    launchId: string,
  ): Promise<void> => {
    try {
      const event = resultEvent(await run("multi-spawn:status", {
        type: "duo.status",
        payload: { launchId },
      }));
      if (event.result.kind !== "duo.status") {
        throw new Error("The local service returned an unexpected duo status.");
      }
      const message = launchStatusMessage(event.result);
      if (!launchNeedsFurtherReconciliation(event.result)) {
        clearPendingMultiSpawnLaunchId(window.localStorage);
      }
      if (message) setError(message);
    } catch (caught) {
      if (runtimeCommandDelivery(caught) === "rejected") {
        clearPendingMultiSpawnLaunchId(window.localStorage);
      }
      setError(
        "A previous duo launch could not be reconciled yet. Refresh before launching another pair.",
      );
    }
  }, [run]);

  const openDialog = useCallback(() => {
    if (!snapshot?.activeProjectId || submittingRef.current) return;
    setError(null);
    setOpen(true);
    const pendingLaunchId = readPendingMultiSpawnLaunchId(window.localStorage);
    if (pendingLaunchId) void reconcilePendingLaunch(pendingLaunchId);
  }, [reconcilePendingLaunch, snapshot?.activeProjectId]);

  const cancelActiveLaunch = useCallback(async (): Promise<void> => {
    const launchId = activeLaunchIdRef.current;
    if (!launchId || cancellingRef.current) return;
    cancelRequestedRef.current = true;
    cancellingRef.current = true;
    setCancelling(true);
    setError(null);
    try {
      const event = resultEvent(await run("multi-spawn:cancel", {
        type: "duo.cancel",
        payload: { launchId },
      }));
      if (event.result.kind !== "duo.status") {
        throw new Error("The local service returned an unexpected cancellation response.");
      }
      if (!launchNeedsFurtherReconciliation(event.result)) {
        clearPendingMultiSpawnLaunchId(window.localStorage);
      }
      setOpen(false);
      setActionError(launchStatusMessage(event.result));
      focusWorkspace();
    } catch (caught) {
      const message = runtimeCommandDelivery(caught) === "ambiguous"
        ? reconciliationMessage("Cancellation delivery was not confirmed.")
        : errorMessage(caught);
      setOpen(false);
      setActionError(message);
      focusWorkspace();
    } finally {
      cancellingRef.current = false;
      setCancelling(false);
    }
  }, [focusWorkspace, run, setActionError]);

  const closeDialog = useCallback(() => {
    if (submittingRef.current) {
      void cancelActiveLaunch();
      return;
    }
    setError(null);
    setOpen(false);
  }, [cancelActiveLaunch]);

  const submit = useCallback(async (draft: MultiSpawnDraft): Promise<void> => {
    if (submittingRef.current || !snapshot) return;
    const pendingLaunchId = readPendingMultiSpawnLaunchId(window.localStorage);
    if (pendingLaunchId) {
      setError("Reconciling the previous duo before accepting another launch.");
      await reconcilePendingLaunch(pendingLaunchId);
      return;
    }
    const validationError = validateMultiSpawnDraft(draft);
    if (validationError) {
      setError(validationError);
      return;
    }
    const launchId = crypto.randomUUID();
    activeLaunchIdRef.current = launchId;
    cancelRequestedRef.current = false;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    setActionError(null);
    if (!writePendingMultiSpawnLaunchId(window.localStorage, launchId)) {
      activeLaunchIdRef.current = null;
      submittingRef.current = false;
      setSubmitting(false);
      setError(
        "This browser cannot save a safe Duo recovery identity, so neither chat was launched.",
      );
      return;
    }

    let prepared = false;
    try {
      const prepareEvent = resultEvent(await run("multi-spawn:prepare", {
        type: "duo.prepare",
        payload: {
          launchId,
          prompt: draft.prompt.trim(),
          sides: [
            {
              ...multiSpawnConversationPayload(draft.sides[0], settings),
              activate: false,
            },
            {
              ...multiSpawnConversationPayload(draft.sides[1], settings),
              activate: false,
            },
          ],
        },
      }));
      if (prepareEvent.result.kind !== "duo.prepared") {
        throw new Error("The local service returned an unexpected duo response.");
      }
      prepared = true;
      const sides = orderedPreparedSides(prepareEvent.result);
      if (cancelRequestedRef.current) return;

      // The prepare receipt proves both conversation shells and queued turns
      // are durable. Only now may local navigation discard an unrelated draft.
      discardDraftConversation();
      await activatePreparedConversations(
        sides[0].conversationId,
        sides[1].conversationId,
      );
      setOpen(false);
      focusWorkspace();

      const presetStored = draft.rememberPreset
        ? writeMultiSpawnPreset(window.localStorage, draft)
        : clearMultiSpawnPreset(window.localStorage);
      if (!presetStored) {
        setActionError(
          draft.rememberPreset
            ? "The duo is prepared, but its default pairing could not be saved locally."
            : "The duo is prepared, but the previous default pairing could not be cleared locally.",
        );
      }
      if (cancelRequestedRef.current) return;

      const dispatchEvent = resultEvent(await run("multi-spawn:dispatch", {
        type: "duo.dispatch",
        payload: { launchId },
      }));
      if (dispatchEvent.result.kind !== "duo.status") {
        throw new Error("The local service returned an unexpected dispatch response.");
      }
      const launchMessage = launchStatusMessage(dispatchEvent.result);
      if (dispatchEvent.result.state === "running") {
        clearPendingMultiSpawnLaunchId(window.localStorage);
      }
      if (launchMessage) setActionError(launchMessage);
    } catch (caught) {
      const delivery = runtimeCommandDelivery(caught);
      if (!prepared && (delivery === "ambiguous" || delivery === null)) {
        setOpen(false);
        setActionError(reconciliationMessage(errorMessage(caught)));
        focusWorkspace();
        return;
      }
      if (!prepared) {
        clearPendingMultiSpawnLaunchId(window.localStorage);
        setError(errorMessage(caught));
        return;
      }
      setOpen(false);
      setActionError(
        delivery === "ambiguous" || delivery === null
          ? reconciliationMessage(errorMessage(caught))
          : `Both chats are saved and remain idle. ${errorMessage(caught)}`,
      );
      focusWorkspace();
    } finally {
      if (activeLaunchIdRef.current === launchId) {
        activeLaunchIdRef.current = null;
      }
      submittingRef.current = false;
      setSubmitting(false);
    }
  }, [
    activatePreparedConversations,
    discardDraftConversation,
    focusWorkspace,
    run,
    reconcilePendingLaunch,
    setActionError,
    settings,
    snapshot,
  ]);

  return {
    open,
    submitting,
    cancelling,
    error,
    openDialog,
    closeDialog,
    submit,
  };
}
