import { memo, useEffect, useRef } from "react";
import { useDocumentActivity } from "../../hooks/useDocumentPresence";
import "./sidebar-aurora.css";

/**
 * Time between drift updates. The lights move about 1 px per update, which
 * reads as continuous motion on soft gradients, while a frame is produced only
 * 8 times a second instead of at the display refresh rate.
 */
export const SIDEBAR_AURORA_STEP_MS = 125;

/**
 * Decorative light behind the sidebar brand. It is hidden from assistive
 * technology and takes no pointer input. Its CSS animations stay paused, and
 * this component advances them on a coarse timer only while motion is allowed
 * and the window is visible and focused; otherwise the light holds its place.
 */
export const SidebarAurora = memo(function SidebarAurora({ moving }: {
  /** False for reduced motion or a closed mobile drawer. */
  moving: boolean;
}): React.JSX.Element {
  const auroraRef = useRef<HTMLDivElement>(null);
  const documentActive = useDocumentActivity();
  const drifting = moving && documentActive;

  useEffect(() => {
    const aurora = auroraRef.current;
    if (!drifting || !aurora) return;
    let layers: Animation[] = [];
    let origins: number[] = [];
    let startedAt = 0;
    const capture = () => {
      layers = aurora.getAnimations({ subtree: true });
      origins = layers.map((layer) => Number(layer.currentTime ?? 0));
      startedAt = performance.now();
    };
    capture();
    const timer = window.setInterval(() => {
      // A style change cancels CSS animations and may start new ones. Never
      // revive a cancelled animation by assigning a time; follow the new set.
      // An empty capture also retries, so the light still starts if the
      // stylesheet arrives after this effect.
      if (layers.length === 0 || layers.some((layer) => layer.playState === "idle")) {
        capture();
        return;
      }
      const elapsed = performance.now() - startedAt;
      layers.forEach((layer, index) => {
        layer.currentTime = origins[index]! + elapsed;
      });
    }, SIDEBAR_AURORA_STEP_MS);
    return () => window.clearInterval(timer);
  }, [drifting]);

  return (
    <div ref={auroraRef} className="sidebar-aurora" aria-hidden="true">
      <span className="sidebar-aurora-far" />
      <span className="sidebar-aurora-near" />
      <span className="sidebar-aurora-glow" />
    </div>
  );
});
