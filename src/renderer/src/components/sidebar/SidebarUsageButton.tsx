import { Gauge } from "lucide-react";

import { IconButton } from "../ui";
import { useUsagePopupOpener } from "../usage-limits-state";
import { preloadUsagePopup } from "../usageLimitsLoaders";

export function SidebarUsageButton({ onOpen }: { onOpen(): void }): React.JSX.Element {
  const open = useUsagePopupOpener();
  return (
    <IconButton
      label="Usage"
      className="sidebar-destination"
      aria-haspopup="dialog"
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
