import { useEffect, useId, useState, type ReactNode } from "react";
import clsx from "clsx";

import { useRovingRadios } from "../../hooks/useRovingRadios";
import { Switch } from "../ui";
import { SettingCopy, SettingRow } from "./SettingsLayout";
import { useOptimisticSetting, useSettingAction, type SettingActionOptions } from "./useSettingAction";

type Persist<T> = (value: T) => Promise<void> | void;
type Failure = SettingActionOptions<void>["failure"];

export function SettingSwitch({
  id,
  title,
  description,
  checked,
  disabled = false,
  label,
  failure,
  onChange,
}: {
  id: string;
  title: string;
  description?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  label?: string;
  failure?: Failure;
  onChange: Persist<boolean>;
}): React.JSX.Element {
  const action = useSettingAction();
  const { value, save } = useOptimisticSetting(checked, action, onChange, failure);
  return (
    <SettingRow id={id} title={title} description={description} notice={action.notice}>
      <Switch label={label ?? title} checked={value} disabled={disabled} onChange={save} />
    </SettingRow>
  );
}

export interface SettingOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
  group?: string;
}

function groupedOptions<T extends string>(options: readonly SettingOption<T>[]): Array<{ group?: string; options: SettingOption<T>[] }> {
  const groups: Array<{ group?: string; options: SettingOption<T>[] }> = [];
  for (const option of options) {
    const last = groups.at(-1);
    if (last && last.group === option.group) last.options.push(option);
    else groups.push({ group: option.group, options: [option] });
  }
  return groups;
}

export function SettingSelect<T extends string>({
  id,
  title,
  description,
  label,
  value: authoritative,
  options,
  disabled = false,
  unavailable = false,
  prefix,
  className,
  failure,
  onChange,
}: {
  id: string;
  title: string;
  description?: ReactNode;
  label?: string;
  value: T;
  options: readonly SettingOption<T>[];
  disabled?: boolean;
  unavailable?: boolean;
  prefix?: ReactNode;
  className?: string;
  failure?: Failure;
  onChange: Persist<T>;
}): React.JSX.Element {
  const action = useSettingAction();
  const { value, save } = useOptimisticSetting(authoritative, action, onChange, failure);
  const select = (
    <select
      className="setting-select"
      aria-label={label ?? title}
      aria-disabled={unavailable || undefined}
      value={value}
      disabled={disabled}
      onChange={(event) => {
        if (!unavailable) save(event.currentTarget.value as T);
      }}
    >
      {groupedOptions(options).map(({ group, options: entries }, index) => {
        const rendered = entries.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>
        ));
        return group === undefined ? rendered : <optgroup key={`${index}:${group}`} label={group}>{rendered}</optgroup>;
      })}
    </select>
  );
  return (
    <SettingRow id={id} title={title} description={description} notice={action.notice} className={className}>
      {prefix === undefined ? select : <span className="setting-select-group">{prefix}{select}</span>}
    </SettingRow>
  );
}

export function SettingRadioGroup<T extends string>({
  id,
  title,
  description,
  label,
  value: authoritative,
  options,
  disabled = false,
  className,
  onChange,
}: {
  id: string;
  title: string;
  description?: ReactNode;
  label?: string;
  value: T;
  options: readonly SettingOption<T>[];
  disabled?: boolean;
  className?: string;
  onChange: Persist<T>;
}): React.JSX.Element {
  const action = useSettingAction();
  const { value, save } = useOptimisticSetting(authoritative, action, onChange);
  const radios = useRovingRadios(options.map((option) => option.value), value, save);
  return (
    <div className={clsx("response-density-setting", className)} data-setting-id={id}>
      <SettingCopy title={title} description={description} notice={action.notice} />
      <div role="radiogroup" aria-label={label ?? title} {...radios.groupProps}>
        {options.map((option) => (
          <button
            type="button"
            key={option.value}
            {...radios.radioProps(option.value)}
            className={clsx(value === option.value && "is-active")}
            disabled={disabled || option.disabled}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function SettingTextField({
  id,
  title,
  description,
  label,
  value,
  placeholder,
  maxLength,
  type = "text",
  autoComplete,
  disabled = false,
  layout = "row",
  className,
  normalize = (draft) => draft.trim(),
  validate,
  onSave,
}: {
  id: string;
  title: string;
  description?: ReactNode;
  label?: string;
  value: string;
  placeholder?: string;
  maxLength?: number;
  type?: "text" | "url";
  autoComplete?: string;
  disabled?: boolean;
  layout?: "row" | "stacked";
  className?: string;
  normalize?: (draft: string) => string;
  validate?: (value: string) => string | null;
  onSave: Persist<string>;
}): React.JSX.Element {
  const action = useSettingAction();
  const errorId = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (pending !== null && pending === value) setPending(null);
  }, [pending, value]);
  const saved = pending ?? value;
  const shown = draft ?? saved;
  const commit = (): void => {
    if (draft === null) return;
    const next = normalize(draft);
    if (next === saved) {
      setDraft(null);
      setError(null);
      return;
    }
    const invalid = validate?.(next) ?? null;
    if (invalid) {
      setError(invalid);
      return;
    }
    setError(null);
    setDraft(null);
    setPending(next);
    void action.run(() => onSave(next)).then((ok) => {
      if (ok) return;
      setPending((current) => (current === next ? null : current));
      setDraft((current) => current ?? next);
    });
  };
  return (
    <div
      className={clsx(layout === "row" ? "setting-row setting-text-field" : "setting-field", className)}
      data-setting-id={id}
    >
      <SettingCopy title={title} description={description} notice={action.notice} />
      <span className="setting-field-control">
        <input
          className={layout === "row" ? "setting-input" : undefined}
          aria-label={label ?? title}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          autoComplete={autoComplete}
          disabled={disabled}
          maxLength={maxLength}
          placeholder={placeholder}
          type={type}
          value={shown}
          onChange={(event) => {
            setDraft(event.currentTarget.value);
            setError(null);
          }}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            } else if (event.key === "Escape" && draft !== null && normalize(draft) !== saved) {
              event.preventDefault();
              setDraft(null);
              setError(null);
            }
          }}
        />
        {error && <small id={errorId} className="setting-field-error">{error}</small>}
      </span>
    </div>
  );
}
