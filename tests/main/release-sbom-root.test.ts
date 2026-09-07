import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const { canonicalReleaseSbomRoot } = await import(pathToFileURL(
  resolve(import.meta.dirname, "../../scripts/release-sbom-root.mjs"),
).href);

const manifest = { name: "fixture-app", version: "1.2.3" };
const lockfile = { ...manifest, packages: { "": manifest } };
const component = {
  name: "fixture-app",
  version: "1.2.3",
  "bom-ref": "fixture-app@1.2.3",
  purl: "pkg:npm/fixture-app@1.2.3",
  properties: [{ name: "cdx:npm:package:path", value: "" }],
};

describe("release SBOM root package identity", () => {
  it("preserves canonical npm output and every non-name property", () => {
    expect(canonicalReleaseSbomRoot(component, manifest, lockfile, "checkout"))
      .toEqual(component);
  });

  it("normalizes only the verified npm checkout-name quirk without changing graph references", () => {
    const npmRoot = { ...component, name: "disposable-worktree" };
    expect(canonicalReleaseSbomRoot(npmRoot, manifest, lockfile, "disposable-worktree"))
      .toEqual(component);
    expect(npmRoot.name).toBe("disposable-worktree");
  });

  it.each([
    { name: "other-package" },
    { version: "9.9.9" },
    { "bom-ref": "other-package@1.2.3" },
    { purl: "pkg:npm/other-package@1.2.3" },
    { purl: "pkg:npm/fixture-app@1.2.3?unverified=true" },
    { "bom-ref": undefined },
    { purl: undefined },
  ])("rejects inconsistent root identity %j rather than renaming arbitrary output", (change) => {
    expect(() => canonicalReleaseSbomRoot(
      { ...component, ...change }, manifest, lockfile, "disposable-worktree",
    )).toThrow("locked package identity");
  });

  it.each([
    { ...lockfile, name: "different" },
    { ...lockfile, version: "1.2.2" },
    { ...lockfile, packages: { "": { ...manifest, name: "different" } } },
    { ...lockfile, packages: { "": { ...manifest, version: "1.2.2" } } },
    { ...lockfile, packages: {} },
    null,
  ])("rejects a stale or mismatched lock root %j", (lock) => {
    expect(() => canonicalReleaseSbomRoot(component, manifest, lock, "fixture-app"))
      .toThrow("locked package identity");
  });

  it.each([null, [], "fixture-app", {}])("rejects malformed root %j", (root) => {
    expect(() => canonicalReleaseSbomRoot(root, manifest, lockfile, "fixture-app"))
      .toThrow("locked package identity");
  });
});
