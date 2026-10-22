import {
  createContext,
  lazy,
  Suspense,
  useContext,
  useLayoutEffect,
  useRef,
} from "react";
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
  const pendingAction = entry ? notices?.pendingAction(entry.launchId) ?? null : null;
  const focusRegion = useRef<Element | null>(null);
  useLayoutEffect(() => {
    const region = focusRegion.current;
    if (!region || pendingAction) return;
    focusRegion.current = null;
    if (document.activeElement && document.activeElement !== document.body) return;
    (region.querySelector<HTMLElement>(".duo-judge-notice button:not(:disabled)")
      ?? region.querySelector<HTMLElement>("textarea"))?.focus();
  });
  const keepFocus = (): void => {
    focusRegion.current = document.activeElement?.closest(".composer-region") ?? null;
  };
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
        pendingAction={pendingAction}
        onRetry={() => {
          keepFocus();
          void notices.retry(entry.launchId);
        }}
        onCancel={() => {
          keepFocus();
          void notices.cancel(entry.launchId);
        }}
        onOpenJudge={notices.openJudge}
        onReadVerdict={(judgeConversationId) => {
          notices.dismissVerdict(entry.launchId, conversationId);
          notices.openJudge(judgeConversationId);
        }}
        onDismiss={() => {
          keepFocus();
          notices.dismissVerdict(entry.launchId, conversationId);
        }}
      />
    </Suspense>
  );
}
