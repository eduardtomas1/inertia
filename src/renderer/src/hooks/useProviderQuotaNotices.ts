import { useCallback, useEffect, useRef, useState } from "react";

import type { ProviderInfo } from "@shared/contracts";
import {
  evaluateQuotaNotifications,
  parseQuotaNotificationState,
  QUOTA_NOTIFICATION_STORAGE_KEY,
  serializeQuotaNotificationState,
  type PersistedQuotaNotificationState,
  type QuotaNotification,
} from "../utils/quotaNotifications";

const NOTICE_LIFETIME_MS = 10_000;
const MAX_VISIBLE_NOTICES = 3;

function readState(): PersistedQuotaNotificationState {
  try {
    return parseQuotaNotificationState(
      window.localStorage.getItem(QUOTA_NOTIFICATION_STORAGE_KEY),
    );
  } catch {
    return parseQuotaNotificationState(null);
  }
}

function writeState(state: PersistedQuotaNotificationState): void {
  try {
    window.localStorage.setItem(
      QUOTA_NOTIFICATION_STORAGE_KEY,
      serializeQuotaNotificationState(state),
    );
  } catch {
    // Quota notices remain best-effort in privacy-restricted environments.
  }
}

export interface ProviderQuotaNoticeController {
  notices: QuotaNotification[];
  dismiss: (noticeId: string) => void;
}

export function useProviderQuotaNotices(
  providers: readonly ProviderInfo[],
): ProviderQuotaNoticeController {
  const stateRef = useRef<PersistedQuotaNotificationState>(readState());
  const [notices, setNotices] = useState<QuotaNotification[]>([]);

  const dismiss = useCallback((noticeId: string): void => {
    setNotices((current) => current.filter(({ id }) => id !== noticeId));
  }, []);

  useEffect(() => {
    const evaluation = evaluateQuotaNotifications(providers, stateRef.current);
    stateRef.current = evaluation.state;
    writeState(evaluation.state);
    if (evaluation.notices.length === 0) return;
    setNotices((current) => {
      const byId = new Map(current.map((notice) => [notice.id, notice]));
      for (const notice of evaluation.notices) byId.set(notice.id, notice);
      return [...byId.values()].slice(-MAX_VISIBLE_NOTICES);
    });
  }, [providers]);

  useEffect(() => {
    if (notices.length === 0) return;
    const oldest = notices[0];
    const timer = window.setTimeout(
      () => dismiss(oldest.id),
      NOTICE_LIFETIME_MS,
    );
    return () => window.clearTimeout(timer);
  }, [dismiss, notices]);

  return { notices, dismiss };
}
