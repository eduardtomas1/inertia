import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AppSnapshot,
  DuoComparisonStatus,
  DuoStatusResult,
  ServerEvent,
} from "@shared/contracts";
import { resultEvent, type CommandWithoutId } from "../lib/runtimeCommands";
import { runtimeCommandDelivery } from "../utils/connectionMessages";
import {
  clearPendingMultiSpawnLaunchId,
  readPendingMultiSpawnLaunchId,
} from "../utils/multiSpawn";
import {
  comparisonMutationConfirmed,
  comparisonNeedsAttention,
  comparisonNeedsMonitoring,
  INVALID_DUO_RESPONSE,
  launchRetainsRecoveryIdentity,
  type ComparisonMutationIntent,
  type DuoMutationIntent,
} from "../utils/duoLaunchStatus";

const POLL_DELAY_MS = 750;
const POLL_RETRY_DELAY_MS = 1_250;
const SWEEP_RETRY_MAX_DELAY_MS = 30_000;
const PENDING_PROJECT_BATCH = 3;

export interface DuoConversationComparison {
  launchId: string;
  role: "judge" | "side";
  sideStarted: boolean;
  comparison: DuoComparisonStatus;
}

export interface DuoJudgeAlert {
  launchId: string;
  conversationId: string | null;
  title: string | null;
  state: "failed" | "interrupted";
}

export interface DuoStatusUpdate {
  status: DuoStatusResult;
  previous: DuoStatusResult | null;
  mutation: DuoMutationIntent | null;
  mutationSettled: boolean;
}

export interface DuoJudgeNotices {
  comparisonForConversation: (
    conversationId: string,
  ) => DuoConversationComparison | null;
  pendingAction: (launchId: string) => "retry" | "cancel" | null;
  retry: (launchId: string) => Promise<void>;
  cancel: (launchId: string) => Promise<void>;
  openJudge: (conversationId: string) => void;
  verdictDismissed: (launchId: string, conversationId: string) => boolean;
  dismissVerdict: (launchId: string, conversationId: string) => void;
  alerts: readonly DuoJudgeAlert[];
  dismissAlert: (launchId: string) => void;
}

export interface DuoLaunchWatch {
  statuses: Readonly<Record<string, DuoStatusResult>>;
  track: (status: DuoStatusResult) => void;
  beginMutation: (intent: DuoMutationIntent) => void;
  endMutation: (launchId: string) => void;
  mutationFor: (launchId: string) => DuoMutationIntent | null;
  comparisonForConversation: (
    conversationId: string,
  ) => DuoConversationComparison | null;
  notices: DuoJudgeNotices;
}

function comparisonIsLive(comparison: DuoComparisonStatus): boolean {
  return comparison.state !== "completed" && comparison.state !== "cancelled";
}

function indexConversationComparisons(
  statuses: Readonly<Record<string, DuoStatusResult>>,
): Map<string, DuoConversationComparison> {
  const index = new Map<string, DuoConversationComparison>();
  const place = (conversationId: string | null, entry: DuoConversationComparison) => {
    if (!conversationId) return;
    const existing = index.get(conversationId);
    if (
      !existing
      || comparisonIsLive(entry.comparison)
      || !comparisonIsLive(existing.comparison)
    ) index.set(conversationId, entry);
  };
  for (const status of Object.values(statuses)) {
    const comparison = status.comparison;
    if (!comparison) continue;
    for (const side of status.sides) {
      place(side.conversationId, {
        launchId: status.launchId,
        role: "side",
        sideStarted: side.dispatchState === "started",
        comparison,
      });
    }
    place(comparison.conversationId, {
      launchId: status.launchId,
      role: "judge",
      sideStarted: false,
      comparison,
    });
  }
  return index;
}

function launchConversationIds(status: DuoStatusResult): string[] {
  return [
    ...status.sides.map(({ conversationId }) => conversationId),
    status.comparison?.conversationId ?? null,
  ].filter((conversationId): conversationId is string => Boolean(conversationId));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "The Duo request failed.";
}

