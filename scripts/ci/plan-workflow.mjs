import { appendFile } from "node:fs/promises";
import { createEvidencePlan, outputsForEvidencePlan } from "./evidence-plan.mjs";
import { boundedGit, comparisonPaths, resolveMainBaseline } from "./validation-baseline.mjs";

const head = process.env.GITHUB_SHA;
if (boundedGit(["rev-parse", "HEAD"])?.trim() !== head) {
  throw new Error("The checked-out source is not the workflow candidate.");
}
const event = process.env.GITHUB_EVENT_NAME;
let base = /^[0-9a-f]{40}$/u.test(process.env.BASE_SHA ?? "") ? process.env.BASE_SHA : null;
let baselineReason = "event-comparison-base";
if (event === "push") {
  const baseline = await resolveMainBaseline({
    head, repository: process.env.GITHUB_REPOSITORY, runId: Number(process.env.GITHUB_RUN_ID),
  });
  base = baseline.base;
  baselineReason = baseline.reason;
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
