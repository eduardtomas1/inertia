import { useId } from "react";
import clsx from "clsx";
import { CustomThemeColor } from "./CustomThemeColor";
import "./ThemeLibrary.css";

import type {
  AppSettings,
  ColorThemeId,
  ThemePreference,
} from "@shared/contracts";
import { COLOR_THEME_OPTIONS } from "../utils/colorThemes";

const APPEARANCE_OPTIONS: ReadonlyArray<{
  value: ThemePreference;
  label: string;
}> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

function AppearancePane({
  mode,
  clip,
}: {
  mode: "light" | "dark";
  clip?: "left" | "right";
}): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={clsx(
        "appearance-wireframe-pane",
        `is-${mode}`,
        clip && `is-${clip}`,
      )}
    >
    </span>
  );
}

function AppearancePreview({ mode }: { mode: ThemePreference }): React.JSX.Element {
  return (
    <span className="appearance-wireframe" aria-hidden="true">
      {mode === "system" ? (
        <>
          <AppearancePane mode="light" clip="left" />
          <AppearancePane mode="dark" clip="right" />
        </>
      ) : <AppearancePane mode={mode} />}
    </span>
  );
}

function ColorThemeSwatch({
  mode,
  colorTheme,
}: {
  mode: "light" | "dark";
  colorTheme: ColorThemeId;
}): React.JSX.Element {
  return (
    <span
      className={clsx("color-theme-swatch", `is-${mode}`)}
      data-color-theme={colorTheme}
      aria-hidden="true"
    />
  );
}

export function ThemeLibrary({
  settings,
  disabled,
  onUpdate,
}: {
  settings: Pick<AppSettings, "theme" | "colorTheme" | "lightColorTheme" | "darkColorTheme" | "lightCustomColor" | "darkCustomColor">;
  disabled: boolean;
  onUpdate: (settings: Partial<AppSettings>) => void;
}): React.JSX.Element {
  const titleId = useId();
  const selectColorTheme = (colorTheme: ColorThemeId): void => {
    void onUpdate({ colorTheme });
  };

  return (
    <div className="theme-library" data-setting-id="appearance-mode">
      <span className="setting-copy">
        <strong id={`${titleId}-appearance`}>Appearance</strong>
      </span>
      <div
        className="appearance-mode-options"
        role="radiogroup"
        aria-labelledby={`${titleId}-appearance`}
      >
        {APPEARANCE_OPTIONS.map((option) => {
          const active = settings.theme === option.value;
          return (
            <button
              type="button"
              role="radio"
              aria-label={option.label}
              aria-checked={active}
              className={clsx("appearance-mode-option", active && "is-active")}
              disabled={disabled}
              key={option.value}
              onClick={() => { void onUpdate({ theme: option.value }); }}
            >
              <AppearancePreview mode={option.value} />
              <span>
                <span
                  className={`appearance-mode-icon is-${option.value}`}
                  aria-hidden="true"
                />
                {option.label}
              </span>
            </button>
          );
        })}
      </div>

      <span className="setting-copy">
        <strong id={`${titleId}-colour`}>Colour theme</strong>
        <small id={`${titleId}-colour-hint`}>Pick a circle for one appearance, or the card for both.</small>
      </span>
      <div
        className="color-theme-options"
        role="group"
        aria-labelledby={`${titleId}-colour`}
        aria-describedby={`${titleId}-colour-hint`}
      >
        {COLOR_THEME_OPTIONS.map((option) => {
          const lightActive = !settings.lightCustomColor && (settings.lightColorTheme ?? settings.colorTheme) === option.id;
          const darkActive = !settings.darkCustomColor && (settings.darkColorTheme ?? settings.colorTheme) === option.id;
          const active = lightActive && darkActive;
          return (
            <div
              className={clsx("color-theme-option", active && "is-active")}
              key={option.id}
            >
              <button type="button" className="color-theme-apply-both" disabled={disabled}
                aria-label={`${option.label} theme`} aria-pressed={active}
                title={`Use ${option.label} for both light and dark`}
                onClick={() => selectColorTheme(option.id)} />
              <span className="color-theme-preview-pair">
                {(["light", "dark"] as const).map((mode) => {
                  const selected = mode === "light" ? lightActive : darkActive;
                  return <button type="button" key={mode} disabled={disabled}
                    className={clsx("color-theme-mode-button", selected && "is-selected")}
                    aria-label={`Use ${option.label} for ${mode}`} aria-pressed={selected}
                    title={`Use ${option.label} for ${mode} only`}
                    onClick={() => onUpdate(mode === "light" ? { lightColorTheme: option.id } : { darkColorTheme: option.id })}>
                    <ColorThemeSwatch mode={mode} colorTheme={option.id} />
                    {selected && <span className="color-theme-mode-badge" aria-hidden="true"><span className={`appearance-mode-icon is-${mode}`} /></span>}
                  </button>;
                })}
              </span>
              <span className="color-theme-option-name">{option.label}</span>
            </div>
          );
        })}
      </div>
      <span className="setting-copy">
        <strong id={`${titleId}-custom`}>Custom colours</strong>
      </span>
      <div className="custom-theme-options" role="group" aria-labelledby={`${titleId}-custom`}>
        <CustomThemeColor mode="light" value={settings.lightCustomColor} disabled={disabled}
          onChange={(lightCustomColor) => onUpdate({ lightCustomColor })} />
        <CustomThemeColor mode="dark" value={settings.darkCustomColor} disabled={disabled}
          onChange={(darkCustomColor) => onUpdate({ darkCustomColor })} />
      </div>
    </div>
  );
}
