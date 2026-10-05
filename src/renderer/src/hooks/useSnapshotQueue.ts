import { useEffect, useRef } from "react";
import { activateSnapshotComposer } from "../components/composer/useComposerSnapshots";

export function useSnapshotQueue(onNotice: (message: string) => void, showChat: () => void): void {
  const current = useRef({ onNotice, showChat });
  current.current = { onNotice, showChat };
  useEffect(() => window.inertia?.onSnapshot?.((event) => {
    if (event.notice) current.current.onNotice(event.notice);
    else if (event.pending && !activateSnapshotComposer()) current.current.showChat();
  }), []);
}
