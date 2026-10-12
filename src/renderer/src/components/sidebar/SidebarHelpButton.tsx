import { CircleHelp } from "lucide-react";
import clsx from "clsx";

import { useHelpGuideOpen } from "../../hooks/useHelpGuideOpen";
import { openHelpGuide } from "../../utils/helpGuide";
import { loadWelcomeGuide } from "../lazySurfaceLoaders";
import { IconButton } from "../ui";

export function SidebarHelpButton(): React.JSX.Element {
  const open = useHelpGuideOpen();
  return (
    <IconButton
      label="Help"
      className={clsx("sidebar-destination", open && "is-open")}
      aria-haspopup="dialog"
      aria-expanded={open}
      onFocus={() => void loadWelcomeGuide()}
      onPointerDown={() => void loadWelcomeGuide()}
      onPointerEnter={() => void loadWelcomeGuide()}
      onClick={() => openHelpGuide()}
    >
      <CircleHelp size={16} />
    </IconButton>
  );
}
