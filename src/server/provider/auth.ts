import type { ProviderId } from "./contracts";

const PROVIDER_AUTH: Readonly<Record<ProviderId, { statusArgs: readonly string[]; loginArgs: readonly string[] }>> = Object.freeze({
  codex: { statusArgs: ["login", "status"], loginArgs: ["login"] },
  claude: { statusArgs: ["auth", "status", "--json"], loginArgs: ["auth", "login"] },
  cursor: { statusArgs: ["status"], loginArgs: ["login"] },
  opencode: { statusArgs: ["auth", "list"], loginArgs: ["auth", "login"] },
});

export function providerAuthStatusArgs(providerId: ProviderId): readonly string[] {
  return PROVIDER_AUTH[providerId].statusArgs;
}

export function providerAuthLoginArgs(providerId: ProviderId): readonly string[] {
  return PROVIDER_AUTH[providerId].loginArgs;
}
