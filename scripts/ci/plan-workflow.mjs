import { appendFile } from "node:fs/promises";
import { compareEvidencePlans, createEvidencePlan, outputsForEvidencePlan } from "./evidence-plan.mjs";
import { boundedGit, comparisonPaths, resolveMainBaseline } from "./validation-baseline.mjs";

const head = process.env.GITHUB_SHA;
if (boundedGit(["rev-parse", "HEAD"])?.trim() !== head) {
  throw new Error("The checked-out source is not the workflow candidate.");
}
const event = process.env.GITHUB_EVENT_NAME;
let base = /^[0-9a-f]{40}$/u.test(process.env.BASE_SHA ?? "") ? process.env.BASE_SHA : null;
let baselineReason = "event-comparison-base";
let baselineObservation;
if (event === "push") {
  const baseline = await resolveMainBaseline({
    head, repository: process.env.GITHUB_REPOSITORY, runId: Number(process.env.GITHUB_RUN_ID),
    rendererDomShadow: process.env.INERTIA_CI_BASELINE_SHADOW === "true",
  });
  base = baseline.base;
  baselineReason = baseline.reason;
  baselineObservation = baseline;
} else if (base) {
  // A PR diff is against its merge base, while the tested candidate is the
  // actual GitHub merge commit. Never describe PR-head-only tests as this SHA.
  base = boundedGit(["merge-base", base, head])?.trim() || null;
}
const paths = base ? comparisonPaths(base, head) : null;
if (paths === null) {
  base = null;
  baselineReason = `${baselineReason}:comparison-unavailable`;
}
const plan = createEvidencePlan({
  head, sourceHead: process.env.SOURCE_HEAD || head, base, baselineReason,
  event, draft: process.env.PR_DRAFT === "true", paths: paths ?? [],
});
if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, outputsForEvidencePlan(plan), "utf8");
}
const report = JSON.stringify(plan, null, 2);
process.stdout.write(`${report}\n`);
if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(process.env.GITHUB_STEP_SUMMARY, `## ${plan.lane} evidence plan\n\n\`\`\`json\n${report}\n\`\`\`\n`);
}
if (baselineObservation) {
  const shadow = baselineObservation.shadow;
  const shadowPaths = shadow?.base ? comparisonPaths(shadow.base, head) : null;
  const shadowPlan = shadowPaths === null ? null : createEvidencePlan({
    head, sourceHead: plan.sourceHead, base: shadow.base, baselineReason: shadow.reason,
    event, draft: process.env.PR_DRAFT === "true", paths: shadowPaths,
  });
  const observation = JSON.stringify({
    schemaVersion: 1, head, sourceHead: plan.sourceHead,
    policy: "strict-contract", proposedPolicy: shadow ? "existing-renderer-dom-content-only" : null,
    ...baselineObservation,
    comparison: shadowPlan ? compareEvidencePlans(plan, shadowPlan) : null,
  }, null, 2);
  process.stdout.write(`Baseline diagnostics (optional shadow has no scheduling authority):\n${observation}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY,
      `## Baseline diagnostics\n\nThe strict plan above selects all executed checks.\n\n\`\`\`json\n${observation}\n\`\`\`\n`);
  }
}
