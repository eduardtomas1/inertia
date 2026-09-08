/**
 * npm 10's CycloneDX root uses Arborist's directory-derived node.name, while
 * bom-ref/purl use the manifest's package identity. Normalize only that known
 * presentation mismatch after independently checking the locked root identity.
 * Dependency references are left unchanged.
 */
export function canonicalReleaseSbomRoot(component, manifest, lockfile, checkoutName) {
  const name = manifest?.name;
  const version = manifest?.version;
  const root = lockfile?.packages?.[""];
  const reference = `${name}@${version}`;
  if (
    typeof name !== "string"
    || !/^[a-z0-9][a-z0-9._-]*$/u.test(name)
    || typeof version !== "string"
    || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version)
    || lockfile?.name !== name
    || lockfile?.version !== version
    || root?.name !== name
    || root?.version !== version
    || !component
    || typeof component !== "object"
    || Array.isArray(component)
    || component.version !== version
    || component["bom-ref"] !== reference
    || component.purl !== `pkg:npm/${reference}`
    || (component.name !== name
      && (typeof checkoutName !== "string" || component.name !== checkoutName))
  ) throw new Error("The release dependency SBOM root does not match the locked package identity.");
  return { ...component, name };
}
