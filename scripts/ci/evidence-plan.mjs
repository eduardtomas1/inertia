import { readFileSync } from "node:fs";
import { classifyChangedPaths } from "./change-classifier.mjs";

export const PLATFORMS = Object.freeze(JSON.parse(
  readFileSync(new URL("./platforms.json", import.meta.url), "utf8"),
));
export const EVIDENCE_JOBS = Object.freeze({
  gate: "Quality gate",
  lineage: "Migration lineage / Reject released migration tamper",
  "node-22-minimum": "Node 22.13 minimum runtime",
  "pr-linux-core": "Linux core and portable conformance",
  "pr-linux-lifecycle": "Linux interaction and lifecycle",
  "pr-windows-lifecycle": "Windows x64 lifecycle sentinel",
  "pr-macos-lifecycle": "macOS arm64 lifecycle sentinel",
  test: "native matrix",
  electron: "native Electron matrix",
  "windows-unit": "Windows unit shards",
});
export const ELECTRON_CHECK_SUFFIX = " Electron";

export const PRIMARY_PLATFORM_ARTIFACTS = Object.freeze(["linux-x64", "windows-x64", "macos-arm64"]);
const SHA = /^[0-9a-f]{40}$/u;

function validReusedRun(reusedRun) {
  return Boolean(reusedRun) && Number.isSafeInteger(reusedRun.runId) && reusedRun.runId > 0
    && Number.isSafeInteger(reusedRun.pullRequest) && reusedRun.pullRequest > 0
    && SHA.test(reusedRun.sourceHead ?? "");
}

