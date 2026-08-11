import {
  Asterisk,
  Code2,
  Command,
  MousePointer2,
  type LucideIcon,
} from "lucide-react";

import type { ProviderId } from "@shared/contracts";

const providerIcons: Readonly<Record<ProviderId, LucideIcon>> = {
  codex: Command,
  claude: Asterisk,
  cursor: MousePointer2,
  opencode: Code2,
};

export function providerIcon(providerId: ProviderId): LucideIcon {
  return providerIcons[providerId];
}
