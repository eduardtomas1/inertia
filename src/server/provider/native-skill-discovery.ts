import { providerChildEnvironment, providerEnvironment } from "../environment";
import { isProcessTreeTerminationUnconfirmed } from "../process-lifecycle";
import { providerNativeBackendProfile } from "../../shared/model-routing";
import { readClaudeAgentSdkSkills } from "./claude-agent-sdk-harness";
import { ProviderRuntimeError } from "./contracts";
import type { ProviderInstallationVerificationAuthority } from "./installation-lease";
import { readPiSkills } from "./pi-skills";
import type { ProviderManagerInstallationAuthority } from "./provider-manager-installation";

/** Reads Claude's native skills under an exact metadata-discovery admission of its installation. */
export async function discoverClaudeSkills(
  installationAuthority: ProviderManagerInstallationAuthority,
  executable: string,
  cwd: string,
  forceReload: boolean,
  options: {
    authority?: ProviderInstallationVerificationAuthority;
    rememberEnvironment(environment: NodeJS.ProcessEnv): void;
  },
): Promise<Awaited<ReturnType<typeof readClaudeAgentSdkSkills>>> {
  const environment = await providerEnvironment();
  options.rememberEnvironment(environment.env);
  const { authority } = options;
  const admission = installationAuthority.acquire(
    "claude",
    executable,
    providerNativeBackendProfile("claude"),
    "metadata-discovery",
    installationAuthority.operationIdentity("metadata-discovery", authority),
    authority,
  );
  let skills: Awaited<ReturnType<typeof readClaudeAgentSdkSkills>>;
  try {
    skills = await readClaudeAgentSdkSkills(
      executable,
      providerChildEnvironment("claude", environment.env),
      cwd,
      forceReload,
    );
  } catch (error) {
    if (isProcessTreeTerminationUnconfirmed(error)) {
      installationAuthority.quarantineUnconfirmedCleanup(
        admission,
        "claude-skill-discovery-cleanup-unconfirmed",
      );
    } else {
      installationAuthority.release(admission);
    }
    throw error;
  }
  if (!installationAuthority.release(admission)) {
    throw new ProviderRuntimeError(
      "lifecycle_corruption",
      "Claude skill discovery could not release exact installation authority.",
    );
  }
  return skills;
}

/** Reads Pi's native skills over an ephemeral RPC session under a metadata-discovery admission. */
export async function discoverPiSkills(
  installationAuthority: ProviderManagerInstallationAuthority,
  executable: string,
  cwd: string,
  track: <T>(operation: () => Promise<T>) => Promise<T>,
  signal: AbortSignal,
): Promise<Awaited<ReturnType<typeof readPiSkills>>> {
  const environment = await providerEnvironment();
  const admission = installationAuthority.acquire("pi", executable, providerNativeBackendProfile("pi"),
    "metadata-discovery", installationAuthority.operationIdentity("metadata-discovery"));
  try {
    const skills = await track(() => readPiSkills(executable, providerChildEnvironment("pi", environment.env), cwd, signal));
    if (!installationAuthority.release(admission)) throw new ProviderRuntimeError("lifecycle_corruption", "Pi skill discovery lost its installation authority.");
    return skills;
  } catch (error) {
    if (isProcessTreeTerminationUnconfirmed(error)) installationAuthority.quarantineUnconfirmedCleanup(admission, "pi-skill-discovery-cleanup-unconfirmed");
    else installationAuthority.release(admission);
    throw error;
  }
}
