import { providerChildEnvironment } from "../environment";
import { isProcessTreeTerminationUnconfirmed } from "../process-lifecycle";
import { providerNativeBackendProfile } from "../../shared/model-routing";
import { providerAuthLaunchEnvironment, providerAuthLoginArgs } from "./auth";
import { ProviderRuntimeError, type ProviderAuthLaunch, type ProviderId } from "./contracts";
import { sameProviderInstallationIdentity } from "./installation-lease";
import { kimiAcpProcessInvocation } from "./kimi-acp-harness";
import { probeKimiAuthentication } from "./kimi-auth-probe";
import { providerProcessInvocation, providerPtyArguments } from "./process";
import type { ProviderManagerInstallationAuthority } from "./provider-manager-installation";

/** Prepare only a user-requested sign-in. The existing terminal owns execution. */
export async function prepareProviderAuthLaunch(options: {
  providerId: ProviderId;
  executable: string;
  cwd: string;
  environment: NodeJS.ProcessEnv;
  signal: AbortSignal;
  installationAuthority: ProviderManagerInstallationAuthority;
}): Promise<ProviderAuthLaunch> {
  const { providerId, executable, cwd, signal, installationAuthority } = options;
  signal.throwIfAborted();
  const environment = providerAuthLaunchEnvironment(
    providerId, providerChildEnvironment(providerId, options.environment),
  );
  const backend = providerNativeBackendProfile(providerId);
  // Keep one installation lease across ACP negotiation and the PTY handoff;
  // an updater must not replace the executable between those two processes.
  const admission = installationAuthority.acquire(
    providerId, executable, backend, "auth-discovery",
    installationAuthority.operationIdentity("auth-discovery"),
  );
  let quarantined = false;
  try {
    const method = providerId === "kimi"
      ? await probeKimiAuthentication(executable, cwd, environment, signal)
      : undefined;
    signal.throwIfAborted();
    if (admission && !sameProviderInstallationIdentity(
      admission.identity, installationAuthority.identity(providerId, executable, backend),
    )) {
      quarantined = true;
      installationAuthority.quarantine(admission, "provider-auth-installation-changed");
      throw new ProviderRuntimeError("lifecycle_corruption", "The provider installation changed during sign-in preparation.");
    }
    const terminalMethod = method && "type" in method && method.type === "terminal" ? method : undefined;
    const childEnvironment = terminalMethod ? { ...environment, ...terminalMethod.env } : environment;
    const invocation = terminalMethod
      ? kimiAcpProcessInvocation(executable, childEnvironment, process.platform, terminalMethod.args)
      : providerProcessInvocation(executable, providerAuthLoginArgs(providerId), childEnvironment);
    return {
      executable: invocation.command,
      args: providerPtyArguments(invocation),
      env: childEnvironment,
      installationUse: installationAuthority.transfer(admission),
    };
  } catch (error) {
    if (!quarantined) {
      if (isProcessTreeTerminationUnconfirmed(error)) {
        installationAuthority.quarantine(admission, "provider-auth-probe-cleanup-unconfirmed");
      } else if (!installationAuthority.release(admission)) {
        throw new ProviderRuntimeError("lifecycle_corruption", "Provider sign-in preparation could not release its installation authority.");
      }
    }
    throw error;
  }
}
