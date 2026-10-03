import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export const SETTING_SAVED_MESSAGE = "Saved";
export const SETTING_SAVE_FAILED_MESSAGE = "Couldn't save. Try again.";
export const SETTING_SAVED_VISIBLE_MS = 2_000;

export type SettingNoticeTone = "saved" | "info" | "error";

export interface SettingNotice {
  tone: SettingNoticeTone;
  text: string;
}

export interface SettingActionOptions<T> {
  key?: string;
  exclusive?: boolean;
  success?: string | null | ((value: T) => string | null);
  failure?: string | ((error: unknown) => string);
}

export interface SettingAction {
  pending: string | null;
  busy: boolean;
  notice: SettingNotice | null;
  run: <T>(
    operation: () => Promise<T> | T,
    options?: SettingActionOptions<T>,
  ) => Promise<boolean>;
  report: (notice: SettingNotice | null) => void;
}

export function useSettingAction(): SettingAction {
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<SettingNotice | null>(null);
  const sequence = useRef(0);
  const inFlight = useRef(0);
  const mounted = useRef(true);
  const timer = useRef<number | null>(null);

  const clearTimer = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimer();
    };
  }, [clearTimer]);

  const report = useCallback((next: SettingNotice | null) => {
    clearTimer();
    setNotice(next);
    if (next?.tone === "saved") {
      timer.current = window.setTimeout(() => {
        timer.current = null;
        if (mounted.current) setNotice(null);
      }, SETTING_SAVED_VISIBLE_MS);
    }
  }, [clearTimer]);

  const run = useCallback(async <T,>(
    operation: () => Promise<T> | T,
    options: SettingActionOptions<T> = {},
  ): Promise<boolean> => {
    if (options.exclusive && inFlight.current > 0) return false;
    const id = ++sequence.current;
    inFlight.current += 1;
    clearTimer();
    setNotice(null);
    setPending(options.key ?? "save");
    try {
      const value = await operation();
      if (mounted.current && id === sequence.current) {
        const success = options.success === undefined
          ? SETTING_SAVED_MESSAGE
          : typeof options.success === "function"
            ? options.success(value)
            : options.success;
        report(success === null
          ? null
          : { tone: options.success === undefined ? "saved" : "info", text: success });
      }
      return true;
    } catch (error) {
      if (mounted.current && id === sequence.current) {
        report({
          tone: "error",
          text: typeof options.failure === "function"
            ? options.failure(error)
            : options.failure ?? SETTING_SAVE_FAILED_MESSAGE,
        });
      }
      return false;
    } finally {
      inFlight.current -= 1;
      if (mounted.current && id === sequence.current) setPending(null);
    }
  }, [clearTimer, report]);

  return useMemo(() => ({
    pending,
    busy: pending !== null,
    notice,
    run,
    report,
  }), [notice, pending, report, run]);
}

export function useOptimisticSetting<T>(
  authoritative: T,
  action: SettingAction,
  persist: (next: T) => Promise<void> | void,
): { value: T; save: (next: T) => void } {
  const [draft, setDraft] = useState<{ value: T } | null>(null);
  const persistRef = useRef(persist);
  useEffect(() => {
    persistRef.current = persist;
  }, [persist]);
  useEffect(() => {
    if (draft && Object.is(draft.value, authoritative)) setDraft(null);
  }, [authoritative, draft]);
  const { run } = action;
  const save = useCallback((next: T) => {
    const attempt = { value: next };
    setDraft(attempt);
    void run(() => persistRef.current(next)).then((saved) => {
      if (!saved) setDraft((current) => (current === attempt ? null : current));
    });
  }, [run]);
  return { value: draft ? draft.value : authoritative, save };
}