export function useDuoLaunchWatch({
  snapshot,
  request,
  startupSweep,
  visibleConversationIds = [],
  onStatusUpdate,
  onError,
  openConversation,
}: {
  snapshot: AppSnapshot | null;
  request: (command: CommandWithoutId) => Promise<ServerEvent>;
  startupSweep: boolean;
  visibleConversationIds?: readonly string[];
  onStatusUpdate: (update: DuoStatusUpdate) => void;
  onError: (message: string) => void;
  openConversation: (conversationId: string) => void;
}): DuoLaunchWatch {
  const [statuses, setStatuses] = useState<
    Readonly<Record<string, DuoStatusResult>>
  >({});
  const [pendingActions, setPendingActions] = useState<
    Readonly<Record<string, "retry" | "cancel">>
  >({});
  const [alertIds, setAlertIds] = useState<readonly string[]>([]);
  const [dismissedVerdicts, setDismissedVerdicts] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const statusesRef = useRef<Readonly<Record<string, DuoStatusResult>>>({});
  const versionsRef = useRef(new Map<string, number>());
  const timersRef = useRef(new Map<string, number>());
  const inFlightRef = useRef(new Set<string>());
  const mutationsRef = useRef(new Map<string, DuoMutationIntent>());
  const pendingActionsRef = useRef(new Set<string>());
  const alertedRef = useRef(new Set<string>());
  const seenConversationIdsRef = useRef(new Set<string>());
  const refreshedMissingRef = useRef(new Set<string>());
  const sweptRef = useRef(false);
  const mountedRef = useRef(true);
  const requestRef = useRef(request);
  const onStatusUpdateRef = useRef(onStatusUpdate);
  const onErrorRef = useRef(onError);
  const openConversationRef = useRef(openConversation);
  requestRef.current = request;
  onStatusUpdateRef.current = onStatusUpdate;
  onErrorRef.current = onError;
  openConversationRef.current = openConversation;

  const engine = useMemo(() => {
    const readStatus = async (launchId: string): Promise<DuoStatusResult> => {
      const event = resultEvent(await requestRef.current({
        type: "duo.status",
        payload: { launchId },
      }));
      if (event.result.kind !== "duo.status") {
        throw new Error(INVALID_DUO_RESPONSE);
      }
      return event.result;
    };
    const needsPolling = (launchId: string): boolean => {
      const status = statusesRef.current[launchId];
      return mutationsRef.current.has(launchId)
        || Boolean(status && comparisonNeedsMonitoring(status));
    };
    const store = (status: DuoStatusResult): void => {
      versionsRef.current.set(
        status.launchId,
        (versionsRef.current.get(status.launchId) ?? 0) + 1,
      );
      statusesRef.current = {
        ...statusesRef.current,
        [status.launchId]: status,
      };
      setStatuses(statusesRef.current);
    };
    const forget = (launchId: string): void => {
      if (!(launchId in statusesRef.current)) return;
      const next = { ...statusesRef.current };
      delete next[launchId];
      versionsRef.current.set(
        launchId,
        (versionsRef.current.get(launchId) ?? 0) + 1,
      );
      statusesRef.current = next;
      setStatuses(next);
    };
    const schedule = (launchId: string, delay: number): void => {
      if (
        !mountedRef.current
        || timersRef.current.has(launchId)
        || inFlightRef.current.has(launchId)
      ) return;
      timersRef.current.set(launchId, window.setTimeout(() => {
        timersRef.current.delete(launchId);
        poll(launchId);
      }, delay));
    };
    const track = (status: DuoStatusResult): void => {
      store(status);
      if (needsPolling(status.launchId)) {
        schedule(status.launchId, POLL_DELAY_MS);
      }
    };
    const poll = (launchId: string): void => {
      const version = versionsRef.current.get(launchId) ?? 0;
      inFlightRef.current.add(launchId);
      void readStatus(launchId).then((status) => {
        inFlightRef.current.delete(launchId);
        if (!mountedRef.current) return;
        if ((versionsRef.current.get(launchId) ?? 0) !== version) {
          if (needsPolling(launchId)) schedule(launchId, POLL_DELAY_MS);
          return;
        }
        const previous = statusesRef.current[launchId] ?? null;
        const mutation = mutationsRef.current.get(launchId) ?? null;
        const mutationSettled = mutation
          ? comparisonMutationConfirmed(mutation, status)
          : false;
        if (mutationSettled) mutationsRef.current.delete(launchId);
        track(status);
        if (
          comparisonNeedsAttention(status)
          && !(previous && comparisonNeedsAttention(previous))
        ) alert(launchId);
        onStatusUpdateRef.current({
          status,
          previous,
          mutation,
          mutationSettled,
        });
      }).catch(() => {
        inFlightRef.current.delete(launchId);
        if (mountedRef.current && needsPolling(launchId)) {
          schedule(launchId, POLL_RETRY_DELAY_MS);
        }
      });
    };
    const refresh = (launchId: string): void => {
      const version = versionsRef.current.get(launchId) ?? 0;
      void readStatus(launchId).then((status) => {
        if (
          mountedRef.current
          && (versionsRef.current.get(launchId) ?? 0) === version
        ) track(status);
      }).catch((error: unknown) => {
        if (
          mountedRef.current
          && runtimeCommandDelivery(error) === "rejected"
          && (versionsRef.current.get(launchId) ?? 0) === version
        ) forget(launchId);
      });
    };
    const alert = (launchId: string): void => {
      setAlertIds((current) => current.includes(launchId)
        ? current
        : [...current, launchId]);
    };
    const discover = async (
      launchId: string,
      storedLaunchId: string | null,
      retryDelay: number,
    ): Promise<boolean> => {
      const version = versionsRef.current.get(launchId) ?? 0;
      try {
        const status = await readStatus(launchId);
        if (!mountedRef.current) return false;
        if (
          launchId === storedLaunchId
          && !launchRetainsRecoveryIdentity(status)
        ) clearPendingMultiSpawnLaunchId(window.localStorage);
        if ((versionsRef.current.get(launchId) ?? 0) !== version) return false;
        track(status);
        if (
          !comparisonNeedsAttention(status)
          || alertedRef.current.has(launchId)
        ) return false;
        alertedRef.current.add(launchId);
        return true;
      } catch (error) {
        if (runtimeCommandDelivery(error) !== "rejected") {
          rediscover(launchId, storedLaunchId, retryDelay);
        } else if (launchId === storedLaunchId) {
          clearPendingMultiSpawnLaunchId(window.localStorage);
        }
        return false;
      }
    };
    const rediscover = (
      launchId: string,
      storedLaunchId: string | null,
      delay: number,
    ): void => {
      if (
        !mountedRef.current
        || launchId in statusesRef.current
        || timersRef.current.has(launchId)
        || inFlightRef.current.has(launchId)
      ) return;
      timersRef.current.set(launchId, window.setTimeout(() => {
        timersRef.current.delete(launchId);
        void discover(
          launchId,
          storedLaunchId,
          Math.min(delay * 2, SWEEP_RETRY_MAX_DELAY_MS),
        ).then((needsAlert) => {
          if (needsAlert && mountedRef.current) alert(launchId);
        });
      }, delay));
    };
    const sweep = async (projectIds: readonly string[]): Promise<void> => {
      const launchIds = new Set<string>();
      for (let index = 0; index < projectIds.length; index += PENDING_PROJECT_BATCH) {
        const event = resultEvent(await requestRef.current({
          type: "duo.pending",
          payload: {
            projectIds: projectIds.slice(index, index + PENDING_PROJECT_BATCH),
          },
        }));
        if (event.result.kind !== "duo.pending") {
          throw new Error(INVALID_DUO_RESPONSE);
        }
        for (const launchId of event.result.launchIds) launchIds.add(launchId);
      }
      const storedLaunchId = readPendingMultiSpawnLaunchId(window.localStorage);
      if (storedLaunchId) launchIds.add(storedLaunchId);
      const alerts: string[] = [];
      for (const launchId of launchIds) {
        if (!mountedRef.current) return;
        if (await discover(launchId, storedLaunchId, POLL_RETRY_DELAY_MS)) {
          alerts.push(launchId);
        }
      }
      if (alerts.length > 0 && mountedRef.current) {
        setAlertIds((current) => [
          ...current,
          ...alerts.filter((launchId) => !current.includes(launchId)),
        ]);
      }
    };
    return { refresh, schedule, sweep, track };
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const timers = timersRef.current;
    return () => {
      mountedRef.current = false;
      for (const timer of timers.values()) window.clearTimeout(timer);
      timers.clear();
    };
  }, []);

  const sweepProjectIds = useMemo(
    () => (snapshot?.projects ?? [])
      .filter(({ workspaceKind }) => workspaceKind !== "scratch")
      .map(({ id }) => id)
      .join("\n"),
    [snapshot?.projects],
  );
  const snapshotReady = Boolean(snapshot);
  useEffect(() => {
    if (!startupSweep || !snapshotReady || sweptRef.current) return;
    sweptRef.current = true;
    void engine.sweep(sweepProjectIds ? sweepProjectIds.split("\n") : [])
      .catch(() => {
        sweptRef.current = false;
      });
  }, [engine, snapshotReady, startupSweep, sweepProjectIds]);

  const conversations = snapshot?.conversations;
  useEffect(() => {
    if (!conversations) return;
    const present = new Set(conversations.map(({ id }) => id));
    for (const conversationId of present) {
      seenConversationIdsRef.current.add(conversationId);
    }
    for (const status of Object.values(statusesRef.current)) {
      if (comparisonNeedsMonitoring(status)) continue;
      const missing = launchConversationIds(status).filter((conversationId) =>
        seenConversationIdsRef.current.has(conversationId)
        && !present.has(conversationId));
      if (missing.length === 0) continue;
      const key = `${status.launchId}:${missing.join(",")}`;
      if (refreshedMissingRef.current.has(key)) continue;
      refreshedMissingRef.current.add(key);
      engine.refresh(status.launchId);
    }
  }, [conversations, engine, statuses]);

  const beginMutation = useCallback((intent: DuoMutationIntent): void => {
    mutationsRef.current.set(intent.launchId, intent);
    engine.schedule(intent.launchId, POLL_DELAY_MS);
  }, [engine]);
  const endMutation = useCallback((launchId: string): void => {
    mutationsRef.current.delete(launchId);
  }, []);
  const mutationFor = useCallback(
    (launchId: string): DuoMutationIntent | null =>
      mutationsRef.current.get(launchId) ?? null,
    [],
  );

  const mutate = useCallback(async (
    launchId: string,
    kind: "retry" | "cancel",
  ): Promise<void> => {
    const previous = statusesRef.current[launchId];
    const comparison = previous?.comparison;
    if (!comparison || pendingActionsRef.current.has(launchId)) return;
    if (
      kind === "retry"
        ? !comparisonNeedsAttention(previous)
        : !comparisonIsLive(comparison)
    ) return;
    const intent: ComparisonMutationIntent = {
      launchId,
      kind,
      baselineAttempt: comparison.attempt,
      baselineState: comparison.state,
    };
    mutationsRef.current.set(launchId, intent);
    pendingActionsRef.current.add(launchId);
    setPendingActions((current) => ({ ...current, [launchId]: kind }));
    try {
      const event = resultEvent(await requestRef.current({
        type: kind === "retry" ? "duo.comparison.retry" : "duo.comparison.cancel",
        payload: { launchId },
      }));
      if (event.result.kind !== "duo.status") {
        throw new Error(INVALID_DUO_RESPONSE);
      }
      mutationsRef.current.delete(launchId);
      if (!mountedRef.current) return;
      engine.track(event.result);
      onStatusUpdateRef.current({
        status: event.result,
        previous,
        mutation: intent,
        mutationSettled: true,
      });
    } catch (caught) {
      if (!mountedRef.current) return;
      if (runtimeCommandDelivery(caught) === "ambiguous") {
        engine.schedule(launchId, POLL_DELAY_MS);
        return;
      }
      mutationsRef.current.delete(launchId);
      onErrorRef.current(kind === "retry"
        ? `The judge could not be retried. ${errorText(caught)}`
        : `The judge could not be cancelled. ${errorText(caught)}`);
    } finally {
      pendingActionsRef.current.delete(launchId);
      if (mountedRef.current) {
        setPendingActions((current) => {
          const next = { ...current };
          delete next[launchId];
          return next;
        });
      }
    }
  }, [engine]);

  const index = useMemo(() => indexConversationComparisons(statuses), [statuses]);
  const comparisonForConversation = useCallback(
    (conversationId: string): DuoConversationComparison | null =>
      index.get(conversationId) ?? null,
    [index],
  );
  const visibleKey = visibleConversationIds.join("\n");
  const visibleLaunchIds = useMemo(() => {
    const visible = new Set(visibleKey ? visibleKey.split("\n") : []);
    return new Set(Object.values(statuses).flatMap((status) =>
      launchConversationIds(status).some((id) => visible.has(id))
        ? [status.launchId]
        : []));
  }, [statuses, visibleKey]);
  useEffect(() => {
    if (!alertIds.some((launchId) => visibleLaunchIds.has(launchId))) return;
    setAlertIds((current) => current.filter((launchId) =>
      !visibleLaunchIds.has(launchId)));
  }, [alertIds, visibleLaunchIds]);
  const alerts = useMemo(() => alertIds.flatMap((launchId): DuoJudgeAlert[] => {
    const status = statuses[launchId];
    const state = status?.comparison?.state;
    if (
      !status
      || (state !== "failed" && state !== "interrupted")
      || visibleLaunchIds.has(launchId)
    ) return [];
    const conversationId = status.comparison?.conversationId ?? null;
    return [{
      launchId,
      conversationId,
      title: conversations?.find(({ id }) => id === conversationId)?.title ?? null,
      state,
    }];
  }), [alertIds, conversations, statuses, visibleLaunchIds]);
  const dismissAlert = useCallback((launchId: string): void => {
    setAlertIds((current) => current.filter((id) => id !== launchId));
  }, []);
  const verdictDismissed = useCallback(
    (launchId: string, conversationId: string): boolean =>
      dismissedVerdicts.has(`${launchId}:${conversationId}`),
    [dismissedVerdicts],
  );
  const dismissVerdict = useCallback((launchId: string, conversationId: string): void => {
    setDismissedVerdicts((current) => new Set(current).add(`${launchId}:${conversationId}`));
  }, []);
  const openJudge = useCallback((conversationId: string): void => {
    openConversationRef.current(conversationId);
  }, []);

  const notices = useMemo<DuoJudgeNotices>(() => ({
    comparisonForConversation,
    pendingAction: (launchId) => pendingActions[launchId] ?? null,
    retry: (launchId) => mutate(launchId, "retry"),
    cancel: (launchId) => mutate(launchId, "cancel"),
    openJudge,
    verdictDismissed,
    dismissVerdict,
    alerts,
    dismissAlert,
  }), [
    alerts,
    comparisonForConversation,
    dismissAlert,
    dismissVerdict,
    mutate,
    openJudge,
    pendingActions,
    verdictDismissed,
  ]);

  return {
    statuses,
    track: engine.track,
    beginMutation,
    endMutation,
    mutationFor,
    comparisonForConversation,
    notices,
  };
}
