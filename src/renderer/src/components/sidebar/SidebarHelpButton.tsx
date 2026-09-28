import { CircleHelp } from "lucide-react";
import clsx from "clsx";

import { useHelpGuideOpen } from "../../hooks/useHelpGuideOpen";
import { openHelpGuide } from "../../utils/helpGuide";
import { loadWelcomeGuide } from "../lazySurfaceLoaders";

export function SidebarHelpButton(): React.JSX.Element {
  const open = useHelpGuideOpen();
  return (
    <button
      type="button"
      className={clsx("sidebar-destination", open && "is-open")}
      aria-label="Help"
      title="Help"
      aria-haspopup="dialog"
      aria-expanded={open}
      onFocus={() => void loadWelcomeGuide()}
      onPointerDown={() => void loadWelcomeGuide()}
      onPointerEnter={() => void loadWelcomeGuide()}
      onClick={() => openHelpGuide()}
    >
      <CircleHelp size={16} /><span>Help</span>
    </button>
  );
}
