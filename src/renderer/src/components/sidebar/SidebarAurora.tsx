import { memo, useEffect, useRef } from "react";
import { useDocumentActivity } from "../../hooks/useDocumentPresence";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { SidebarStarfield } from "./SidebarStarfield";
import "./sidebar-aurora.css";

/**
 * Time between drift updates. The lights move about 1 px per update, which
 * reads as continuous motion on soft gradients, while a frame is produced only
 * 8 times a second instead of at the display refresh rate.
 */
export const SIDEBAR_AURORA_STEP_MS = 125;
export const SIDEBAR_AURORA_WORKING_BREATH_RATE = 11 / 6;
/** Empty captures in a row before the timer gives up, for a hidden strip. */
export const SIDEBAR_AURORA_EMPTY_CAPTURE_LIMIT = 8;

export type SidebarAuroraActivity = "working" | "attention" | "idle";

function animationName(layer: Animation): string | undefined {
  return (layer as Partial<CSSAnimation>).animationName;
}

/** Star breathing runs on its own; the aurora's own transitions belong to the browser. */
function isStepped(layer: Animation, aurora: Element): boolean {
  return (layer.effect as KeyframeEffect | null | undefined)?.target !== aurora
    && !animationName(layer)?.startsWith("sidebar-star-");
}

/**
 * Decorative light behind the sidebar brand. It is hidden from assistive
 * technology and takes no pointer input. Its CSS animations stay paused, and
 * this component advances them on a coarse timer only while motion is allowed,
 * the window is visible and focused and colours are not forced; otherwise the
 * light holds its place. The stars' breathing plays as ordinary CSS animation
 * only in that same state (.is-live).
 */
export const SidebarAurora = memo(function SidebarAurora({ moving, activity = "idle" }: {
  /** False for reduced motion or a closed mobile drawer; the stars then rest. */
  moving: boolean;
  activity?: SidebarAuroraActivity;
}): React.JSX.Element {
  const auroraRef = useRef<HTMLDivElement>(null);
  const documentActive = useDocumentActivity();
  const forcedColors = useMediaQuery("(forced-colors: active)");
  const drifting = moving && documentActive && !forcedColors;
  const breathRate = activity === "working" ? SIDEBAR_AURORA_WORKING_BREATH_RATE : 1;

  useEffect(() => {
    const aurora = auroraRef.current;
    if (!drifting || !aurora) return;
    let layers: Animation[] = [];
    let origins: number[] = [];
    let rates: number[] = [];
    let startedAt = 0;
    let emptyCaptures = 0;
    const capture = () => {
      layers = aurora.getAnimations({ subtree: true }).filter((layer) => isStepped(layer, aurora));
      origins = layers.map((layer) => Number(layer.currentTime ?? 0));
      rates = layers.map((layer) => (animationName(layer) === "sidebar-aurora-breathe" ? breathRate : 1));
      startedAt = performance.now();
      emptyCaptures = layers.length === 0 ? emptyCaptures + 1 : 0;
    };
    capture();
    const timer = window.setInterval(() => {
      // A style change cancels CSS animations and may start new ones. Never
      // revive a cancelled animation by assigning a time; follow the new set.
      // An empty capture also retries, so the light still starts if the
      // stylesheet arrives after this effect, but a strip that stays hidden
      // stops the timer.
      if (layers.length === 0 || layers.some((layer) => layer.playState === "idle")) {
        if (emptyCaptures >= SIDEBAR_AURORA_EMPTY_CAPTURE_LIMIT) {
          window.clearInterval(timer);
          return;
        }
        capture();
        return;
      }
      const elapsed = performance.now() - startedAt;
      layers.forEach((layer, index) => {
        layer.currentTime = origins[index]! + elapsed * rates[index]!;
      });
    }, SIDEBAR_AURORA_STEP_MS);
    return () => window.clearInterval(timer);
  }, [breathRate, drifting]);

  return (
    <div
      ref={auroraRef}
      className={`sidebar-aurora ${moving ? "is-moving" : "is-still"}${drifting ? " is-live" : ""}`}
      data-activity={activity}
      aria-hidden="true"
    >
      <span className="sidebar-aurora-far" />
      <span className="sidebar-aurora-band" />
      <span className="sidebar-aurora-near" />
      <span className="sidebar-aurora-glow" />
      <SidebarStarfield />
    </div>
  );
});
