import { z } from "zod";

const GITHUB_REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const GITHUB_RUN_ID_PATTERN = /^[1-9][0-9]{0,19}$/u;
const RELEASE_TAG_PATTERN = /^(?:canary-)?v(?:0|[1-9][0-9]{0,9})\.(?:0|[1-9][0-9]{0,9})\.(?:0|[1-9][0-9]{0,9})$/u;

export const lifecycleBuildMetadataSchema = z
  .object({
    source: z.literal("github-actions"),
    sourceRevision: z.string().regex(GITHUB_REVISION_PATTERN),
    runId: z.string().regex(GITHUB_RUN_ID_PATTERN),
    runAttempt: z.number().int().min(1).max(1_000_000),
    releaseTag: z.string().regex(RELEASE_TAG_PATTERN).nullable(),
  })
  .strict();

export type LifecycleBuildMetadata = z.infer<
  typeof lifecycleBuildMetadataSchema
>;

type BuildEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * Converts ambient CI values into a bounded, secret-free build identity.
 * Branch/ref names and arbitrary workflow text are intentionally excluded.
 */
export function lifecycleBuildMetadataFromEnvironment(
  environment: BuildEnvironment,
): LifecycleBuildMetadata | null {
  if (environment.GITHUB_ACTIONS !== "true") return null;
  const sourceRevision = environment.GITHUB_SHA?.toLowerCase() ?? "";
  const runId = environment.GITHUB_RUN_ID ?? "";
  const runAttemptText = environment.GITHUB_RUN_ATTEMPT ?? "";
  if (
    !GITHUB_REVISION_PATTERN.test(sourceRevision)
    || !GITHUB_RUN_ID_PATTERN.test(runId)
    || !GITHUB_RUN_ID_PATTERN.test(runAttemptText)
  ) return null;
  const runAttempt = Number(runAttemptText);
  const releaseTag = environment.GITHUB_REF_TYPE === "tag"
    && RELEASE_TAG_PATTERN.test(environment.GITHUB_REF_NAME ?? "")
    ? environment.GITHUB_REF_NAME!
    : null;
  const parsed = lifecycleBuildMetadataSchema.safeParse({
    source: "github-actions",
    sourceRevision,
    runId,
    runAttempt,
    releaseTag,
  });
  return parsed.success ? parsed.data : null;
}

declare const __INERTIA_BUILD_METADATA__: unknown;

/** Build-time constant in packaged/CI bundles; null in unbundled development. */
export function embeddedLifecycleBuildMetadata(): LifecycleBuildMetadata | null {
  const candidate = typeof __INERTIA_BUILD_METADATA__ === "undefined"
    ? null
    : __INERTIA_BUILD_METADATA__;
  const parsed = lifecycleBuildMetadataSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}
