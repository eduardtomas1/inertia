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

export const accessOptions: Array<{
  value: AccessMode;
  label: string;
  description: string;
}> = [
  {
    value: "supervised",
    label: "Supervised",
    description: "Ask before commands and edits",
  },
  {
    value: "auto-edit",
    label: "Auto-accept edits",
    description: "Allow edits; ask for other actions",
  },
  {
    value: "full",
    label: "Full access",
    description: "Run commands and edit without prompts",
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
