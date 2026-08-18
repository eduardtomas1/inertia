import type { CSSProperties } from "react";
import { Check, Laptop, Moon, Sun } from "lucide-react";
import clsx from "clsx";
import "./ThemeLibrary.css";

import type {
  AppSettings,
  ColorThemeId,
  ThemePreference,
} from "@shared/contracts";
import {
  COLOR_THEME_OPTIONS,
  type ColorThemePreview,
} from "../utils/colorThemes";

const APPEARANCE_OPTIONS: ReadonlyArray<{
  value: ThemePreference;
  label: string;
  icon: typeof Sun;
}> = [
  { value: "system", label: "System", icon: Laptop },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
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
      <span className="appearance-wireframe-sidebar" />
      <span className="appearance-wireframe-canvas">
        <span className="appearance-wireframe-heading" />
        <span className="appearance-wireframe-line is-long" />
        <span className="appearance-wireframe-line" />
        <span className="appearance-wireframe-composer" />
      </span>
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

type PreviewStyle = CSSProperties & {
  "--theme-preview-canvas": string;
  "--theme-preview-sidebar": string;
  "--theme-preview-surface": string;
  "--theme-preview-accent": string;
  "--theme-preview-accent-soft": string;
  "--theme-preview-message-action": string;
};

function previewStyle(preview: ColorThemePreview): PreviewStyle {
  return {
    "--theme-preview-canvas": preview.canvas,
    "--theme-preview-sidebar": preview.sidebar,
    "--theme-preview-surface": preview.surface,
    "--theme-preview-accent": preview.accent,
    "--theme-preview-accent-soft": preview.accentSoft,
    "--theme-preview-message-action": preview.messageAction,
  };
}

function ColorThemeSwatch({
  mode,
  preview,
}: {
  mode: "light" | "dark";
  preview: ColorThemePreview;
}): React.JSX.Element {
  return (
    <span
      className={clsx("color-theme-swatch", `is-${mode}`)}
      style={previewStyle(preview)}
      aria-hidden="true"
    >
      <span className="color-theme-swatch-sidebar" />
      <span className="color-theme-swatch-card" />
      <span className="color-theme-swatch-accent" />
    </span>
  );
}

export function ThemeLibrary({
  settings,
  disabled,
  onUpdate,
}: {
  settings: Pick<AppSettings, "theme" | "colorTheme">;
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
          const OptionIcon = option.icon;
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
              <span><OptionIcon size={14} />{option.label}</span>
            </button>
          );
        })}
      </div>

      <div className="theme-library-heading">
        <h4>Theme library</h4>
        <p>Every family includes a tuned light and dark palette.</p>
      </div>
      <div
        className="color-theme-options"
        role="radiogroup"
        aria-label="Color theme"
      >
        {COLOR_THEME_OPTIONS.map((option) => {
          const active = settings.colorTheme === option.id;
          return (
            <button
              type="button"
              role="radio"
              aria-label={`${option.label} theme`}
              aria-checked={active}
              className={clsx("color-theme-option", active && "is-active")}
              disabled={disabled}
              key={option.id}
              onClick={() => selectColorTheme(option.id)}
            >
              <span className="color-theme-preview-pair">
                <ColorThemeSwatch mode="light" preview={option.light} />
                <ColorThemeSwatch mode="dark" preview={option.dark} />
              </span>
              <span className="color-theme-option-copy">
                <strong>{option.label}</strong>
                <small>{option.description}</small>
              </span>
              {active && (
                <span className="color-theme-selected" aria-hidden="true">
                  <Check size={12} />
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
