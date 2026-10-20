import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { Check, Pipette } from "lucide-react";
import {
  normalizeProjectHexColor,
  PROJECT_COLOR_EMPHASES,
  PROJECT_COLOR_EMPHASIS_LABELS,
  PROJECT_COLOR_NAMES,
  PROJECT_COLOR_PALETTE,
  type ProjectColor,
  type ProjectColorEmphasis,
  type ProjectColorName,
} from "@shared/project-colors";
import { defaultProjectPreferences, PROJECT_ICON_NAMES, type ProjectPreferences } from "@shared/project-preferences";
import { ProjectIcon, projectTintStyle } from "./ProjectIcon";
import { Tooltip, useTooltip } from "./Tooltip";
import { useProjectColorRevision } from "../lib/projectColorTints";
import "./ProjectAppearanceControls.css";

interface RadioOption<T extends string> { id: T; label: string; content: ReactNode; style?: CSSProperties; className?: string }

const NEXT_KEYS = new Set(["ArrowRight", "ArrowDown"]);
const PREVIOUS_KEYS = new Set(["ArrowLeft", "ArrowUp"]);

function RovingRadio<T extends string>({ option, checked, focusable, disabled, inactive, register, onPick }: {
  option: RadioOption<T>;
  checked: boolean;
  focusable: boolean;
  disabled: boolean;
  inactive: boolean;
  register: (id: T, node: HTMLButtonElement | null) => void;
  onPick: () => void;
}): React.JSX.Element {
  const button = useRef<HTMLButtonElement | null>(null);
  const tooltip = useTooltip(button, {});
  const named = typeof option.content !== "string";
  return <>
    <button type="button" role="radio" aria-checked={checked} aria-label={option.label} data-radio-id={option.id}
      disabled={disabled} aria-disabled={inactive || undefined} tabIndex={focusable ? 0 : -1} style={option.style} className={option.className}
      ref={(node) => { button.current = node; register(option.id, node); }}
      {...(named ? tooltip.handlers : {})}
      onClick={onPick}>{option.content}</button>
    {named && tooltip.layer && <Tooltip anchor={button} layer={tooltip.layer} label={option.label} />}
  </>;
}

export function RovingRadioGroup<T extends string>({ label, options, value, disabled = false, inactive = false, className, onChange }: {
  label: string;
  options: readonly RadioOption<T>[];
  value: T;
  disabled?: boolean;
  inactive?: boolean;
  className?: string;
  onChange: (value: T) => void;
}): React.JSX.Element {
  const buttons = useRef(new Map<T, HTMLButtonElement>());
  const focusable = options.some((option) => option.id === value) ? value : options[0]?.id;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const index = options.findIndex((option) => option.id === (event.target as HTMLElement).dataset.radioId);
    if (index < 0 || disabled) return;
    const target = NEXT_KEYS.has(event.key) ? options[(index + 1) % options.length]
      : PREVIOUS_KEYS.has(event.key) ? options[(index - 1 + options.length) % options.length]
        : event.key === "Home" ? options[0] : event.key === "End" ? options.at(-1) : undefined;
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    if (inactive) return;
    buttons.current.get(target.id)?.focus();
    if (target.id !== value) onChange(target.id);
  };
  return <div role="radiogroup" aria-label={label} aria-disabled={disabled || inactive || undefined} className={className} onKeyDown={onKeyDown}>
    {options.map((option) => <RovingRadio key={option.id} option={option} checked={option.id === value} focusable={option.id === focusable}
      disabled={disabled} inactive={inactive}
      register={(id, node) => { if (node) buttons.current.set(id, node); else buttons.current.delete(id); }}
      onPick={() => { if (!inactive && option.id !== value) onChange(option.id); }} />)}
  </div>;
}

type ColorChoice = "default" | "custom" | ProjectColorName;

function useRememberedValue(current: string | null): string | null {
  const [remembered, setRemembered] = useState(current);
  if (current !== null && current !== remembered) setRemembered(current);
  return current ?? remembered;
}

function swatchStyle(color: ProjectColor): CSSProperties | undefined {
  return projectTintStyle({ preferences: { ...defaultProjectPreferences(), color } });
}

