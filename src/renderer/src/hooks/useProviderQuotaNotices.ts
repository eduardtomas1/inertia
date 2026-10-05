import { useCallback, useEffect, useRef, useState } from "react";

import type { ProviderInfo } from "@shared/contracts";
import type { QuotaWarningSettings } from "@shared/quota-warnings";
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
  warnings: QuotaWarningSettings,
): ProviderQuotaNoticeController {
  const { enabled, firstThreshold } = warnings;
  const stateRef = useRef<PersistedQuotaNotificationState>(readState());
  const serializedStateRef = useRef(serializeQuotaNotificationState(
    stateRef.current,
  ));
  const [notices, setNotices] = useState<QuotaNotification[]>([]);

  const dismiss = useCallback((noticeId: string): void => {
    setNotices((current) => current.filter(({ id }) => id !== noticeId));
  }, []);

  useEffect(() => {
    const evaluation = evaluateQuotaNotifications(
      providers,
      stateRef.current,
      new Date().toISOString(),
      { enabled, firstThreshold },
    );
    stateRef.current = evaluation.state;
    const serialized = serializeQuotaNotificationState(evaluation.state);
    if (serialized !== serializedStateRef.current) {
      serializedStateRef.current = serialized;
      writeState(evaluation.state);
    }
    if (!enabled) {
      setNotices((current) => current.length === 0 ? current : []);
      return;
    }
    if (evaluation.notices.length === 0) return;
    setNotices((current) => {
      const byId = new Map(current.map((notice) => [notice.id, notice]));
      for (const notice of evaluation.notices) byId.set(notice.id, notice);
      return [...byId.values()].slice(-MAX_VISIBLE_NOTICES);
    });
  }, [enabled, firstThreshold, providers]);

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
