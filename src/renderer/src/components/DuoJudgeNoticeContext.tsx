import { createContext, lazy, Suspense, useContext } from "react";
import type { ThreadStatus } from "@shared/contracts";
import type { DuoJudgeNotices } from "../hooks/useDuoLaunchWatch";

const DuoJudgeNotice = lazy(async () => ({
  default: (await import("./DuoJudgeNotice")).DuoJudgeNotice,
}));

export const DuoJudgeNoticeContext = createContext<DuoJudgeNotices | null>(null);

export function useDuoJudgeNotices(): DuoJudgeNotices | null {
  return useContext(DuoJudgeNoticeContext);
}

export function DuoJudgeNoticeSlot({
  conversationId,
  conversationStatus,
}: {
  conversationId: string;
  conversationStatus: ThreadStatus;
}): React.JSX.Element | null {
  const notices = useDuoJudgeNotices();
  const entry = notices?.comparisonForConversation(conversationId) ?? null;
  if (
    !notices
    || !entry
    || entry.comparison.state === "cancelled"
    || (
      entry.comparison.state === "completed"
      && notices.verdictDismissed(entry.launchId, conversationId)
    )
  ) return null;
  return (
    <Suspense fallback={null}>
      <DuoJudgeNotice
        entry={entry}
        conversationStatus={conversationStatus}
        pendingAction={notices.pendingAction(entry.launchId)}
        onRetry={() => { void notices.retry(entry.launchId); }}
        onCancel={() => { void notices.cancel(entry.launchId); }}
        onOpenJudge={notices.openJudge}
        onDismiss={() => notices.dismissVerdict(entry.launchId, conversationId)}
      />
    </Suspense>
  );
}
