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
  "windows-unit": "Windows unit shards",
});

export function createEvidencePlan({
  head, sourceHead = head, base = null, baselineReason = "comparison-base",
  event = "pull_request", draft = false, paths = [],
}) {
  if (!/^[0-9a-f]{40}$/u.test(head) || !/^[0-9a-f]{40}$/u.test(sourceHead)) {
    throw new Error("CI requires the exact tested and source commit identities.");
  }
  if (!base || !/^[0-9a-f]{40}$/u.test(base)) base = null;
  const changes = classifyChangedPaths(base ? paths : []);
  const lane = event === "schedule" ? "nightly"
    : event === "push" ? "main"
      : event === "merge_group" ? "merge"
        : event === "pull_request" ? (draft ? "draft" : "merge") : "unknown";
  const full = lane !== "draft"
    && (changes.fullCertification || lane === "nightly" || lane === "unknown");
  const domains = new Set(changes.domains);
  const selectedPlatforms = full ? PLATFORMS : lane === "draft" ? []
    : PLATFORMS.filter(({ artifact }) => (
      (domains.has("linux_appimage") && artifact.startsWith("linux-"))
      || (domains.has("windows_packaging") && artifact.startsWith("windows-"))
      || (domains.has("macos_packaging") && artifact.startsWith("macos-"))
    ));
  const platforms = selectedPlatforms.map(({ artifact }) => artifact);
  const code = !changes.documentationOnly || full;
  const provider = domains.has("provider_common");
  const critical = !full && code;
  const jobs = {
    gate: true,
    lineage: true,
    "node-22-minimum": full || domains.has("ci_test_infrastructure"),
    "pr-linux-core": code && !platforms.includes("linux-x64"),
    "pr-linux-lifecycle": critical && !platforms.includes("linux-x64")
      && (provider || domains.has("renderer_ui") || lane === "draft"),
    "pr-windows-lifecycle": critical && provider && !platforms.includes("windows-x64"),
    "pr-macos-lifecycle": critical && provider && !platforms.includes("macos-arm64"),
    test: platforms.length > 0,
    "windows-unit": platforms.includes("windows-x64"),
  };
  const requiredJobs = Object.keys(jobs).filter((job) => jobs[job]);
  const requiredChecks = requiredJobs.flatMap((job) => job === "test"
    ? selectedPlatforms.map(({ label }) => label)
    : job === "windows-unit"
      ? [1, 2, 3, 4].map((shard) => `Windows unit tests (${shard}/4)`)
      : [EVIDENCE_JOBS[job]]);
  return {
    schemaVersion: 1, head, sourceHead, base, baselineReason, event, lane,
    paths: [...paths], domains: changes.domains,
    reasons: [baselineReason, ...changes.reasons,
      changes.documentationOnly ? "documentation-only" : full ? "full-native-contract"
        : "affected-contracts-without-unrelated-installers"],
    fullCertification: full, requiredJobs, requiredChecks, platforms,
    omittedPlatforms: PLATFORMS.filter(({ artifact }) => !platforms.includes(artifact))
      .map(({ artifact }) => ({ platform: artifact, reason: "no-installer-obligation-in-this-lane" })),
    suites: ["shared-quality", "migration-lineage",
      ...(code ? ["linux-all-source-coverage", "portable-provider-contracts"] : []),
      ...(jobs["pr-linux-lifecycle"] ? [domains.has("renderer_ui") ? "linux-full-electron" : "linux-core-bridge", "linux-recovery"] : []),
      ...(jobs["pr-windows-lifecycle"] ? ["windows-portable-and-lifecycle", "windows-codex-discovery"] : []),
      ...(jobs["pr-macos-lifecycle"] ? ["macos-portable-and-lifecycle"] : []),
      ...platforms.map((platform) => `${platform}:native-units-electron-package-smoke`),
      ...platforms.filter((platform) => platform.startsWith("windows-"))
        .map((platform) => `${platform}:published-N-1-installed-upgrade`)],
    matrix: { include: selectedPlatforms },
    renderer: critical && domains.has("renderer_ui"),
    benchmarks: lane === "nightly" || (lane !== "draft" && domains.has("performance")),
    omissions: Object.keys(jobs).filter((job) => !jobs[job]).map((job) => ({
      job, reason: full ? "covered-by-full-native-matrix"
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
    full_certification: plan.fullCertification,
    renderer: plan.renderer,
    benchmarks: plan.benchmarks,
  };
  for (const job of Object.keys(EVIDENCE_JOBS)) {
    outputs[job.replaceAll("-", "_")] = plan.requiredJobs.includes(job);
  }
  return Object.entries(outputs).map(([key, value]) => `${key}=${value}`).join("\n") + "\n";
}

// Missing evidence is never equivalent to an intentionally omitted job. The
// REST records additionally prove every matrix member, which `needs.test`
// alone cannot enumerate. Evidence comes only from this run, not PR artifacts.
export function evaluateMergeEvidence(plan, { head, sourceHead, event, draft, runId, needs, jobs }) {
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
  return failures;
}
