import { memo, type CSSProperties } from "react";
import { SIDEBAR_STARFIELD } from "./sidebarStarLayout";

/**
 * A few seeded stars seen through the aurora. Each star is its own element
 * whose opacity breathes in a plain CSS animation, so the compositor can run
 * it; the field itself drifts with the aurora's stepped layers.
 */
export const SidebarStarfield = memo(function SidebarStarfield(): React.JSX.Element {
  return (
    <span className="sidebar-aurora-stars">
      {SIDEBAR_STARFIELD.map((star, index) => (
        <span
          key={index}
          className="sidebar-star"
          data-depth={star.depth}
          data-macos={star.macos ? undefined : "hidden"}
          style={{ left: `${star.x}%`, top: star.y, "--star-t": star.period, "--star-phase": star.phase } as CSSProperties}
        />
      ))}
    </span>
  );
});
