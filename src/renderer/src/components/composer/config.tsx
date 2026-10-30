import {
  Download,
  KeyRound,
  Plug,
  RefreshCw,
  Wrench,
} from "lucide-react";
import { ACCESS_MODE_LABELS } from "@shared/access-labels";
import type { AccessMode } from "@shared/contracts";
import { LoadingMark } from "../ui";
import type { ComposerRouteRepair } from "../../utils/composerReadiness";
import type { ComposerMenu } from "./types";

export { ACCESS_MODE_LABELS, INTERACTION_MODE_LABELS } from "@shared/access-labels";

export const RESPONSE_SPEED_LABEL = "Response speed";

export const accessOptions: Array<{
  value: AccessMode;
  label: string;
  description: string;
}> = [
  {
    value: "supervised",
    label: ACCESS_MODE_LABELS.supervised,
    description: "Use this provider's restricted mode and native approvals",
  },
  {
    value: "auto-edit",
    label: ACCESS_MODE_LABELS["auto-edit"],
    description: "Allow edits; other actions follow the provider's policy",
  },
  {
    value: "full",
    label: ACCESS_MODE_LABELS.full,
    description: "Bypass provider approval and sandbox protections",
  },
];

export function menuId(menu: ComposerMenu): string {
  return `composer-${menu}-menu`;
}

export function composerHarnessLabel(harnessId: string): string {
  if (harnessId === "pi-rpc") return "Pi";
  return harnessId.startsWith("claude")
    ? "Claude harness"
    : harnessId.startsWith("codex")
      ? "Codex harness"
      : harnessId.startsWith("cursor")
        ? "Cursor"
          : harnessId.startsWith("antigravity")
            ? "Antigravity"
            : harnessId.startsWith("kimi")
              ? "Kimi Code"
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
  if (pending) return <LoadingMark size={14} aria-hidden="true" />;
  if (action === "refresh") return <RefreshCw size={14} />;
  if (action === "install") return <Download size={14} />;
  if (action === "connect") return <Plug size={14} />;
  if (action === "add-key") return <KeyRound size={14} />;
  return <Wrench size={14} />;
}
