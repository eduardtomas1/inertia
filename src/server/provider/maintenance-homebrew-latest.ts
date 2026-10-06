import { providerEnvironment } from "../environment";
import type { HomebrewLatestSource } from "./maintenance-install-source";
import { runProviderMaintenanceAction } from "./maintenance-runner";

const HOMEBREW_INFO_TIMEOUT_MS = 10_000;

export type HomebrewInfoReader = (
  brew: string,
  args: readonly string[],
) => Promise<string | null>;

export function homebrewInfoArgs(source: HomebrewLatestSource): string[] {
  return ["info", "--json=v2", source.cask ? "--cask" : "--formula", source.name];
}

export async function readHomebrewInfo(
  brew: string,
  args: readonly string[],
  options: { environment?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<string | null> {
  const environment = options.environment ?? (await providerEnvironment()).env;
  try {
    const result = await runProviderMaintenanceAction({
      executable: brew,
      args,
      lockKey: `homebrew-info:${brew}`,
      installMethod: "homebrew",
      label: "Read the Homebrew release",
    }, {
      environment,
      signal: new AbortController().signal,
      timeoutMs: options.timeoutMs ?? HOMEBREW_INFO_TIMEOUT_MS,
      rawStdout: true,
      additionalEnvironment: {
        HOMEBREW_NO_ANALYTICS: "1",
        HOMEBREW_NO_AUTO_UPDATE: "1",
      },
    });
    return result.status === "succeeded"
      && result.cleanupConfirmed
      && !result.outputTruncated
      ? result.output
      : null;
  } catch {
    return null;
  }
}

export function homebrewLatestVersion(
  json: string,
  cask: boolean,
): unknown {
  const parsed = JSON.parse(json) as {
    formulae?: Array<{ versions?: { stable?: unknown } }>;
    casks?: Array<{ version?: unknown }>;
  };
  if (cask) {
    const version = parsed.casks?.[0]?.version;
    return typeof version === "string" ? version.split(",", 1)[0] : null;
  }
  return parsed.formulae?.[0]?.versions?.stable ?? null;
}
