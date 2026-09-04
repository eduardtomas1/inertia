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
    // Gemini's selected method may be OAuth, an API key, Vertex AI, or a
    // gateway. It has no non-interactive status command that can attest all of
    // them, so the ACP session remains the authentication authority. Launching
    // the bare interactive CLI is Gemini's supported setup flow.
    // NO_BROWSER selects Gemini's official manual OAuth path. The CLI prints
    // its one-time URL and waits for the code in our terminal, while Inertia
    // opens that reviewed URL exactly once instead of racing Gemini's opener.
    gemini: {
      statusArgs: null,
      loginArgs: [],
      environment: { NO_BROWSER: "true" },
    },
    kimi: { statusArgs: ["provider", "list", "--json"], loginArgs: ["login"] },
    opencode: { statusArgs: ["auth", "list"], loginArgs: ["auth", "login"] },
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