export function createEvidencePlan({
  head, sourceHead = head, base = null, baselineReason = "comparison-base",
  event = "pull_request", draft = false, paths = [], reusedRun = null,
}) {
  if (!SHA.test(head) || !SHA.test(sourceHead)) {
    throw new Error("CI requires the exact tested and source commit identities.");
  }
  if (!base || !SHA.test(base)) base = null;
  const changes = classifyChangedPaths(base ? paths : []);
  const certifiedRun = event === "push" && base !== null && validReusedRun(reusedRun) ? {
    runId: reusedRun.runId, pullRequest: reusedRun.pullRequest, sourceHead: reusedRun.sourceHead,
  } : null;
  const reused = certifiedRun && !changes.domains.includes("performance") ? certifiedRun : null;
  const reuseReasons = certifiedRun && !reused ? ["performance-change-measured-on-main"] : [];
  const lane = event === "schedule" ? "nightly"
    : event === "push" ? (reused ? "main-reused" : "main")
      : event === "merge_group" ? "merge"
        : event === "pull_request" ? (draft ? "draft" : "merge") : "unknown";
  const completeSiblings = lane === "nightly" || lane === "unknown";
  const full = lane !== "draft" && lane !== "main-reused"
    && (changes.fullCertification || completeSiblings);
  const domains = new Set(changes.domains);
  const selectedPlatforms = full
    ? (changes.nativeArchitecture || completeSiblings ? PLATFORMS
      : PLATFORMS.filter(({ artifact }) => PRIMARY_PLATFORM_ARTIFACTS.includes(artifact)))
    : lane === "draft" || lane === "main-reused" ? []
      : PLATFORMS.filter(({ artifact }) => (
        (domains.has("linux_appimage") && artifact.startsWith("linux-"))
        || (domains.has("windows_packaging") && artifact.startsWith("windows-"))
        || (domains.has("macos_packaging") && artifact.startsWith("macos-"))
      ));
  const platforms = selectedPlatforms.map(({ artifact }) => artifact);
  const shardSlug = (shard) => (shard ? `-${shard.replace("/", "-of-")}` : "");
  const phaseEntry = (platform, phase, shard = null) => ({
    ...platform, phase, ...(shard && { shard }),
    check: `${platform.label}${ELECTRON_CHECK_SUFFIX} (${shard ? `${phase} ${shard}` : phase})`,
    evidence_artifact: `${platform.artifact}-${phase}${shardSlug(shard)}`,
  });
  const isolatedShards = (platform) => (platform.artifact.startsWith("windows-") ? ["1/2", "2/2"] : [null]);
  const recoveryOnly = (platform) => !completeSiblings
    && !PRIMARY_PLATFORM_ARTIFACTS.includes(platform.artifact);
  const electronPlatforms = [
    ...selectedPlatforms.filter((platform) => !recoveryOnly(platform)).flatMap((platform) => [
      phaseEntry(platform, "display-sensitive"),
      ...isolatedShards(platform).map((shard) => phaseEntry(platform, "isolated", shard)),
    ]),
    ...selectedPlatforms.filter(recoveryOnly).map((platform) => phaseEntry(platform, "runtime-recovery")),
  ];
  const code = lane !== "main-reused" && (!changes.documentationOnly || full);
  const provider = domains.has("provider_common");
  const critical = !full && code;
  const jobs = {
    gate: true,
    lineage: true,
    "node-22-minimum": full || (code && domains.has("ci_test_infrastructure")),
    "pr-linux-core": code && !platforms.includes("linux-x64"),
    "pr-linux-lifecycle": critical && !platforms.includes("linux-x64")
      && (provider || domains.has("renderer_ui") || lane === "draft"),
    "pr-windows-lifecycle": critical && provider && !platforms.includes("windows-x64"),
    "pr-macos-lifecycle": critical && provider && !platforms.includes("macos-arm64"),
    test: platforms.length > 0,
    // Desktop Electron projects run beside, not after, the same platform's
    // units and package proof. Both jobs build the same candidate from source.
    electron: platforms.length > 0,
    "windows-unit": platforms.includes("windows-x64"),
  };
  const requiredJobs = Object.keys(jobs).filter((job) => jobs[job]);
  const requiredChecks = requiredJobs.flatMap((job) => job === "test"
    ? selectedPlatforms.map(({ label }) => label)
    : job === "electron"
      ? electronPlatforms.map(({ check }) => check)
    : job === "windows-unit"
      ? [1, 2, 3, 4].map((shard) => `Windows unit tests (${shard}/4)`)
      : [EVIDENCE_JOBS[job]]);
  return {
    schemaVersion: 1, head, sourceHead, base, baselineReason, event, lane, reusedRun: certifiedRun,
    paths: [...paths], domains: changes.domains,
    reasons: [baselineReason, ...reuseReasons, ...changes.reasons,
      lane === "main-reused" ? "certified-identical-tree-in-pull-request-run"
        : changes.documentationOnly ? "documentation-only" : full ? "full-native-contract"
          : "affected-contracts-without-unrelated-installers"],
    fullCertification: full, requiredJobs, requiredChecks, platforms,
    omittedPlatforms: PLATFORMS.filter(({ artifact }) => !platforms.includes(artifact))
      .map(({ artifact }) => ({ platform: artifact, reason: lane === "main-reused"
        ? "certified-identical-tree-in-pull-request-run"
        : full ? "sibling-architecture-certified-nightly-and-release"
          : "no-installer-obligation-in-this-lane" })),
    suites: ["shared-quality", "migration-lineage",
      ...(lane === "main-reused" ? ["reused-pull-request-certification"] : []),
      ...(code ? ["linux-all-source-coverage", "portable-provider-contracts"] : []),
      ...(jobs["pr-linux-lifecycle"] ? [domains.has("renderer_ui") ? "linux-full-electron" : "linux-core-bridge", "linux-recovery"] : []),
      ...(jobs["pr-windows-lifecycle"] ? ["windows-portable-and-lifecycle", "windows-codex-discovery"] : []),
      ...(jobs["pr-macos-lifecycle"] ? ["macos-portable-and-lifecycle"] : []),
      ...platforms.map((platform) => `${platform}:native-units-package-smoke`),
      ...selectedPlatforms.flatMap((platform) => recoveryOnly(platform)
        ? [`${platform.artifact}:electron-recovery`]
        : [`${platform.artifact}:electron-display-sensitive`, ...isolatedShards(platform).map((shard) => (
          `${platform.artifact}:electron-isolated${shardSlug(shard)}${shard === "2/2" ? "" : "-recovery"}`))]),
      ...platforms.filter((platform) => platform.startsWith("windows-"))
        .map((platform) => `${platform}:published-N-1-installed-upgrade`)],
    matrix: { include: selectedPlatforms },
    electronMatrix: { include: electronPlatforms },
    renderer: critical && domains.has("renderer_ui"),
    benchmarks: lane === "nightly" || (lane === "main" && domains.has("performance")),
    performanceSmoke: code && lane !== "draft" && ["performance", "renderer_ui", "turn_session",
      "runtime_supervisor", "database_migrations"].some((domain) => domains.has(domain)),
    omissions: Object.keys(jobs).filter((job) => !jobs[job]).map((job) => ({
      job, reason: lane === "main-reused" ? "certified-identical-tree-in-pull-request-run"
        : full ? "covered-by-full-native-matrix"
          : changes.documentationOnly ? "documentation-does-not-change-runtime"
            : lane === "draft" ? "draft-feedback-is-not-merge-certification"
              : "outside-affected-contracts-or-covered-by-selected-native-target",
    })),
  };
}

