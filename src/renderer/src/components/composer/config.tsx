import {
  Download,
  KeyRound,
  PlugZap,
  RefreshCw,
  Wrench,
} from "lucide-react";
import type { AccessMode } from "@shared/contracts";
import type { ComposerRouteRepair } from "../../utils/composerReadiness";
import type { ComposerMenu } from "./types";

export const RESPONSE_SPEED_LABEL = "Response speed";

export const MAX_SELECTED_SKILLS = 8;

export const accessOptions: Array<{
  value: AccessMode;
  label: string;
  description: string;
}> = [
  {
    value: "supervised",
    label: "Supervised",
    description: "Use this provider's restricted mode and native approvals",
  },
  {
    value: "auto-edit",
    label: "Auto-accept edits",
    description: "Allow edits; other actions follow the provider's policy",
  },
  {
    value: "full",
    label: "Full access",
    description: "Bypass provider approval and sandbox protections",
  },
];

export function menuId(menu: ComposerMenu): string {
  return `composer-${menu}-menu`;
}

export function composerHarnessLabel(harnessId: string): string {
  return harnessId.startsWith("claude")
    ? "Claude harness"
    : harnessId.startsWith("codex")
      ? "Codex harness"
      : harnessId.startsWith("cursor")
        ? "Cursor"
        : "OpenCode";
}

export function routeRepairLabel(action: ComposerRouteRepair): string {
  if (action === "add-key") return "Add key";
  if (action === "configure") return "Open setup";
  return action[0].toUpperCase() + action.slice(1);
}

export function RouteRepairIcon({
  action,
  pending,
}: {
  action: ComposerRouteRepair;
  pending: boolean;
}): React.JSX.Element {
  if (pending || action === "refresh") {
    return (
      <RefreshCw
        size={13}
        className={pending ? "is-spinning" : undefined}
      />
    );
  }
  if (action === "install") return <Download size={13} />;
  if (action === "connect") return <PlugZap size={13} />;
  if (action === "add-key") return <KeyRound size={13} />;
  return <Wrench size={13} />;
}
