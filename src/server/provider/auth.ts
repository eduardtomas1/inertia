import type { ProviderId } from "./contracts";

interface ProviderAuthCommands {
  /** Null when the CLI has no bounded, non-interactive authentication probe. */
  statusArgs: readonly string[] | null;
  loginArgs: readonly string[];
  environment?: Readonly<NodeJS.ProcessEnv>;
}

const PROVIDER_AUTH: Readonly<Record<ProviderId, ProviderAuthCommands>> =
  Object.freeze({
    codex: { statusArgs: ["login", "status"], loginArgs: ["login"] },
    claude: {
      statusArgs: ["auth", "status", "--json"],
      loginArgs: ["auth", "login"],
    },
    cursor: { statusArgs: ["status"], loginArgs: ["login"] },
    kimi: { statusArgs: ["provider", "list", "--json"], loginArgs: ["login"] },
    opencode: { statusArgs: ["auth", "list"], loginArgs: ["auth", "login"] },
    antigravity: { statusArgs: null, loginArgs: [] },
  });

export function providerAuthStatusArgs(
  providerId: ProviderId,
): readonly string[] | null {
  return PROVIDER_AUTH[providerId].statusArgs;
}

export function providerAuthLoginArgs(providerId: ProviderId): readonly string[] {
  return PROVIDER_AUTH[providerId].loginArgs;
}

export function providerAuthLaunchEnvironment(
  providerId: ProviderId,
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return {
    ...environment,
    ...PROVIDER_AUTH[providerId].environment,
  };
}
