import { Gauge, X } from "lucide-react";

import type { QuotaNotification } from "../utils/quotaNotifications";
import { INTERFACE_LOCALE } from "../lib/locale";
import { IconButton } from "./ui";

function resetLabel(resetsAt: string | null): string | null {
  if (!resetsAt) return null;
  const date = new Date(resetsAt);
  if (Number.isNaN(date.valueOf())) return null;
  return `Resets ${new Intl.DateTimeFormat(INTERFACE_LOCALE, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(date)}`;
}

export function ProviderQuotaNotices({
  notices,
  bottomOffset = 20,
  onDismiss,
}: {
  notices: readonly QuotaNotification[];
  bottomOffset?: number;
  onDismiss: (noticeId: string) => void;
}): React.JSX.Element | null {
  if (notices.length === 0) return null;
  return (
    <section
      className="provider-quota-notices"
      style={{ bottom: bottomOffset }}
      aria-label="Provider quota notifications"
      aria-live="polite"
      aria-relevant="additions"
    >
      {notices.map((notice) => {
        const reset = resetLabel(notice.resetsAt);
        return (
          <aside
            className={`provider-quota-notice is-${notice.threshold}`}
            key={notice.id}
            data-provider-id={notice.providerId}
            data-quota-window={notice.windowLabel}
          >
            <Gauge size={15} aria-hidden="true" />
            <span>
              <strong>
                {notice.providerLabel} {notice.windowLabel} limit
              </strong>
              <small>
                {notice.remainingPercent}% remaining
                {reset ? ` · ${reset}` : ""}
              </small>
            </span>
            <IconButton
              label={`Dismiss ${notice.providerLabel} ${notice.windowLabel} quota notice`}
              onClick={() => onDismiss(notice.id)}
            >
              <X size={14} />
            </IconButton>
          </aside>
        );
      })}
    </section>
  );
}
