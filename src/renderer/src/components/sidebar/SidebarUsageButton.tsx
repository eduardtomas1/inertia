import { Gauge } from "lucide-react";
import clsx from "clsx";

import { IconButton } from "../ui";
import { useUsagePopupOpen, useUsagePopupOpener } from "../usage-limits-state";
import { preloadUsagePopup } from "../usageLimitsLoaders";

export function SidebarUsageButton({ onOpen }: { onOpen(): void }): React.JSX.Element {
  const open = useUsagePopupOpener();
  const showing = useUsagePopupOpen();
  return (
    <IconButton
      label="Usage"
      className={clsx("sidebar-destination", showing && "is-open")}
      aria-haspopup="dialog"
      aria-expanded={showing}
      data-usage-popup-opener=""
      onFocus={preloadUsagePopup}
      onPointerDown={preloadUsagePopup}
      onPointerEnter={preloadUsagePopup}
      onClick={(event) => {
        open?.(event.currentTarget);
        onOpen();
      }}
    >
      <Gauge size={16} />
    </IconButton>
  );
}
