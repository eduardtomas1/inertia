import { appendFile } from "node:fs/promises";
import { evaluateMergeEvidence } from "./evidence-plan.mjs";
import { boundedGit, currentRunJobs } from "./validation-baseline.mjs";

const head = process.env.GITHUB_SHA;
if (boundedGit(["rev-parse", "HEAD"])?.trim() !== head) throw new Error("Gate checkout identity mismatch.");
const runId = Number(process.env.GITHUB_RUN_ID);
const event = process.env.GITHUB_EVENT_NAME;
if (event === "pull_request"
  && (!["true", "false"].includes(process.env.PR_DRAFT) || !process.env.SOURCE_HEAD)) {
  throw new Error("The actual pull-request identity/draft context is missing.");
}
const plan = JSON.parse(process.env.PLAN_JSON || "null");
const failures = evaluateMergeEvidence(plan, {
  head, sourceHead: process.env.SOURCE_HEAD || head, event,
  draft: process.env.PR_DRAFT === "true", runId,
  needs: JSON.parse(process.env.NEEDS_JSON || "{}"),
  jobs: currentRunJobs(process.env.GITHUB_REPOSITORY, runId),
});
const report = failures.length ? failures.join("\n")
  : `All required evidence succeeded for ${head}; omissions are recorded in the ${plan.lane} plan.`;
process.stdout.write(`${report}\n`);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
if (failures.length) process.exitCode = 1;