export function outputsForEvidencePlan(plan) {
  const outputs = {
    base_sha: plan.base ?? "",
    plan_json: JSON.stringify(plan),
    matrix_json: JSON.stringify(plan.matrix),
    electron_matrix_json: JSON.stringify(plan.electronMatrix),
    full_certification: plan.fullCertification,
    renderer: plan.renderer,
    benchmarks: plan.benchmarks,
    performance_smoke: plan.performanceSmoke,
  };
  for (const job of Object.keys(EVIDENCE_JOBS)) {
    outputs[job.replaceAll("-", "_")] = plan.requiredJobs.includes(job);
  }
  return Object.entries(outputs).map(([key, value]) => `${key}=${value}`).join("\n") + "\n";
}

// Missing evidence is never equivalent to an intentionally omitted job. The
// REST records additionally prove every matrix member, which `needs.test`
// alone cannot enumerate. Evidence comes only from this run, not PR artifacts.
export function evaluateMergeEvidence(plan, {
  head, sourceHead, event, draft, runId, needs, jobs, reusedRunJobs = [],
}) {
  const failures = [];
  if (!plan || plan.schemaVersion !== 1 || plan.head !== head || plan.sourceHead !== sourceHead) {
    return ["Plan identity does not match the exact candidate."];
  }
  if (plan.event !== event || typeof draft !== "boolean") failures.push("Plan event does not match the workflow context.");
  const expected = createEvidencePlan({ ...plan, event, draft });
  if (JSON.stringify(expected) !== JSON.stringify(plan)) failures.push("Plan is not canonical.");
  if (event === "pull_request" && draft) failures.push("Draft feedback does not authorize merge; mark ready for review.");
  if (needs.classify?.result !== "success") failures.push("Classification did not succeed.");
  for (const job of plan.requiredJobs) {
    if (needs[job]?.result !== "success") failures.push(`Required job ${job}: ${needs[job]?.result ?? "missing"}.`);
  }
  for (const { job } of plan.omissions) {
    if (needs[job] && needs[job].result !== "skipped") failures.push(`Unplanned job ${job} unexpectedly ran.`);
  }
  for (const name of plan.requiredChecks) {
    const matches = jobs.filter((job) => job.name === name);
    if (matches.length !== 1 || matches[0].run_id !== runId
      // Actions REST identifies PR jobs by the source head, not GITHUB_SHA's
      // synthetic merge commit. Every workflow checkout uses the latter.
      || matches[0].head_sha !== sourceHead || matches[0].status !== "completed"
      || matches[0].conclusion !== "success") failures.push(`Required check ${name} lacks exact successful evidence.`);
  }
  if (plan.lane === "main-reused") {
    const reused = plan.reusedRun;
    const matches = validReusedRun(reused) && Array.isArray(reusedRunJobs)
      ? reusedRunJobs.filter((job) => job?.name === "merge-ready") : [];
    if (matches.length !== 1 || matches[0].run_id !== reused.runId
      || matches[0].head_sha !== reused.sourceHead || matches[0].status !== "completed"
      || matches[0].conclusion !== "success") {
      failures.push("Reused pull-request certification lacks exact successful merge-ready evidence.");
    }
  }
  return failures;
}
