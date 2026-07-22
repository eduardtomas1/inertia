import type { ProviderInfo } from "@shared/contracts";

export type ProviderSetupAction = "connect" | "refresh" | null;

export function providerStateLabel(provider: ProviderInfo): string {
  if (provider.installState === "checking" || provider.authState === "checking") return "Checking";
  if (provider.installState === "not-installed") return "Not installed";
  if (provider.installState === "error") return "Detection failed";
  if ((provider.authState === "authenticated" || provider.authState === "configured") && !provider.canRun) return "Update required";
  if (provider.authState === "authenticated") return "Connected";
  if (provider.authState === "configured") return "Configured";
  if (provider.authState === "unauthenticated") return "Sign in required";
  if (provider.authState === "error") return "Connection issue";
  if (provider.canRun) return "Ready";
  return "Setup required";
}

export function providerStateDetail(provider: ProviderInfo): string {
  if (provider.statusMessage) return provider.version ? `${provider.statusMessage} · ${provider.version}` : provider.statusMessage;
  if (provider.installState === "checking" || provider.authState === "checking") return "Checking the local CLI and account…";
  if (provider.installState === "not-installed") return `${provider.label} CLI was not found on this device.`;
  if (provider.installState === "error") return `${provider.label} could not be checked.`;
  if (provider.authState === "authenticated") return provider.version ? `Connected · ${provider.version}` : "Connected and ready to work.";
  if (provider.authState === "configured") return provider.version ? `Configured · ${provider.version}` : "Configured and ready to work.";
  if (provider.authState === "unauthenticated") return `Connect your ${provider.label} account to start chatting.`;
  if (provider.authState === "error") return `Inertia could not confirm the ${provider.label} connection.`;
  if (provider.canRun) return provider.version ? `Available · ${provider.version}` : "Installed and ready to work.";
  return `${provider.label} is installed, but still needs setup.`;
}

export function providerSetupAction(provider: ProviderInfo): ProviderSetupAction {
  if (provider.installState === "checking" || provider.authState === "checking") return null;
  if (provider.installState !== "installed") return "refresh";
  if (provider.id === "opencode" && provider.authState === "unknown") return "connect";
  if ((provider.authState === "authenticated" || provider.authState === "configured") && !provider.canRun) return "refresh";
  if (!provider.canRun) return "connect";
  return "refresh";
}
