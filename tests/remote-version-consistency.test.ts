import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import remoteComponentVersions from "../remote/component-versions.json" with {
  type: "json",
};
import { REMOTE_BROWSER_VERSION } from "../src/shared/remote-protocol";
import {
  assertRemoteReadmeVersions,
  checkRemoteVersionConsistency,
} from "../scripts/check-remote-version-consistency.mjs";

describe("Remote Companion component versions", () => {
  it("keeps every release-facing browser version on the canonical source", async () => {
    await expect(checkRemoteVersionConsistency()).resolves.toEqual(
      remoteComponentVersions,
    );
    expect(REMOTE_BROWSER_VERSION).toBe(remoteComponentVersions.browser);

    const builtHtmlTemplate = await readFile(
      "remote/browser/index.html",
      "utf8",
    );
    expect(builtHtmlTemplate).not.toContain("version=0.2.0;relay=");
  });

  it("rejects deployment instructions with a stale relay installation path", async () => {
    const readme = await readFile("remote/README.md", "utf8");
    const futureRelayVersion = "9.9.9";
    const advancedArtifactsOnly = readme.replaceAll(
      `inertia-remote-relay-${remoteComponentVersions.relay}.tar.gz`,
      `inertia-remote-relay-${futureRelayVersion}.tar.gz`,
    );

    expect(() => assertRemoteReadmeVersions(advancedArtifactsOnly, {
      ...remoteComponentVersions,
      relay: futureRelayVersion,
    })).toThrow("inconsistent relay installation path");
  });
});
