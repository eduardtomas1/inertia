import { createContext, useContext, useEffect, useState } from "react";

import type { AgentActivity, ServerEvent } from "@shared/contracts";
import type { CommandWithoutId } from "../../lib/runtimeCommands";

export type ActivityDetailReader = (conversationId: string, activityId: string) => Promise<string | null>;

export const ActivityDetailReaderContext = createContext<ActivityDetailReader | null>(null);

export const ACTIVITY_DETAIL_READ_FAILED = "The full output could not be loaded. Try again.";
const MAX_LOADED_DETAILS = 16;
const loadedDetails = new Map<string, string | null>();

function rememberLoadedDetail(key: string, detail: string | null): void {
  loadedDetails.delete(key);
  loadedDetails.set(key, detail);
  while (loadedDetails.size > MAX_LOADED_DETAILS) {
    const oldest = loadedDetails.keys().next().value;
    if (oldest === undefined) break;
    loadedDetails.delete(oldest);
  }
}

export function createActivityDetailReader(
  request: (command: CommandWithoutId) => Promise<ServerEvent>,
): ActivityDetailReader {
  return async (conversationId, activityId) => {
    const event = await request({ type: "activity.detail.read", payload: { conversationId, activityId } });
    if (
      event.type !== "request.result"
      || event.result.kind !== "activity.detail"
      || event.result.conversationId !== conversationId
      || event.result.activityId !== activityId
    ) {
      throw new Error(ACTIVITY_DETAIL_READ_FAILED);
    }
    return event.result.detail;
  };
}

export interface FullActivityDetail {
  detail: string | null;
  loading: boolean;
  error: string | null;
  retry: () => void;
}

export function useFullActivityDetail(
  activity: Pick<AgentActivity, "id" | "conversationId" | "detail" | "detailTruncated" | "detailBytes">,
  wanted: boolean,
): FullActivityDetail {
  const reader = useContext(ActivityDetailReaderContext);
  const truncated = activity.detailTruncated === true;
  const key = `${activity.conversationId}:${activity.id}:${activity.detailBytes ?? ""}`;
  const [loaded, setLoaded] = useState<{ key: string; detail: string | null } | null>(
    () => loadedDetails.has(key) ? { key, detail: loadedDetails.get(key) ?? null } : null,
  );
  const [failed, setFailed] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const needed = truncated && wanted && loaded?.key !== key && reader !== null;
  useEffect(() => {
    if (!needed || !reader) return;
    let current = true;
    setFailed(null);
    reader(activity.conversationId, activity.id).then((detail) => {
      rememberLoadedDetail(key, detail);
      if (current) setLoaded({ key, detail });
    }).catch(() => {
      if (current) setFailed(key);
    });
    return () => { current = false; };
  }, [activity.conversationId, activity.id, attempt, key, needed, reader]);
  if (!truncated) return { detail: activity.detail, loading: false, error: null, retry: () => undefined };
  if (loaded?.key === key) return { detail: loaded.detail, loading: false, error: null, retry: () => undefined };
  return {
    detail: activity.detail,
    loading: wanted && failed !== key && reader !== null,
    error: failed === key || (wanted && reader === null) ? ACTIVITY_DETAIL_READ_FAILED : null,
    retry: () => {
      setFailed(null);
      setAttempt((value) => value + 1);
    },
  };
}
