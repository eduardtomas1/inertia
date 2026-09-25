import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import type { AppSettings } from "@shared/contracts/app";
import {
  normalizeHexColor,
  parseWorkingIndicatorSettings,
  WORKING_INDICATOR_COLORS,
  WORKING_INDICATOR_SPEEDS,
  WORKING_INDICATOR_STYLES,
  type WorkingIndicatorColor,
  type WorkingIndicatorSettings as IndicatorSettings,
  type WorkingIndicatorSpeed,
  type WorkingIndicatorStyle,
} from "@shared/working-indicator";
import { useDocumentVisibility } from "../../hooks/useDocumentPresence";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { AgentPixelGrid } from "../AgentPixelGrid";
import { Switch } from "../ui";
import { orbMotionForPhase } from "./orbMotion";
import { WorkingIndicatorProvider } from "./WorkingIndicatorContext";
import { WorkingOrb } from "./WorkingOrb";
import "./WorkingIndicatorSettings.css";

const STYLE_LABELS: Readonly<Record<WorkingIndicatorStyle, { label: string; detail: string; badge?: string }>> = {
  classic: { label: "Classic", detail: "The 3×3 grid and spinning rings", badge: "Default" },
  automatic: { label: "Automatic", detail: "Picks a design for each kind of work", badge: "By activity" },
  working: { label: "Working", detail: "Particles on tilted orbits" },
  searching: { label: "Searching", detail: "A scan meridian sweeps a dotted globe" },
  solving: { label: "Solving", detail: "Bands scramble, then click back solved" },
  listening: { label: "Listening", detail: "A waveform rolls through the rings" },
  connecting: { label: "Connecting", detail: "A constellation wires itself" },
  weaving: { label: "Weaving", detail: "Three strands plait around the sphere" },
  composing: { label: "Composing", detail: "An undulating multi-band sash" },
  breathing: { label: "Breathing", detail: "A ring slowly morphing" },
  shaping: { label: "Shaping", detail: "Circle, triangle, square" },
};

const COLOR_LABELS: Readonly<Record<WorkingIndicatorColor, string>> = {
  ink: "Theme ink",
  accent: "Accent",
  lilac: "Lilac",
  sky: "Sky",
  mint: "Mint",
  amber: "Amber",
  rose: "Rose",
  custom: "Custom",
};

const SPEED_LABELS: Readonly<Record<WorkingIndicatorSpeed, string>> = {
  calm: "Calm",
  normal: "Normal",
  lively: "Lively",
};

const AUTOMATIC_PREVIEW_PHASES = ["thinking", "searching", "coding", "tool", "command", "delegated", "responding"] as const;
const AUTOMATIC_PREVIEW_INTERVAL_MS = 2_600;
const PICKER_ORB_SIZE = 44;

function sameSettings(a: IndicatorSettings, b: IndicatorSettings): boolean {
  return a.style === b.style
    && a.color === b.color
    && a.customColor === b.customColor
    && a.glow === b.glow
    && a.activity === b.activity
    && a.speed === b.speed;
}

function useRovingRadios<T extends string>(
  options: readonly T[],
  value: T,
  onPick: (value: T) => void,
): {
  groupProps: { onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void };
  radioProps: (option: T) => {
    role: "radio";
    "aria-checked": boolean;
    tabIndex: number;
    ref: (node: HTMLButtonElement | null) => void;
    onClick: () => void;
  };
} {
  const nodes = useRef(new Map<T, HTMLButtonElement>());
  const focusable = options.includes(value) ? value : options[0];
  return {
    groupProps: {
      onKeyDown: (event) => {
        const current = options.findIndex((option) => nodes.current.get(option) === event.target);
        if (current < 0) return;
        const next = event.key === "ArrowRight" || event.key === "ArrowDown"
          ? (current + 1) % options.length
          : event.key === "ArrowLeft" || event.key === "ArrowUp"
            ? (current - 1 + options.length) % options.length
            : event.key === "Home"
              ? 0
              : event.key === "End"
                ? options.length - 1
                : -1;
        if (next < 0) return;
        event.preventDefault();
        const option = options[next]!;
        nodes.current.get(option)?.focus();
        onPick(option);
      },
    },
    radioProps: (option) => ({
      role: "radio",
      "aria-checked": option === value,
      tabIndex: option === focusable ? 0 : -1,
      ref: (node) => {
        if (node) nodes.current.set(option, node);
        else nodes.current.delete(option);
      },
      onClick: () => onPick(option),
    }),
  };
}

