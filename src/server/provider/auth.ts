import {
  providerSupportsAuthMethod,
  type ProviderAuthMethod,
} from "../../shared/provider";
import { ProviderRuntimeError, type ProviderId } from "./contracts";

interface ProviderAuthCommands {
  /** Null when the CLI has no bounded, non-interactive authentication probe. */
  statusArgs: readonly string[] | null;
  loginArgs: readonly string[];
  consoleLoginArgs?: readonly string[];
  environment?: Readonly<NodeJS.ProcessEnv>;
}

const PROVIDER_AUTH: Readonly<Record<ProviderId, ProviderAuthCommands>> =
  Object.freeze({
    codex: { statusArgs: ["login", "status"], loginArgs: ["login"] },
    claude: {
      statusArgs: ["auth", "status", "--json"],
      loginArgs: ["auth", "login"],
      consoleLoginArgs: ["auth", "login", "--console"],
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

export function providerAuthLoginArgs(
  providerId: ProviderId,
  method: ProviderAuthMethod = "account",
): readonly string[] {
  const commands = PROVIDER_AUTH[providerId];
  if (method === "account") return commands.loginArgs;
  if (!providerSupportsAuthMethod(providerId, method) || !commands.consoleLoginArgs) {
    throw new ProviderRuntimeError(
      "invalid_input",
      "Console sign-in is available only for Claude.",
    );
  }
  return commands.consoleLoginArgs;
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
