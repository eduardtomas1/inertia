import {
  useCallback,
  useEffect,
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
  multiSpawnComparisonPayload,
  multiSpawnConversationPayload,
  validateMultiSpawnDraft,
  writeMultiSpawnPreset,
  writePendingMultiSpawnLaunchId,
  type IdentifiedDuoRecoveryGuidance,
  type MultiSpawnDraft,
} from "../utils/multiSpawn";
import { resultEvent } from "../lib/runtimeCommands";
import type { CommandWithoutId } from "../lib/runtimeCommands";
import { runtimeCommandDelivery } from "../utils/connectionMessages";

type DuoPreparedResult = Extract<
  Extract<ServerEvent, { type: "request.result" }>["result"],
  { kind: "duo.prepared" }
>;
type DuoPendingResult = Extract<
  Extract<ServerEvent, { type: "request.result" }>["result"],
  { kind: "duo.pending" }
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
  recoveryGuidance: IdentifiedDuoRecoveryGuidance[];
  recoveryStatus: DuoStatusResult | null;
  recheckingRecovery: boolean;
  acknowledgingRecovery: boolean;
  retryingComparison: boolean;
  cancellingComparison: boolean;
  openDialog: () => void;
  closeDialog: () => void;
  submit: (draft: MultiSpawnDraft) => Promise<void>;
  recheckRecovery: () => Promise<void>;
  acknowledgeRecovery: () => Promise<void>;
  retryComparison: () => Promise<void>;
  cancelComparison: () => Promise<void>;
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
  const comparison = status.comparison;
  if (comparison?.state === "failed") {
    return comparison.error
      ?? "The third-model judge failed. The two source results remain locked; retry explicitly or cancel the comparison.";
  }
  if (comparison?.state === "interrupted") {
    return comparison.error
      ?? "The third-model judge was interrupted and was not retried automatically. The source results remain locked.";
  }
  if (status.state === "running") return null;
  const startedRoutes: number[] = [];
  const failedRoutes: number[] = [];
  for (const { dispatchState, ordinal } of status.sides) {
    if (dispatchState === "started") startedRoutes.push(ordinal + 1);
    if (dispatchState === "failed") failedRoutes.push(ordinal + 1);
  }
  if (startedRoutes.length > 0 && failedRoutes.length > 0) {
    return `Provider dispatch was partial: route ${startedRoutes.join(", ")} accepted a start while route ${failedRoutes.join(", ")} failed. Inertia requested cancellation for started work, but provider-side effects are not atomic. Inspect both saved chats; nothing will be retried automatically.`;
  }
  if (status.error) return status.error;
  if (status.state === "cancelled") {
    return "The duo launch was cancelled before both providers began.";
  }
  if (status.state === "interrupted" || status.state === "recovery-required") {
    return status.state === "interrupted"
      ? "Duo dispatch was durably claimed, but one or both provider outcomes are uncertain. Provider-side effects are not atomic and nothing will be retried automatically. Inspect both saved chats and re-check the status."
      : "The duo needs manual Git recovery. Inertia retained uncertain worktree or branch state and will not delete it automatically. Inspect the exact topology, complete any safe manual command, then re-check recovery status.";
  }
  if (status.state === "failed") {
    return "Neither side will be retried automatically. Open the two saved chats to inspect the launch failure.";
  }
  if (status.state === "prepared") {
    return "Both chats are saved and idle. The ambiguous launch was not dispatched automatically; open the saved chats to recover or start again deliberately.";
  }
  return `The duo is ${status.state}. Refresh before starting another launch.`;
}

function launchRetainsRecoveryIdentity(status: DuoStatusResult): boolean {
  const comparisonState = status.comparison?.state;
  return status.state === "preparing"
    || status.state === "prepared"
    || status.state === "dispatching"
    || status.state === "recovery-required"
    || status.state === "interrupted"
    || comparisonState === "waiting"
    || comparisonState === "dispatching"
    || comparisonState === "running"
    || comparisonState === "failed"
    || comparisonState === "interrupted";
}

