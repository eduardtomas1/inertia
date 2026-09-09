import clsx from "clsx";
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
  settings: Pick<AppSettings, "theme" | "colorTheme" | "lightColorTheme" | "darkColorTheme">;
  disabled: boolean;
  onUpdate: (settings: Partial<AppSettings>) => void;
}): React.JSX.Element {
  const selectColorTheme = (colorTheme: ColorThemeId): void => {
    void onUpdate({ colorTheme });
  };

  return (
    <div className="theme-library">
      <div>
        <h4>Color scheme</h4>
        <p>Follow your system or hold the workbench in one appearance.</p>
      </div>
      <div
        className="appearance-mode-options"
        role="radiogroup"
        aria-label="Appearance"
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

      <div className="theme-library-heading">
        <h4>Theme library</h4>
        <p>Choose a circle for one appearance, or a card to use its theme for both.</p>
      </div>
      <div
        className="color-theme-options"
        role="group"
        aria-label="Color theme"
      >
        {COLOR_THEME_OPTIONS.map((option) => {
          const lightActive = (settings.lightColorTheme ?? settings.colorTheme) === option.id;
          const darkActive = (settings.darkColorTheme ?? settings.colorTheme) === option.id;
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
              <span className="color-theme-option-copy">
                <strong>{option.label}</strong>
                <small>{option.description}</small>
              </span>
              {active && (
                <span className="color-theme-selected" aria-hidden="true" />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
