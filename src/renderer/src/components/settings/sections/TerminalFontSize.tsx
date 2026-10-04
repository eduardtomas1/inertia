import { useEffect, useRef, useState } from "react";

import type { AppSettings } from "@shared/contracts";
import { SettingRow } from "../SettingsLayout";
import { useSettingAction } from "../useSettingAction";

export function TerminalFontSize({
  value,
  disabled,
  onUpdate,
}: {
  value: number;
  disabled: boolean;
  onUpdate: (settings: Partial<AppSettings>) => Promise<void>;
}): React.JSX.Element {
  const action = useSettingAction();
  const input = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<number | null>(null);
  const [pending, setPending] = useState<number | null>(null);
  const committed = useRef<(next: number) => void>(() => undefined);
  committed.current = (next) => {
    setDraft(null);
    if (next === (pending ?? value)) return;
    setPending(next);
    void action.run(() => onUpdate({ terminalFontSize: next })).then((saved) => {
      if (!saved) setPending((current) => (current === next ? null : current));
    });
  };
  useEffect(() => {
    if (pending !== null && pending === value) setPending(null);
  }, [pending, value]);
  useEffect(() => {
    const element = input.current;
    if (!element) return;
    const onChange = (): void => committed.current(Number(element.value));
    element.addEventListener("change", onChange);
    return () => element.removeEventListener("change", onChange);
  }, []);
  const shown = draft ?? pending ?? value;
  return (
    <SettingRow id="terminal-font-size" title="Terminal font size" notice={action.notice}>
      <span className="setting-range">
        <input
          ref={input}
          id="terminal-font-size"
          type="range"
          min="11"
          max="22"
          step="1"
          value={shown}
          aria-label="Terminal font size"
          disabled={disabled}
          onChange={(event) => {
            if (event.nativeEvent.type !== "change") setDraft(Number(event.currentTarget.value));
          }}
        />
        <output htmlFor="terminal-font-size">{shown}px</output>
      </span>
    </SettingRow>
  );
}
