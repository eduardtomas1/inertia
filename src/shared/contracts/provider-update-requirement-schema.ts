const PROVIDER_UPDATE_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/u;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validProviderUpdateRequirement(provider: Record<string, unknown>): boolean {
  const requirement = provider.updateRequired;
  if (requirement === undefined) return true;
  return record(requirement)
    && Object.keys(requirement).length === 2
    && [requirement.installedVersion, requirement.minimumVersion].every((version) =>
      typeof version === "string" && PROVIDER_UPDATE_VERSION.test(version))
    && provider.installState === "installed"
    && provider.canRun === false;
}