export function ProjectColorPicker({ value, disabled = false, inactive = false, onChange }: {
  value: ProjectColor | null;
  disabled?: boolean;
  inactive?: boolean;
  onChange: (color: ProjectColor | null) => void;
}): React.JSX.Element {
  useProjectColorRevision();
  const hexId = useId();
  const colorInput = useRef<HTMLInputElement>(null);
  const well = useRef<HTMLLabelElement>(null);
  const wellTooltip = useTooltip(well, {});
  const customValue = value?.kind === "custom" ? value.value : null;
  const rememberedCustom = useRememberedValue(customValue);
  const [draft, setDraft] = useState(customValue ?? "");
  const [dirty, setDirty] = useState(false);
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    if (!customValue) return;
    setDraft(customValue);
    setDirty(false);
    setInvalid(false);
    if (colorInput.current) colorInput.current.value = customValue;
  }, [customValue]);
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  useEffect(() => {
    const input = colorInput.current;
    if (!input) return;
    const commit = (): void => {
      const next = normalizeProjectHexColor(input.value);
      if (next && input.getAttribute("aria-disabled") !== "true") onChangeRef.current({ kind: "custom", value: next });
    };
    input.addEventListener("change", commit);
    return () => input.removeEventListener("change", commit);
  }, []);
  const options: RadioOption<ColorChoice>[] = [
    { id: "default", label: "Default", content: <span className="project-swatch-fill" aria-hidden="true" />, className: "project-swatch is-default" },
    ...PROJECT_COLOR_NAMES.map((name): RadioOption<ColorChoice> => ({
      id: name, label: PROJECT_COLOR_PALETTE[name].label, style: swatchStyle({ kind: "palette", name }), className: "project-swatch",
      content: <span className="project-swatch-fill" aria-hidden="true"><Check size={14} /></span>,
    })),
    ...(rememberedCustom ? [{ id: "custom" as const, label: `Custom ${rememberedCustom}`, style: swatchStyle({ kind: "custom", value: rememberedCustom }),
      className: "project-swatch is-custom", content: <span className="project-swatch-fill" aria-hidden="true"><Check size={14} /></span> }] : []),
  ];
  const selected: ColorChoice = !value ? "default" : value.kind === "palette" ? value.name : "custom";
  const applyDraft = (): void => {
    if (inactive) return;
    const next = normalizeProjectHexColor(draft);
    setInvalid(!next);
    if (!next) return;
    setDirty(false);
    if (next !== customValue) onChange({ kind: "custom", value: next });
  };
  return <div className="project-color-picker">
    <RovingRadioGroup label="Project colour" options={options} value={selected} disabled={disabled} inactive={inactive} className="project-swatches"
      onChange={(choice) => {
        if (choice === "default") onChange(null);
        else if (choice === "custom") { if (rememberedCustom) onChange({ kind: "custom", value: rememberedCustom }); }
        else onChange({ kind: "palette", name: choice });
      }} />
    <div className="project-color-custom">
      <label ref={well} className="project-color-well" {...wellTooltip.handlers}>
        <Pipette size={14} aria-hidden="true" />
        <input ref={colorInput} type="color" aria-label="Pick a custom colour" disabled={disabled} aria-disabled={inactive || undefined}
          defaultValue={customValue ?? "#6f76d9"} />
      </label>
      {wellTooltip.layer && <Tooltip anchor={well} layer={wellTooltip.layer} label="Pick a custom colour" />}
      <input className="project-color-hex" aria-label="Custom colour hex value" placeholder="#RRGGBB" spellCheck={false}
        autoComplete="off" maxLength={7} disabled={disabled} readOnly={inactive} aria-disabled={inactive || undefined} value={draft} aria-invalid={invalid || undefined}
        aria-describedby={invalid ? hexId : undefined}
        onChange={(event) => { setDraft(event.target.value); setDirty(true); setInvalid(false); }}
        onBlur={() => { if (dirty && draft.trim()) applyDraft(); }}
        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); applyDraft(); } }} />
      {invalid && <span id={hexId} className="project-color-error" role="alert">Use a hex colour such as #3a86ff.</span>}
    </div>
  </div>;
}

/** Palette-only swatches, shared by surfaces whose colour is a palette name. */
export function PaletteColorPicker({ label, value, disabled = false, onChange }: {
  label: string;
  value: ProjectColorName;
  disabled?: boolean;
  onChange: (color: ProjectColorName) => void;
}): React.JSX.Element {
  useProjectColorRevision();
  return <RovingRadioGroup label={label} value={value} disabled={disabled} className="project-swatches" onChange={onChange}
    options={PROJECT_COLOR_NAMES.map((name): RadioOption<ProjectColorName> => ({
      id: name, label: PROJECT_COLOR_PALETTE[name].label, style: swatchStyle({ kind: "palette", name }), className: "project-swatch",
      content: <span className="project-swatch-fill" aria-hidden="true"><Check size={14} /></span>,
    }))} />;
}

export function ProjectEmphasisPicker({ value, disabled = false, inactive = false, onChange }: {
  value: ProjectColorEmphasis;
  disabled?: boolean;
  inactive?: boolean;
  onChange: (value: ProjectColorEmphasis) => void;
}): React.JSX.Element {
  return <RovingRadioGroup label="Colour shows on" value={value} disabled={disabled} inactive={inactive} className="project-emphasis-picker" onChange={onChange}
    options={PROJECT_COLOR_EMPHASES.map((emphasis) => ({ id: emphasis, label: PROJECT_COLOR_EMPHASIS_LABELS[emphasis],
      content: PROJECT_COLOR_EMPHASIS_LABELS[emphasis], className: "project-emphasis-option" }))} />;
}

export function ProjectIconPicker({ preferences, disabled = false, onChange }: {
  preferences: ProjectPreferences;
  disabled?: boolean;
  onChange: (icon: ProjectPreferences["icon"]) => void;
}): React.JSX.Element {
  const image = useRememberedValue(preferences.icon?.kind === "image" ? preferences.icon.data : null);
  const value = preferences.icon?.kind === "image" ? "image" : preferences.icon?.kind === "symbol" ? preferences.icon.name : "folder";
  const preview = (icon: ProjectPreferences["icon"]): React.JSX.Element =>
    <ProjectIcon project={{ preferences: { ...preferences, icon } }} size={16} />;
  return <RovingRadioGroup label="Project icon" value={value} disabled={disabled} className="project-icon-choices"
    onChange={(choice) => onChange(choice === "image" ? image ? { kind: "image", data: image } : null : { kind: "symbol", name: choice as typeof PROJECT_ICON_NAMES[number] })}
    options={[
      ...PROJECT_ICON_NAMES.map((name) => ({ id: name, label: `${name} icon`, content: preview({ kind: "symbol", name }), className: "project-icon-choice" })),
      ...(image ? [{ id: "image", label: "Imported image", content: preview({ kind: "image", data: image }), className: "project-icon-choice" }] : []),
    ]} />;
}
