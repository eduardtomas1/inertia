import { RadioTower, SunMoon } from "lucide-react";
import clsx from "clsx";
import type { ThemePreference } from "@shared/contracts";

import { usePrivateConnectState } from "../../hooks/usePrivateConnectState";

export function SidebarDevicesButton({
  onOpen,
}: {
  onOpen: () => void;
}): React.JSX.Element | null {
  const privateConnect = usePrivateConnectState().state;
  if (!privateConnect) return null;
  const pending = privateConnect.pendingPairings.length;
  const label = pending > 0
    ? `Connections & devices, ${pending} pairing ${pending === 1 ? "approval" : "approvals"} waiting`
    : privateConnect.activeSessions > 0
      ? `Connections & devices, ${privateConnect.activeSessions} active browsers`
      : `Connections & devices ${privateConnect.status}`;
  return (
    <button
      type="button"
      className={clsx(
        "sidebar-destination sidebar-devices-button",
        pending > 0 && "has-pending",
        pending === 0 && privateConnect.activeSessions > 0 && "is-active",
      )}
      aria-label={label}
      title={label}
      onClick={onOpen}
    >
      <RadioTower size={16} />
      <span>Devices</span>
    </button>
  );
}

export function SidebarThemeButton({
  theme,
  onCycle,
}: {
  theme: ThemePreference;
  onCycle: () => void;
}): React.JSX.Element {
  const label = `Change theme (current: ${theme})`;
  return (
    <button
      type="button"
      className="sidebar-destination"
      aria-label={label}
      title={label}
      onClick={onCycle}
    >
      <SunMoon size={16} />
      <span>Theme</span>
    </button>
  );
}
