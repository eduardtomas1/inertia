// @inertia-test-suite portable
import { describe, expect, it } from "vitest";

import { discoverPortableTests } from "../../scripts/ci/portable-test-manifest.mjs";
import { createDefaultAgentHarnessRegistry } from "../../src/server/provider/agent-harness-registry";
import { productionProviderCapabilityManifests } from "../../src/server/provider/capability-manifest";

describe("production provider portable-test registration", () => {
  it("keeps exactly one portable conformance owner for every production harness", async () => {
    const registry = createDefaultAgentHarnessRegistry();
    const productionHarnessIds = registry.list()
      .map((harness) => harness.id)
      .sort();
    const manifest = await discoverPortableTests();

    expect(Object.keys(manifest.harnessTests).sort()).toEqual(productionHarnessIds);
    expect(manifest.harnessTests["gemini-acp"]).toBe(
      "tests/server/gemini-acp-harness.test.ts",
    );
    for (const path of Object.values(manifest.harnessTests)) {
      expect(manifest.files).toContain(path);
    }

    expect(registry.capabilityManifests().map((entry) => [
      entry.providerId,
      entry.harnessId,
      entry.digest,
    ])).toEqual(productionProviderCapabilityManifests().map((entry) => [
      entry.providerId,
      entry.harnessId,
      entry.digest,
    ]));
  });
});