function identifiedRecoveryGuidance(
  status: DuoStatusResult,
): IdentifiedDuoRecoveryGuidance[] {
  return (status.recoveryGuidance ?? []).map((guidance) => ({
    ...guidance,
    launchId: status.launchId,
  }));
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
  request,
  splitConversationId = null,
  conversationSelectionGenerationRef,
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
  request: (command: CommandWithoutId) => Promise<ServerEvent>;
  splitConversationId?: string | null;
  conversationSelectionGenerationRef?: MutableRefObject<number>;
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
  const [recoveryGuidance, setRecoveryGuidance] = useState<
    IdentifiedDuoRecoveryGuidance[]
  >([]);
  const [recoveryStatus, setRecoveryStatusState] =
    useState<DuoStatusResult | null>(null);
  const [recheckingRecovery, setRecheckingRecovery] = useState(false);
  const [acknowledgingRecovery, setAcknowledgingRecovery] = useState(false);
  const [retryingComparison, setRetryingComparison] = useState(false);
  const [cancellingComparison, setCancellingComparison] = useState(false);
  const recoveryStatusRef = useRef<DuoStatusResult | null>(null);
  const recoveryProjectIdsRef = useRef<string[]>([]);
  const submittingRef = useRef(false);
  const cancellingRef = useRef(false);
  const activeLaunchIdRef = useRef<string | null>(null);
  const cancelRequestedRef = useRef(false);
  const operationGenerationRef = useRef(0);
  const splitConversationIdRef = useRef(splitConversationId);
  const watchedComparisonRef = useRef<{
    launchId: string;
    primaryConversationId: string;
    secondaryConversationId: string;
    seenPair: boolean;
    navigationGeneration: number;
  } | null>(null);
  const comparisonOpenedRef = useRef<string | null>(null);
  splitConversationIdRef.current = splitConversationId;

  const setRecoveryStatus = useCallback((
    status: DuoStatusResult | null,
  ): void => {
    recoveryStatusRef.current = status;
    setRecoveryStatusState(status);
  }, []);

  useEffect(() => () => {
    operationGenerationRef.current += 1;
  }, []);

  const activatePreparedConversations = useCallback(async (
    primaryConversationId: string,
    secondaryConversationId: string,
    isCurrent: () => boolean,
  ): Promise<boolean> => {
    splitSelectionTransitionsRef.current += 1;
    try {
      await run("multi-spawn:select", {
        type: "conversation.select",
        payload: { conversationId: primaryConversationId },
      });
      if (!isCurrent()) return false;
      updateSplitConversationId(secondaryConversationId);
      showWorkspace();
      closeSidebar();
      return true;
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

  const queryLaunchStatus = useCallback(async (
    launchId: string,
  ): Promise<DuoStatusResult> => {
    const event = resultEvent(await run("multi-spawn:status", {
      type: "duo.status",
      payload: { launchId },
    }));
    if (event.result.kind !== "duo.status") {
      throw new Error("The local service returned an unexpected duo status.");
    }
    return event.result;
  }, [run]);

  const queryLaunchStatusInBackground = useCallback(async (
    launchId: string,
  ): Promise<DuoStatusResult> => {
    const event = resultEvent(await request({
      type: "duo.status",
      payload: { launchId },
    }));
    if (event.result.kind !== "duo.status") {
      throw new Error("The local service returned an unexpected duo status.");
    }
    return event.result;
  }, [request]);

  useEffect(() => {
    const comparisonState = recoveryStatus?.comparison?.state;
    if (
      !recoveryStatus
      || (
        comparisonState !== "waiting"
        && comparisonState !== "dispatching"
        && comparisonState !== "running"
      )
    ) return;
    let cancelled = false;
    let timer: number | null = null;
    const poll = (): void => {
      void queryLaunchStatusInBackground(recoveryStatus.launchId).then((status) => {
        if (cancelled) return;
        setRecoveryGuidance(identifiedRecoveryGuidance(status));
        setRecoveryStatus(status);
        if (!launchRetainsRecoveryIdentity(status)) {
          clearPendingMultiSpawnLaunchId(window.localStorage);
        }
        const message = launchStatusMessage(status);
        if (message) setActionError(message);
      }).catch(() => {
        if (cancelled) return;
        // A transient read must not replace authoritative launch state. Retry
        // slowly while this exact comparison remains live.
        timer = window.setTimeout(poll, 1_250);
      });
    };
    timer = window.setTimeout(poll, 750);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [
    queryLaunchStatusInBackground,
    recoveryStatus,
    setActionError,
    setRecoveryStatus,
  ]);

  useEffect(() => {
    const watched = watchedComparisonRef.current;
    if (!watched || recoveryStatus?.launchId !== watched.launchId) return;
    if (
      conversationSelectionGenerationRef
      && conversationSelectionGenerationRef.current
        !== watched.navigationGeneration
    ) {
      watchedComparisonRef.current = null;
      return;
    }
    const stillViewingPair = snapshot?.activeConversationId
      === watched.primaryConversationId
      && splitConversationId === watched.secondaryConversationId;
    if (!watched.seenPair) {
      if (stillViewingPair) watched.seenPair = true;
      else return;
    }
    if (!stillViewingPair) {
      watchedComparisonRef.current = null;
      return;
    }
    const comparison = recoveryStatus.comparison;
    if (
      comparison?.state !== "completed"
      || !comparison.conversationId
      || comparisonOpenedRef.current === watched.launchId
    ) return;
    comparisonOpenedRef.current = watched.launchId;
    watchedComparisonRef.current = null;
    splitSelectionTransitionsRef.current += 1;
    void run("multi-spawn:comparison:select", {
      type: "conversation.select",
      payload: { conversationId: comparison.conversationId },
    }).then(() => {
      if (
        splitConversationIdRef.current !== watched.secondaryConversationId
        || (
          conversationSelectionGenerationRef
          && conversationSelectionGenerationRef.current
            !== watched.navigationGeneration
        )
      ) {
        return;
      }
      updateSplitConversationId(null);
      showWorkspace();
      closeSidebar();
      focusWorkspace();
    }).catch((caught) => {
      comparisonOpenedRef.current = null;
      setActionError(
        `The comparison finished, but its chat could not be opened. ${errorMessage(caught)}`,
      );
    }).finally(() => {
      splitSelectionTransitionsRef.current = Math.max(
        0,
        splitSelectionTransitionsRef.current - 1,
      );
    });
  }, [
    closeSidebar,
    conversationSelectionGenerationRef,
    focusWorkspace,
    recoveryStatus,
    run,
    setActionError,
    showWorkspace,
    snapshot?.activeConversationId,
    splitConversationId,
    splitSelectionTransitionsRef,
    updateSplitConversationId,
  ]);

  const reconcilePendingLaunch = useCallback(async (
    launchId: string,
    isCurrent: () => boolean,
  ): Promise<DuoStatusResult | null> => {
    let status = await queryLaunchStatus(launchId);
    if (!isCurrent()) return null;
    if (
      status.state === "prepared"
      || status.state === "recovery-required"
    ) {
      const cancellation = resultEvent(await run("multi-spawn:cancel", {
        type: "duo.cancel",
        payload: { launchId },
      }));
      if (!isCurrent()) return null;
      if (cancellation.result.kind !== "duo.status") {
        throw new Error(
          "The local service returned an unexpected Duo recovery response.",
        );
      }
      status = cancellation.result;
    }
    return status;
  }, [queryLaunchStatus, run]);

  const queryPendingLaunches = useCallback(async (
    projectIds: readonly string[],
  ): Promise<DuoPendingResult> => {
    const event = resultEvent(await run("multi-spawn:pending", {
      type: "duo.pending",
      payload: { projectIds: [...new Set(projectIds)] },
    }));
    if (event.result.kind !== "duo.pending") {
      throw new Error("The local service returned an unexpected pending Duo result.");
    }
    return event.result;
  }, [run]);

  const reconcileProjectLaunches = useCallback(async (
    projectIds: readonly string[],
    generation: number,
  ): Promise<"blocked" | "clear" | "stale"> => {
    const isCurrent = () => operationGenerationRef.current === generation;
    if (isCurrent()) {
      recoveryProjectIdsRef.current = [...new Set(projectIds)];
    }
    try {
      const pending = await queryPendingLaunches(projectIds);
      if (!isCurrent()) return "stale";
      clearPendingMultiSpawnLaunchId(window.localStorage);
      const statuses: DuoStatusResult[] = [];
      let reconciliationFailed = false;
      for (const launchId of pending.launchIds) {
        try {
          const status = await reconcilePendingLaunch(launchId, isCurrent);
          if (!isCurrent() || !status) return "stale";
          statuses.push(status);
        } catch {
          if (!isCurrent()) return "stale";
          reconciliationFailed = true;
        }
      }
      const retained = statuses.filter(launchRetainsRecoveryIdentity);
      setRecoveryStatus(retained[0] ?? statuses[0] ?? null);
      setRecoveryGuidance(retained.flatMap(identifiedRecoveryGuidance));
      const retainedMessages = retained.map(launchStatusMessage).filter(
        (message): message is string => Boolean(message),
      );
      const statusMessages = statuses.map(launchStatusMessage).filter(
        (message): message is string => Boolean(message),
      );
      if (reconciliationFailed) {
        setError(
          "One or more previous duo launches could not be reconciled yet. Refresh before launching another pair.",
        );
        return "blocked";
      }
      if (pending.hasMore) {
        setError(
          "More previous duo launches need reconciliation for these projects. Reconcile again before starting another pair.",
        );
        return "blocked";
      }
      if (retained.length > 1) {
        setError(
          `${retained.length} previous duo launches still need recovery. ${retainedMessages.join(" ")}`,
        );
      } else if (retainedMessages[0]) {
        setError(retainedMessages[0]);
      } else if (statusMessages[0]) {
        setError(statusMessages[0]);
      } else {
        setError(null);
      }
      return retained.length > 0 ? "blocked" : "clear";
    } catch {
      if (!isCurrent()) return "stale";
      setError(
        "Previous duo launches could not be discovered or reconciled yet. Refresh before launching another pair.",
      );
      return "blocked";
    }
  }, [queryPendingLaunches, reconcilePendingLaunch, setRecoveryStatus]);

  const openDialog = useCallback(() => {
    if (
      !snapshot?.activeProjectId
      || submittingRef.current
      || cancellingRef.current
    ) return;
    const generation = operationGenerationRef.current + 1;
    operationGenerationRef.current = generation;
    setError(null);
    setRecoveryGuidance([]);
    setRecoveryStatus(null);
    setRecheckingRecovery(false);
    setOpen(true);
    void reconcileProjectLaunches([snapshot.activeProjectId], generation);
  }, [reconcileProjectLaunches, setRecoveryStatus, snapshot?.activeProjectId]);

  const cancelActiveLaunch = useCallback(async (): Promise<void> => {
    if (cancellingRef.current) return;
    const generation = operationGenerationRef.current + 1;
    operationGenerationRef.current = generation;
    cancelRequestedRef.current = true;
    const launchId = activeLaunchIdRef.current;
    if (!launchId) {
      if (submittingRef.current) {
        submittingRef.current = false;
        setSubmitting(false);
        setError(null);
        setRecoveryGuidance([]);
        setRecoveryStatus(null);
        setOpen(false);
        focusWorkspace();
      }
      return;
    }
    cancellingRef.current = true;
    submittingRef.current = false;
    setSubmitting(false);
    setCancelling(true);
    setError(null);
    try {
      const event = resultEvent(await run("multi-spawn:cancel", {
        type: "duo.cancel",
        payload: { launchId },
      }));
      if (operationGenerationRef.current !== generation) return;
      if (event.result.kind !== "duo.status") {
        throw new Error("The local service returned an unexpected cancellation response.");
      }
        setRecoveryGuidance(identifiedRecoveryGuidance(event.result));
      setRecoveryStatus(event.result);
      if (!launchRetainsRecoveryIdentity(event.result)) {
        clearPendingMultiSpawnLaunchId(window.localStorage);
      }
      setOpen(false);
      setActionError(launchStatusMessage(event.result));
      focusWorkspace();
    } catch (caught) {
      if (operationGenerationRef.current !== generation) return;
      const message = runtimeCommandDelivery(caught) === "ambiguous"
        ? reconciliationMessage("Cancellation delivery was not confirmed.")
        : errorMessage(caught);
      setOpen(false);
      setActionError(message);
      focusWorkspace();
    } finally {
      cancellingRef.current = false;
      if (operationGenerationRef.current === generation) {
        setCancelling(false);
      }
    }
  }, [focusWorkspace, run, setActionError, setRecoveryStatus]);

  const closeDialog = useCallback(() => {
    if (cancellingRef.current) return;
    if (submittingRef.current) {
      void cancelActiveLaunch();
      return;
    }
    operationGenerationRef.current += 1;
    setError(null);
    setRecoveryGuidance([]);
    setRecoveryStatus(null);
    setRecheckingRecovery(false);
    setAcknowledgingRecovery(false);
    setOpen(false);
  }, [cancelActiveLaunch, setRecoveryStatus]);

  const submit = useCallback(async (draft: MultiSpawnDraft): Promise<void> => {
    if (submittingRef.current || cancellingRef.current || !snapshot) return;
    const validationError = validateMultiSpawnDraft(draft);
    if (validationError) {
      setError(validationError);
      return;
    }
    submittingRef.current = true;
    const generation = operationGenerationRef.current + 1;
    operationGenerationRef.current = generation;
    const isCurrent = () => operationGenerationRef.current === generation;
    cancelRequestedRef.current = false;
    setSubmitting(true);
    setError("Checking these projects for previous duo launches.");
    const reconciliation = await reconcileProjectLaunches(
      [
        ...draft.sides.map(({ projectId }) => projectId),
        ...(draft.comparison.enabled
          ? [draft.comparison.side.projectId]
          : []),
      ],
      generation,
    );
    if (!isCurrent() || reconciliation === "stale") return;
    if (reconciliation === "blocked") {
      submittingRef.current = false;
      setSubmitting(false);
      return;
    }
    const launchId = crypto.randomUUID();
    activeLaunchIdRef.current = launchId;
    setError(null);
    setActionError(null);
    writePendingMultiSpawnLaunchId(window.localStorage, launchId);

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
          ...(draft.comparison.enabled
            ? {
                comparison: {
                  ...multiSpawnComparisonPayload(
                    draft.comparison.side,
                    settings,
                  ),
                  activate: false as const,
                },
              }
            : {}),
        },
      }));
      if (!isCurrent()) return;
      if (prepareEvent.result.kind !== "duo.prepared") {
        throw new Error("The local service returned an unexpected duo response.");
      }
      prepared = true;
      const sides = orderedPreparedSides(prepareEvent.result);
      if (cancelRequestedRef.current) return;

      // The prepare receipt proves both conversation shells and queued turns
      // are durable. Only now may local navigation discard an unrelated draft.
      discardDraftConversation();
      const activated = await activatePreparedConversations(
        sides[0].conversationId,
        sides[1].conversationId,
        isCurrent,
      );
      if (!activated || !isCurrent()) return;
      watchedComparisonRef.current = draft.comparison.enabled
        ? {
            launchId,
            primaryConversationId: sides[0].conversationId,
            secondaryConversationId: sides[1].conversationId,
            seenPair: false,
            navigationGeneration:
              conversationSelectionGenerationRef?.current ?? 0,
          }
        : null;
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
      if (!isCurrent()) return;
      if (dispatchEvent.result.kind !== "duo.status") {
        throw new Error("The local service returned an unexpected dispatch response.");
      }
      const launchMessage = launchStatusMessage(dispatchEvent.result);
      setRecoveryGuidance(identifiedRecoveryGuidance(dispatchEvent.result));
      setRecoveryStatus(dispatchEvent.result);
      if (!launchRetainsRecoveryIdentity(dispatchEvent.result)) {
        clearPendingMultiSpawnLaunchId(window.localStorage);
      }
      if (launchMessage) {
        setError(launchMessage);
        setOpen(true);
      }
    } catch (caught) {
      if (!isCurrent()) return;
      const delivery = runtimeCommandDelivery(caught);
      if (!prepared && (delivery === "ambiguous" || delivery === null)) {
        setOpen(false);
        setActionError(reconciliationMessage(errorMessage(caught)));
        focusWorkspace();
        return;
      }
      if (!prepared) {
        let durableStatusReceived = false;
        try {
          let status = await queryLaunchStatus(launchId);
          if (!isCurrent()) return;
          durableStatusReceived = true;
          if (status.state === "recovery-required") {
            const recovery = resultEvent(await run("multi-spawn:cancel", {
              type: "duo.cancel",
              payload: { launchId },
            }));
            if (!isCurrent()) return;
            if (recovery.result.kind !== "duo.status") {
              throw new Error(
                "The local service returned an unexpected Duo recovery response.",
              );
            }
            status = recovery.result;
          }
          const message = launchStatusMessage(status);
          setRecoveryGuidance(identifiedRecoveryGuidance(status));
          setRecoveryStatus(status);
          if (!launchRetainsRecoveryIdentity(status)) {
            clearPendingMultiSpawnLaunchId(window.localStorage);
          }
          setError(message ?? errorMessage(caught));
        } catch (statusError) {
          if (!isCurrent()) return;
          if (
            !durableStatusReceived
            && runtimeCommandDelivery(statusError) === "rejected"
          ) {
            clearPendingMultiSpawnLaunchId(window.localStorage);
            setError(errorMessage(caught));
          } else {
            setOpen(false);
            setActionError(reconciliationMessage(errorMessage(caught)));
            focusWorkspace();
          }
        }
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
      if (isCurrent()) {
        submittingRef.current = false;
        setSubmitting(false);
      }
    }
  }, [
    activatePreparedConversations,
    conversationSelectionGenerationRef,
    discardDraftConversation,
    focusWorkspace,
    run,
    reconcileProjectLaunches,
    queryLaunchStatus,
    setActionError,
    setRecoveryStatus,
    settings,
    snapshot,
  ]);

  const recheckRecovery = useCallback(async (): Promise<void> => {
    if (!recoveryStatus || recheckingRecovery || acknowledgingRecovery) return;
    const generation = operationGenerationRef.current;
    const launchId = recoveryStatus.launchId;
    const projectIds = [...recoveryProjectIdsRef.current];
    const isCurrent = () =>
      operationGenerationRef.current === generation
      && recoveryStatusRef.current?.launchId === launchId;
    setRecheckingRecovery(true);
    try {
      if (projectIds.length === 0) {
        throw new Error("The projects for this Duo launch are unavailable.");
      }
      const reconciliation = await reconcileProjectLaunches(
        projectIds,
        generation,
      );
      if (!isCurrent() || reconciliation === "stale") return;
    } catch (caught) {
      if (!isCurrent()) return;
      setError(
        `Recovery status could not be re-checked. ${errorMessage(caught)}`,
      );
    } finally {
      if (operationGenerationRef.current === generation) {
        setRecheckingRecovery(false);
      }
    }
  }, [
    acknowledgingRecovery,
    reconcileProjectLaunches,
    recheckingRecovery,
    recoveryStatus,
  ]);

  const acknowledgeRecovery = useCallback(async (): Promise<void> => {
    if (
      recoveryStatus?.state !== "interrupted"
      || recheckingRecovery
      || acknowledgingRecovery
    ) return;
    const generation = operationGenerationRef.current;
    const launchId = recoveryStatus.launchId;
    const projectIds = [...recoveryProjectIdsRef.current];
    const isCurrent = () =>
      operationGenerationRef.current === generation
      && recoveryStatusRef.current?.launchId === launchId;
    setAcknowledgingRecovery(true);
    setError(null);
    try {
      const event = resultEvent(await run("multi-spawn:acknowledge", {
        type: "duo.acknowledge",
        payload: { launchId },
      }));
      if (!isCurrent()) return;
      if (event.result.kind !== "duo.status" || event.result.state !== "failed") {
        throw new Error(
          "The local service did not confirm the Duo acknowledgement.",
        );
      }
      if (projectIds.length === 0) {
        throw new Error("The projects for this Duo launch are unavailable.");
      }
      await reconcileProjectLaunches(projectIds, generation);
    } catch (caught) {
      if (!isCurrent()) return;
      setError(
        `The uncertain Duo launch could not be acknowledged. ${errorMessage(caught)}`,
      );
    } finally {
      if (operationGenerationRef.current === generation) {
        setAcknowledgingRecovery(false);
      }
    }
  }, [
    acknowledgingRecovery,
    reconcileProjectLaunches,
    recheckingRecovery,
    recoveryStatus,
    run,
  ]);

  const retryComparison = useCallback(async (): Promise<void> => {
    if (
      !recoveryStatus?.comparison
      || (
        recoveryStatus.comparison.state !== "failed"
        && recoveryStatus.comparison.state !== "interrupted"
      )
      || retryingComparison
      || cancellingComparison
    ) return;
    const generation = operationGenerationRef.current;
    const launchId = recoveryStatus.launchId;
    setRetryingComparison(true);
    setError(null);
    try {
      const event = resultEvent(await run("multi-spawn:comparison:retry", {
        type: "duo.comparison.retry",
        payload: { launchId },
      }));
      if (operationGenerationRef.current !== generation) return;
      if (event.result.kind !== "duo.status") {
        throw new Error(
          "The local service returned an unexpected judge retry response.",
        );
      }
      setRecoveryStatus(event.result);
      setError(launchStatusMessage(event.result));
    } catch (caught) {
      if (operationGenerationRef.current !== generation) return;
      setError(`The third-model judge could not be retried. ${errorMessage(caught)}`);
    } finally {
      if (operationGenerationRef.current === generation) {
        setRetryingComparison(false);
      }
    }
  }, [
    cancellingComparison,
    recoveryStatus,
    retryingComparison,
    run,
    setRecoveryStatus,
  ]);

  const cancelComparison = useCallback(async (): Promise<void> => {
    if (
      !recoveryStatus?.comparison
      || recoveryStatus.comparison.state === "completed"
      || recoveryStatus.comparison.state === "cancelled"
      || retryingComparison
      || cancellingComparison
    ) return;
    const generation = operationGenerationRef.current;
    const launchId = recoveryStatus.launchId;
    setCancellingComparison(true);
    setError(null);
    try {
      const event = resultEvent(await run("multi-spawn:comparison:cancel", {
        type: "duo.comparison.cancel",
        payload: { launchId },
      }));
      if (operationGenerationRef.current !== generation) return;
      if (event.result.kind !== "duo.status") {
        throw new Error(
          "The local service returned an unexpected judge cancellation response.",
        );
      }
      setRecoveryStatus(event.result);
      setError(launchStatusMessage(event.result));
    } catch (caught) {
      if (operationGenerationRef.current !== generation) return;
      setError(`The third-model comparison could not be cancelled. ${errorMessage(caught)}`);
    } finally {
      if (operationGenerationRef.current === generation) {
        setCancellingComparison(false);
      }
    }
  }, [
    cancellingComparison,
    recoveryStatus,
    retryingComparison,
    run,
    setRecoveryStatus,
  ]);

  return {
    open,
    submitting,
    cancelling,
    error,
    recoveryGuidance,
    recoveryStatus,
    recheckingRecovery,
    acknowledgingRecovery,
    retryingComparison,
    cancellingComparison,
    openDialog,
    closeDialog,
    submit,
    recheckRecovery,
    acknowledgeRecovery,
    retryComparison,
    cancelComparison,
  };
}
