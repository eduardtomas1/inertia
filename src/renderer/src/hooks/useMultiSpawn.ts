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
type DuoComparisonState = NonNullable<DuoStatusResult["comparison"]>["state"];
type ComparisonMutationIntent = {
  launchId: string;
  kind: "retry" | "cancel";
  baselineAttempt: number;
  baselineState: DuoComparisonState;
};
type DuoMutationIntent = ComparisonMutationIntent | {
  launchId: string;
  kind: "acknowledge";
};
const INVALID_DUO_RESPONSE = "Invalid Duo response.";
const DUO_PROJECTS_UNAVAILABLE = "Duo projects unavailable.";

export interface MultiSpawnController {
  open: boolean;
  submitting: boolean;
  cancelling: boolean;
  launchBlocked: boolean;
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
  return "Connection changed during Duo setup. It will not be retried "
    + `automatically. Refresh to reconcile both chats. ${detail}`;
}

function launchStatusMessage(status: DuoStatusResult): string | null {
  const comparison = status.comparison;
  if (comparison?.state === "failed") {
    return comparison.error
      ?? "The judge failed. Source chats stay locked; retry or cancel it.";
  }
  if (comparison?.state === "interrupted") {
    return comparison.error
      ?? "The judge was interrupted without retry. Source chats stay locked.";
  }
  if (status.state === "running" && status.cancelRequested) {
    return "Duo cancellation is still waiting for provider cleanup. Both chats remain locked until it finishes.";
  }
  if (status.state === "running") return null;
  const startedRoutes: number[] = [];
  const failedRoutes: number[] = [];
  for (const { dispatchState, ordinal } of status.sides) {
    if (dispatchState === "started") startedRoutes.push(ordinal + 1);
    if (dispatchState === "failed") failedRoutes.push(ordinal + 1);
  }
  if (startedRoutes.length > 0 && failedRoutes.length > 0) {
    return `Partial dispatch: route ${startedRoutes.join(", ")} started; route ${failedRoutes.join(", ")} failed. Provider effects are not atomic. Inspect both chats; no automatic retry.`;
  }
  if (status.error) return status.error;
  if (status.state === "cancelled") {
    return "The duo launch was cancelled before both providers began.";
  }
  if (status.state === "interrupted" || status.state === "recovery-required") {
    return status.state === "interrupted"
      ? "Duo dispatch is uncertain and provider effects are not atomic. Inspect both chats; no automatic retry."
      : "Manual Git recovery is required. Inspect the retained worktree or branch, recover it safely, then re-check.";
  }
  if (status.state === "failed") {
    return "Neither side will retry automatically. Inspect both saved chats.";
  }
  if (status.state === "prepared") {
    return "Both chats are saved and idle; inspect them before starting again.";
  }
  return `Duo is ${status.state}. Refresh before another launch.`;
}

function retainedLaunchBlockingMessage(status: DuoStatusResult): string | null {
  const comparisonState = status.comparison?.state;
  if (
    comparisonState === "waiting"
    || comparisonState === "dispatching"
    || comparisonState === "running"
  ) return `The comparison is still ${comparisonState}. Wait or cancel it to release the chat locks before another Duo.`;
  return launchStatusMessage(status);
}

function comparisonNeedsMonitoring(status: DuoStatusResult): boolean {
  const state = status.comparison?.state;
  return state === "waiting"
    || state === "dispatching"
    || state === "running"
    || (status.state === "running" && status.cancelRequested === true);
}

function comparisonMutationConfirmed(
  intent: DuoMutationIntent,
  status: DuoStatusResult,
): boolean {
  if (intent.kind === "acknowledge") return status.state !== "interrupted";
  const comparison = status.comparison;
  if (!comparison) return false;
  if (intent.kind === "cancel") {
    return comparison.state === "cancelled" || comparison.state === "completed";
  }
  if (
    comparison.attempt === intent.baselineAttempt
    && comparison.state === intent.baselineState
  ) return false;
  return comparison.attempt > intent.baselineAttempt
    || comparison.state === "cancelled"
    || comparison.state === "completed";
}

function launchRetainsRecoveryIdentity(status: DuoStatusResult): boolean {
  const comparisonState = status.comparison?.state;
  return status.state === "preparing"
    || status.state === "prepared"
    || status.state === "dispatching"
    || status.state === "recovery-required"
    || status.state === "interrupted"
    || (status.state === "running" && status.cancelRequested === true)
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
    throw new Error(INVALID_DUO_RESPONSE);
  }
  return ordered as DuoPreparedResult["sides"];
}