function AutomaticPreview({ animate }: { animate: boolean }): React.JSX.Element {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (!animate) return;
    const timer = window.setInterval(
      () => setIndex((current) => (current + 1) % AUTOMATIC_PREVIEW_PHASES.length),
      AUTOMATIC_PREVIEW_INTERVAL_MS,
    );
    return () => window.clearInterval(timer);
  }, [animate]);
  const motion = orbMotionForPhase(animate ? AUTOMATIC_PREVIEW_PHASES[index]! : "thinking");
  return <WorkingOrb size={PICKER_ORB_SIZE} design={motion.design} />;
}

export function WorkingIndicatorSettings({
  settings,
  disabled,
  onUpdate,
}: {
  settings: unknown;
  disabled: boolean;
  onUpdate: (settings: Partial<AppSettings>) => Promise<void> | void;
}): React.JSX.Element {
  const serialized = JSON.stringify(settings ?? null);
  const saved = useMemo(() => parseWorkingIndicatorSettings(JSON.parse(serialized)), [serialized]);
  const [pending, setPending] = useState<IndicatorSettings | null>(null);
  const [draftColor, setDraftColor] = useState<string | null>(null);
  const latest = useRef<IndicatorSettings>(saved);
  const value = pending ?? saved;
  latest.current = value;
  const colorInput = useRef<HTMLInputElement | null>(null);
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const documentVisible = useDocumentVisibility();

  useEffect(() => {
    if (pending && sameSettings(pending, saved)) setPending(null);
  }, [pending, saved]);

  const commit = (patch: Partial<IndicatorSettings>): void => {
    const next = { ...latest.current, ...patch };
    if (sameSettings(next, latest.current)) return;
    latest.current = next;
    setPending(next);
    void Promise.resolve(onUpdate({ workingIndicator: next })).catch(() => {
      setPending((current) => (current === next ? null : current));
    });
  };

  const openColorPicker = (): void => {
    const input = colorInput.current;
    if (!input || input.disabled) return;
    try {
      input.showPicker();
    } catch {
      input.click();
    }
  };

  const commitDraftColor = (raw: string): void => {
    setDraftColor(null);
    const customColor = normalizeHexColor(raw);
    if (customColor) commit({ color: "custom", customColor });
  };

  useEffect(() => {
    const input = colorInput.current;
    if (!input) return;
    const onChange = (): void => commitDraftColor(input.value);
    input.addEventListener("change", onChange);
    return () => input.removeEventListener("change", onChange);
  });

  const preview = useMemo<IndicatorSettings>(() => {
    const customColor = draftColor ? normalizeHexColor(draftColor) : null;
    return customColor ? { ...value, color: "custom", customColor } : value;
  }, [draftColor, value]);

  const styles = useRovingRadios(WORKING_INDICATOR_STYLES, value.style, (style) => commit({ style }));
  const colors = useRovingRadios(WORKING_INDICATOR_COLORS, preview.color, (color) => commit({ color }));
  const speeds = useRovingRadios(WORKING_INDICATOR_SPEEDS, value.speed, (speed) => commit({ speed }));
  const animatePreview = !reducedMotion && documentVisible;

  return (
    <WorkingIndicatorProvider settings={preview}>
      <section className="working-indicator-settings" aria-labelledby="working-indicator-heading">
        <div className="working-indicator-heading">
          <span>
            <h4 id="working-indicator-heading">Agent activity</h4>
            <p id="working-indicator-description">What Inertia shows while an agent is working. Reduced motion always shows one still frame.</p>
          </span>
        </div>
        <strong className="working-indicator-label" id="working-indicator-style-label">Working indicator</strong>
        <div
          className="working-indicator-picker"
          role="radiogroup"
          aria-labelledby="working-indicator-style-label"
          aria-describedby="working-indicator-description"
          {...styles.groupProps}
        >
          {WORKING_INDICATOR_STYLES.map((style) => {
            const copy = STYLE_LABELS[style];
            return (
              <button
                type="button"
                key={style}
                className={clsx("working-indicator-option", value.style === style && "is-active")}
                data-indicator-style={style}
                aria-label={copy.label}
                title={copy.detail}
                disabled={disabled}
                {...styles.radioProps(style)}
              >
                <span className="working-indicator-stage" aria-hidden="true">
                  {style === "classic"
                    ? <span className="working-indicator-classic"><AgentPixelGrid animated={animatePreview} /></span>
                    : style === "automatic"
                      ? <AutomaticPreview animate={animatePreview} />
                      : <WorkingOrb size={PICKER_ORB_SIZE} design={style} />}
                </span>
                <span className="working-indicator-option-label" aria-hidden="true">{copy.label}</span>
                <span className="working-indicator-option-badge" aria-hidden="true">{copy.badge ?? ""}</span>
              </button>
            );
          })}
        </div>
        <div className="response-density-setting working-indicator-row">
          <span>
            <strong id="working-indicator-color-label">Colour</strong>
            <small>Theme ink follows light and dark mode. Accent follows the palette.</small>
          </span>
          <div className="working-indicator-colors">
            <div
              className="working-indicator-swatches"
              role="radiogroup"
              aria-labelledby="working-indicator-color-label"
              {...colors.groupProps}
            >
              {WORKING_INDICATOR_COLORS.map((color) => {
                const radio = colors.radioProps(color);
                const label = color === "custom"
                  ? `${COLOR_LABELS.custom} colour, ${preview.customColor}`
                  : COLOR_LABELS[color];
                return (
                  <button
                    type="button"
                    key={color}
                    className="working-indicator-swatch"
                    data-indicator-color={color}
                    aria-label={label}
                    title={label}
                    disabled={disabled}
                    style={color === "custom" ? { "--indicator-custom": preview.customColor } as React.CSSProperties : undefined}
                    {...radio}
                    onClick={color === "custom"
                      ? () => {
                          radio.onClick();
                          openColorPicker();
                        }
                      : radio.onClick}
                  />
                );
              })}
            </div>
            <input
              ref={colorInput}
              type="color"
              className="working-indicator-color-input"
              aria-hidden="true"
              tabIndex={-1}
              value={draftColor ?? value.customColor}
              disabled={disabled}
              onChange={(event) => setDraftColor(event.currentTarget.value)}
              onBlur={(event) => {
                if (draftColor !== null) commitDraftColor(event.currentTarget.value);
              }}
            />
          </div>
        </div>
        <div className="settings-rows working-indicator-switches">
          <div className="setting-row">
            <span className="setting-copy">
              <strong>Glow</strong>
              <small>{preview.color === "ink" ? "Choose a colour to add a soft halo." : "A soft halo in the indicator's colour."}</small>
            </span>
            <Switch
              label="Glow"
              checked={value.glow}
              disabled={disabled || preview.color === "ink"}
              onChange={(glow) => commit({ glow })}
            />
          </div>
          <div className="setting-row">
            <span className="setting-copy">
              <strong>Use for tool and step activity</strong>
              <small>Automatic can match running tools, subagents and reasoning steps. Fixed styles only change the Work tab and working indicator.</small>
            </span>
            <Switch
              label="Use for tool and step activity"
              checked={value.style === "automatic" && value.activity}
              disabled={disabled || value.style !== "automatic"}
              onChange={(activity) => commit({ activity })}
            />
          </div>
        </div>
        <div className="response-density-setting working-indicator-row">
          <span>
            <strong id="working-indicator-speed-label">Speed</strong>
            <small>Waiting and stopping states always move at half this pace.</small>
          </span>
          <div role="radiogroup" aria-labelledby="working-indicator-speed-label" {...speeds.groupProps}>
            {WORKING_INDICATOR_SPEEDS.map((speed) => (
              <button
                type="button"
                key={speed}
                className={clsx(value.speed === speed && "is-active")}
                disabled={disabled}
                {...speeds.radioProps(speed)}
              >
                {SPEED_LABELS[speed]}
              </button>
            ))}
          </div>
        </div>
      </section>
    </WorkingIndicatorProvider>
  );
}

