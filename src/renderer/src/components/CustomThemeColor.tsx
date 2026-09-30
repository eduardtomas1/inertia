import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";
import clsx from "clsx";
import { buildCustomPaletteTokens } from "@shared/theme/color-theme-spec";
import { normalizeProjectHexColor } from "@shared/project-colors";

export function CustomThemeColor({ mode, value, disabled, onChange }: {
  mode: "light" | "dark";
  value?: string | null;
  disabled: boolean;
  onChange: (color: string | null) => void;
}): React.JSX.Element {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const color = value ?? (mode === "light" ? "#4e30c5" : "#a3a3fa");
  const label = mode === "light" ? "Light" : "Dark";
  const colorInput = useRef<HTMLInputElement>(null);
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  useEffect(() => { if (colorInput.current) colorInput.current.value = color; }, [color]);
  useEffect(() => {
    const input = colorInput.current;
    if (!input) return;
    // Like the project color picker, save the native dialog's committed change,
    // not each intermediate input event while the user moves through colors.
    const commitColor = (): void => {
      if (input.disabled) return;
      setDraft(null);
      onChangeRef.current(input.value);
    };
    input.addEventListener("change", commitColor);
    return () => input.removeEventListener("change", commitColor);
  }, []);
  const validDraft = draft === null ? color : normalizeProjectHexColor(draft);
  const invalid = draft !== null && !validDraft;
  const swatchStyle = useMemo(() => {
    const tokens = Object.fromEntries(buildCustomPaletteTokens(color, mode));
    return {
      "--theme-preview-canvas": tokens["app-bg"],
      "--theme-preview-sidebar": tokens["sidebar-bg"],
      "--theme-preview-surface": tokens["surface-strong"],
      "--theme-preview-accent": tokens.accent,
      "--theme-preview-accent-soft": tokens["accent-soft"],
      "--theme-preview-message-action": tokens["message-action"],
    } as CSSProperties;
  }, [color, mode]);
  const commit = (): void => {
    if (draft === null || !validDraft || disabled) return;
    onChange(validDraft);
    setDraft(null);
  };

  return (
    <div className={clsx("custom-theme-color", value && "is-active")}>
      <button type="button" className="custom-theme-preview" disabled={disabled}
        aria-label={`Use custom color for ${mode}`} aria-pressed={Boolean(value)}
        onClick={() => onChange(color)}>
        <span className={`color-theme-swatch is-${mode}`} style={swatchStyle} aria-hidden="true" />
      </button>
      <div className="custom-theme-controls">
        <div className="custom-theme-label">
          <label htmlFor={`${id}-hex`}><span className={`appearance-mode-icon is-${mode}`} aria-hidden="true" />{label} color</label>
          {value && <span className="custom-theme-status">Selected</span>}
        </div>
        <div className="custom-theme-inputs">
          <input ref={colorInput} type="color" aria-label={`${label} color picker`} defaultValue={color} disabled={disabled} />
          <input id={`${id}-hex`} type="text" aria-label={`${label} hex color`} value={draft ?? color}
            maxLength={7} spellCheck={false} autoComplete="off" disabled={disabled}
            aria-invalid={invalid} aria-describedby={invalid ? `${id}-error` : undefined}
            onChange={(event) => setDraft(event.target.value)} onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); commit(); }
              if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setDraft(null); }
            }} />
          <button type="button" className="custom-theme-reset" disabled={disabled || !value}
            aria-label={`Reset ${mode} custom color`} onClick={() => { setDraft(null); onChange(null); }}>Reset</button>
        </div>
        {invalid && <p id={`${id}-error`} role="alert">Enter a hex color, like #3a86ff.</p>}
      </div>
    </div>
  );
}