export function useMultiSpawn({
  snapshot,
  settings,
  run,
  request,
  selectConversationCommand,
  workspaceVisible = true,
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
  selectConversationCommand?: (
    key: string,
    conversationId: string,
  ) => Promise<ServerEvent>;
  workspaceVisible?: boolean;
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
  const [watchedComparisonStatus, setWatchedComparisonStatus] =
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
  const workspaceVisibleRef = useRef(workspaceVisible);
  const watchedComparisonRef = useRef<{
    launchId: string;
    primaryConversationId: string;
    secondaryConversationId: string;
    seenPair: boolean;
    navigationGeneration: number;
  } | null>(null);
  const comparisonOpenedRef = useRef<string | null>(null);
  const watchedComparisonLaunchIdRef = useRef<string | null>(null);
  const comparisonMutationsRef = useRef<
    Record<string, DuoMutationIntent | undefined>
  >({});
  splitConversationIdRef.current = splitConversationId;
  workspaceVisibleRef.current = workspaceVisible;

  const presentRecoveryStatus = useCallback((
    status: DuoStatusResult | null,
  ): void => {
    recoveryStatusRef.current = status;
    setRecoveryStatusState(status);
  }, []);

  const watchComparisonStatus = useCallback((status: DuoStatusResult): void => {
    watchedComparisonLaunchIdRef.current = status.launchId;
    setWatchedComparisonStatus(status);
  }, []);

  const setRecoveryStatus = useCallback((
    status: DuoStatusResult | null,
  ): void => {
    presentRecoveryStatus(status);
    const watchedLaunchId = watchedComparisonLaunchIdRef.current;
    if (
      status
      && (
        !watchedLaunchId
        || watchedLaunchId === status.launchId
        || comparisonNeedsMonitoring(status)
        || comparisonMutationsRef.current[status.launchId]
      )
    ) watchComparisonStatus(status);
  }, [presentRecoveryStatus, watchComparisonStatus]);

  const selectConversation = useCallback((
    key: string,
    conversationId: string,
  ): Promise<ServerEvent> => selectConversationCommand
    ? selectConversationCommand(key, conversationId)
    : run(key, {
        type: "conversation.select",
        payload: { conversationId },
      }), [run, selectConversationCommand]);

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
      await selectConversation("multi-spawn:select", primaryConversationId);
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
    selectConversation,
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
      throw new Error(INVALID_DUO_RESPONSE);
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
      throw new Error(INVALID_DUO_RESPONSE);
    }
    return event.result;
  }, [request]);

  useEffect(() => {
    const comparisonWatchLaunchId = watchedComparisonStatus?.launchId;
    if (
      !comparisonWatchLaunchId
      || (
        !comparisonNeedsMonitoring(watchedComparisonStatus)
        && !comparisonMutationsRef.current[comparisonWatchLaunchId]
      )
    ) return;
    let cancelled = false;
    let timer: number | null = null;
    const poll = (): void => {
      void queryLaunchStatusInBackground(comparisonWatchLaunchId).then((status) => {
        if (
          cancelled
          || watchedComparisonLaunchIdRef.current !== comparisonWatchLaunchId
        ) return;
        const mutation = comparisonMutationsRef.current[comparisonWatchLaunchId]
          ?? null;
        const mutationSettled = mutation
          ? comparisonMutationConfirmed(mutation, status)
          : false;
        if (mutationSettled) {
          delete comparisonMutationsRef.current[comparisonWatchLaunchId];
        }
        watchComparisonStatus(status);
        const presented = recoveryStatusRef.current;
        const updatesPresentation = presented?.launchId
          === comparisonWatchLaunchId;
        if (updatesPresentation) {
          setRecoveryGuidance(identifiedRecoveryGuidance(status));
          presentRecoveryStatus(status);
          if (mutationSettled || watchedComparisonStatus.cancelRequested) {
            setError(launchStatusMessage(status));
          }
        }
        if (!launchRetainsRecoveryIdentity(status)) {
          clearPendingMultiSpawnLaunchId(window.localStorage);
        }
        if (!mutation || mutationSettled) {
          const message = launchStatusMessage(status);
          if (message) setActionError(message);
        }
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
    presentRecoveryStatus,
    queryLaunchStatusInBackground,
    setActionError,
    watchComparisonStatus,
    watchedComparisonStatus,
  ]);

  useEffect(() => {
    const watched = watchedComparisonRef.current;
    if (!watched || watchedComparisonStatus?.launchId !== watched.launchId) return;
    if (!workspaceVisible) {
      watchedComparisonRef.current = null;
      return;
    }
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
    const comparison = watchedComparisonStatus.comparison;
    if (
      comparison?.state !== "completed"
      || !comparison.conversationId
      || comparisonOpenedRef.current === watched.launchId
    ) return;
    comparisonOpenedRef.current = watched.launchId;
    watchedComparisonRef.current = null;
    splitSelectionTransitionsRef.current += 1;
    void selectConversation(
      "multi-spawn:comparison:select",
      comparison.conversationId,
    ).then(() => {
      if (!workspaceVisibleRef.current) {
        return selectConversation(
          "multi-spawn:comparison:restore",
          watched.primaryConversationId,
        ).then(() => undefined).catch(() => undefined);
      }
      const navigationStillCurrent =
        !conversationSelectionGenerationRef
        || conversationSelectionGenerationRef.current
          === watched.navigationGeneration;
      if (
        splitConversationIdRef.current !== watched.secondaryConversationId
      ) {
        if (!navigationStillCurrent) return;
        return selectConversation(
          "multi-spawn:comparison:restore",
          watched.primaryConversationId,
        ).then(() => undefined).catch(() => undefined);
      }
      if (
        !navigationStillCurrent
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
    selectConversation,
    setActionError,
    showWorkspace,
    snapshot?.activeConversationId,
    splitConversationId,
    splitSelectionTransitionsRef,
    updateSplitConversationId,
    watchedComparisonStatus,
    workspaceVisible,
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
        throw new Error(INVALID_DUO_RESPONSE);
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
      throw new Error(INVALID_DUO_RESPONSE);
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
      const retainedMessages = retained.map(retainedLaunchBlockingMessage).filter(
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
          "More previous duo launches need reconciliation. Reconcile again.",
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
        "A previous duo launch could not be read. Refresh before another.",
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
    setError("Checking previous duo launches.");
    setRecoveryGuidance([]);
    setRecoveryStatus(null);
    setRecheckingRecovery(false);
    setAcknowledgingRecovery(false);
    setRetryingComparison(false);
    setCancellingComparison(false);
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
        throw new Error(INVALID_DUO_RESPONSE);
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
    /*
     * These two are only cleared by a generation-guarded finally, and bumping
     * the generation above invalidates that guard. Leaving them set kept the
     * whole dialog disabled for the rest of the session, which removed the only
     * way to release a locked comparison.
     */
    setRetryingComparison(false);
    setCancellingComparison(false);
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
    setError("Checking previous duo launches.");
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
        throw new Error(INVALID_DUO_RESPONSE);
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
        throw new Error(INVALID_DUO_RESPONSE);
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
              throw new Error(INVALID_DUO_RESPONSE);
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
        throw new Error(DUO_PROJECTS_UNAVAILABLE);
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
    comparisonMutationsRef.current[launchId] = {
      launchId,
      kind: "acknowledge",
    };
    watchComparisonStatus({ ...recoveryStatus });
    setAcknowledgingRecovery(true);
    setError(null);
    try {
      const event = resultEvent(await run("multi-spawn:acknowledge", {
        type: "duo.acknowledge",
        payload: { launchId },
      }));
      if (!isCurrent()) return;
      if (event.result.kind !== "duo.status" || event.result.state !== "failed") {
        throw new Error(INVALID_DUO_RESPONSE);
      }
      delete comparisonMutationsRef.current[launchId];
      if (projectIds.length === 0) {
        throw new Error(DUO_PROJECTS_UNAVAILABLE);
      }
      await reconcileProjectLaunches(projectIds, generation);
    } catch (caught) {
      if (!isCurrent()) return;
      if (runtimeCommandDelivery(caught) === "ambiguous") {
        setError("Duo acknowledgement may still be finishing. Re-check first.");
        return;
      }
      delete comparisonMutationsRef.current[launchId];
      setError(
        `Duo acknowledgement failed. ${errorMessage(caught)}`,
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
    watchComparisonStatus,
  ]);

  const applyComparisonMutationStatus = useCallback((
    status: DuoStatusResult,
  ): void => {
    setRecoveryStatus(status);
    if (!launchRetainsRecoveryIdentity(status)) {
      clearPendingMultiSpawnLaunchId(window.localStorage);
    }
    setError(launchStatusMessage(status));
  }, [setRecoveryStatus]);

  const reconcileAmbiguousComparisonMutation = useCallback(async (
    mutation: ComparisonMutationIntent,
    generation: number,
  ): Promise<void> => {
    if (operationGenerationRef.current !== generation) return;
    try {
      const status = await queryLaunchStatus(mutation.launchId);
      if (operationGenerationRef.current !== generation) return;
      setRecoveryGuidance(identifiedRecoveryGuidance(status));
      if (comparisonMutationConfirmed(mutation, status)) {
        delete comparisonMutationsRef.current[mutation.launchId];
        applyComparisonMutationStatus(status);
        return;
      }
      watchComparisonStatus(status);
      presentRecoveryStatus(status);
      setError(
        "Comparison command still pending; re-check before another recovery action.",
      );
    } catch (statusError) {
      if (operationGenerationRef.current !== generation) return;
      setError(
        "Comparison status is unavailable; outcome is uncertain. "
        + `Re-check. ${errorMessage(statusError)}`,
      );
    }
  }, [
    applyComparisonMutationStatus,
    presentRecoveryStatus,
    queryLaunchStatus,
    watchComparisonStatus,
  ]);

  const mutateComparison = useCallback(async (
    kind: "retry" | "cancel",
  ): Promise<void> => {
    const comparison = recoveryStatus?.comparison;
    if (!comparison || retryingComparison || cancellingComparison) return;
    if (
      kind === "retry"
        ? comparison.state !== "failed" && comparison.state !== "interrupted"
        : comparison.state === "completed" || comparison.state === "cancelled"
    ) return;
    const generation = operationGenerationRef.current;
    const launchId = recoveryStatus.launchId;
    const mutation: ComparisonMutationIntent = {
      launchId,
      kind,
      baselineAttempt: comparison.attempt,
      baselineState: comparison.state,
    };
    comparisonMutationsRef.current[launchId] = mutation;
    // A close invalidates foreground mutation callbacks. Keep an independent
    // watch alive so its eventual authoritative state is still surfaced.
    watchComparisonStatus({ ...recoveryStatus });
    const setBusy = kind === "retry"
      ? setRetryingComparison
      : setCancellingComparison;
    setBusy(true);
    setError(null);
    try {
      const event = resultEvent(await (kind === "retry"
        ? run("multi-spawn:comparison:retry", {
            type: "duo.comparison.retry",
            payload: { launchId },
          })
        : run("multi-spawn:comparison:cancel", {
            type: "duo.comparison.cancel",
            payload: { launchId },
          })));
      if (event.result.kind !== "duo.status") {
        throw new Error(INVALID_DUO_RESPONSE);
      }
      delete comparisonMutationsRef.current[launchId];
      if (operationGenerationRef.current !== generation) return;
      applyComparisonMutationStatus(event.result);
    } catch (caught) {
      if (runtimeCommandDelivery(caught) === "ambiguous") {
        await reconcileAmbiguousComparisonMutation(mutation, generation);
        return;
      }
      delete comparisonMutationsRef.current[launchId];
      if (operationGenerationRef.current !== generation) return;
      setError(kind === "retry"
        ? `The third-model judge could not be retried. ${errorMessage(caught)}`
        : `The third-model comparison could not be cancelled. ${errorMessage(caught)}`);
    } finally {
      if (operationGenerationRef.current === generation) {
        setBusy(false);
      }
    }
  }, [
    applyComparisonMutationStatus,
    cancellingComparison,
    recoveryStatus,
    retryingComparison,
    reconcileAmbiguousComparisonMutation,
    run,
    watchComparisonStatus,
  ]);

  return {
    open,
    submitting,
    cancelling,
    launchBlocked: open && (
      (recoveryStatus !== null && launchRetainsRecoveryIdentity(recoveryStatus))
      || error?.includes("previous duo launch") === true
    ),
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
    retryComparison: () => mutateComparison("retry"),
    cancelComparison: () => mutateComparison("cancel"),
  };
}
