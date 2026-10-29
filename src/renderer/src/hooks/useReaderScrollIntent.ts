import { useCallback, useEffect, useRef } from "react";

const TOUCH_SCROLL_QUIET_MS = 150;

export function useReaderScrollIntent(noteReaderIntent: () => void): {
  noteWheelIntent: () => void;
  noteTouchIntent: () => void;
  noteKeyIntent: (key: string) => void;
  continueTouchIntent: () => void;
  aimsAtLatest: () => boolean;
} {
  const touchTimerRef = useRef<number | null>(null);
  const aimedAtLatestRef = useRef(false);
  const noteWheelIntent = useCallback((): void => {
    noteReaderIntent();
    aimedAtLatestRef.current = false;
  }, [noteReaderIntent]);
  const noteTouchIntent = useCallback((): void => {
    noteReaderIntent();
    aimedAtLatestRef.current = false;
    if (touchTimerRef.current !== null) window.clearTimeout(touchTimerRef.current);
    touchTimerRef.current = window.setTimeout(() => {
      touchTimerRef.current = null;
    }, TOUCH_SCROLL_QUIET_MS);
  }, [noteReaderIntent]);
  const noteKeyIntent = useCallback((key: string): void => {
    aimedAtLatestRef.current = key === "End";
  }, []);
  const continueTouchIntent = useCallback((): void => {
    if (touchTimerRef.current !== null) noteTouchIntent();
  }, [noteTouchIntent]);
  const aimsAtLatest = useCallback((): boolean => aimedAtLatestRef.current, []);
  useEffect(() => () => {
    if (touchTimerRef.current !== null) window.clearTimeout(touchTimerRef.current);
  }, []);
  return { noteWheelIntent, noteTouchIntent, noteKeyIntent, continueTouchIntent, aimsAtLatest };
}
