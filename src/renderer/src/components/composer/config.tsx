import {
  Download,
  KeyRound,
  Plug,
  RefreshCw,
  Wrench,
} from "lucide-react";
import type { AccessMode } from "@shared/contracts";
import {
  ACCESS_MODE_LABELS,
  accessModeUnavailableReason,
  exceedsAccessCeiling,
  providerExceedsAccessLimit,
  UNSUPERVISED_PROVIDER_LIMIT_REASON,
} from "@shared/access-modes";
import { LoadingMark } from "../ui";
import type { ComposerRouteReadiness, ComposerRouteRepair } from "../../utils/composerReadiness";
import type { ComposerAccessCeiling, ComposerMenu } from "./types";

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

/**
 * Why an access option cannot be chosen for this chat, or null. Options above
 * the chat's initiative ceiling stay listed, disabled, with its reason.
 */
export function accessOptionUnavailableReason(
  providerId: string,
  mode: AccessMode,
  ceiling: ComposerAccessCeiling | undefined,
): string | null {
  return accessModeUnavailableReason(providerId, mode)
    ?? (ceiling && exceedsAccessCeiling(mode, ceiling.mode) ? ceiling.reason : null);
}

/**
 * Why this chat's route cannot send within its initiative's access limit, in
 * the composer's route notice, or null. The runtime refuses such a turn with
 * the same reason: Antigravity runs Supervised as Auto-accept edits, so it
 * cannot run under a Supervised limit.
 */
export function accessLimitRouteReadiness(
  providerId: string,
  accessMode: AccessMode,
  ceiling: ComposerAccessCeiling | undefined,
): ComposerRouteReadiness | null {
  if (!ceiling || !providerExceedsAccessLimit(providerId, accessMode, ceiling.mode)) return null;
  return {
    ready: false,
    transient: false,
    badge: "Access limit",
    title: `${ceiling.reason} ${UNSUPERVISED_PROVIDER_LIMIT_REASON}`,
    detail: "Choose another model to send messages in this chat.",
    action: null,
  };
}

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
