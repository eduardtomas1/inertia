import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";

import electronViteConfig from "../../electron.vite.config";
import {
  lifecycleBuildMetadataFromEnvironment,
  lifecycleBuildMetadataSchema,
} from "../../src/shared/lifecycle-build-metadata";

describe("lifecycle build metadata bundling", () => {
  it("defines only the validated metadata captured from the build environment", () => {
    const config = electronViteConfig as unknown as {
      readonly main?: { readonly define?: Record<string, string> };
    };
    const serialized = config.main?.define?.__INERTIA_BUILD_METADATA__;
    expect(serialized).toBeTypeOf("string");
    if (typeof serialized !== "string") {
      throw new Error("The lifecycle build metadata define is unavailable.");
    }
    const bundled: unknown = JSON.parse(serialized);
    const checkedOutRevision = process.env.GITHUB_ACTIONS === "true"
      ? execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
          encoding: "utf8",
          maxBuffer: 1_024,
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 5_000,
        }).trim().toLowerCase()
      : process.env.GITHUB_SHA;
    expect(bundled).toEqual(lifecycleBuildMetadataFromEnvironment({
      GITHUB_ACTIONS: process.env.GITHUB_ACTIONS,
      GITHUB_SHA: checkedOutRevision,
      GITHUB_RUN_ID: process.env.GITHUB_RUN_ID,
      GITHUB_RUN_ATTEMPT: process.env.GITHUB_RUN_ATTEMPT,
      GITHUB_REF_TYPE: process.env.GITHUB_REF_TYPE,
      GITHUB_REF_NAME: process.env.GITHUB_REF_NAME,
    }));
    if (bundled !== null) {
      expect(lifecycleBuildMetadataSchema.safeParse(bundled).success).toBe(true);
    }
  });
});
