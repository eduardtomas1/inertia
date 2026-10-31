import { useCallback, useEffect, useRef } from "react";

const TOUCH_SCROLL_QUIET_MS = 150;

export function useReaderScrollIntent(noteReaderIntent: () => void): {
  noteWheelIntent: () => void;
  noteTouchIntent: () => void;
  continueTouchIntent: () => void;
} {
  const touchTimerRef = useRef<number | null>(null);
  const noteTouchIntent = useCallback((): void => {
    noteReaderIntent();
    if (touchTimerRef.current !== null) window.clearTimeout(touchTimerRef.current);
    touchTimerRef.current = window.setTimeout(() => {
      touchTimerRef.current = null;
    }, TOUCH_SCROLL_QUIET_MS);
  }, [noteReaderIntent]);
  const continueTouchIntent = useCallback((): void => {
    if (touchTimerRef.current !== null) noteTouchIntent();
  }, [noteTouchIntent]);
  useEffect(() => () => {
    if (touchTimerRef.current !== null) window.clearTimeout(touchTimerRef.current);
  }, []);
  return { noteWheelIntent: noteReaderIntent, noteTouchIntent, continueTouchIntent };
}
