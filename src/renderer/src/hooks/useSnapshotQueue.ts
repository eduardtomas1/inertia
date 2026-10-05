import { useEffect, useRef } from "react";
import { activateSnapshotComposer } from "../components/composer/useComposerSnapshots";

export function useSnapshotQueue(
  onNotice: (message: string) => void,
  chat: { hasChat: boolean; show(): void; start(): void },
): void {
  const current = useRef({ onNotice, chat });
  current.current = { onNotice, chat };
  useEffect(() => window.inertia?.onSnapshot?.((event) => {
    if (event.notice) current.current.onNotice(event.notice);
    else if (event.pending && !activateSnapshotComposer()) {
      if (current.current.chat.hasChat) current.current.chat.show();
      else current.current.chat.start();
    }
  }), []);
}
