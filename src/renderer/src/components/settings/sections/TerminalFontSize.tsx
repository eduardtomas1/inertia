import { useEffect, useRef, useState } from "react";

import type { AppSettings } from "@shared/contracts";
import { SettingStatus } from "../SettingsLayout";
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
    <div className="range-setting" data-setting-id="terminal-font-size">
      <span className="setting-title">
        <label htmlFor="terminal-font-size">Terminal font size</label>
        <SettingStatus notice={action.notice} />
      </span>
      <output htmlFor="terminal-font-size">{shown}px</output>
      <input
        ref={input}
        id="terminal-font-size"
        type="range"
        min="11"
        max="22"
        step="1"
        value={shown}
        disabled={disabled}
        onChange={(event) => {
          if (event.nativeEvent.type !== "change") setDraft(Number(event.currentTarget.value));
        }}
      />
      <div className="range-labels"><span>Compact</span><span>Comfortable</span></div>
    </div>
  );
}
