import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const record = (value) => value && typeof value === "object" && !Array.isArray(value);

// Actionlint 1.7.7 (and current upstream 1.7.12) predates this GitHub key.
// Keep its other concurrency checks; validate the one unsupported key here.
export function validateWorkflowConcurrencyQueue(workflow) {
  const sections = [["workflow", workflow?.concurrency]];
  if (record(workflow?.jobs)) {
    for (const [name, job] of Object.entries(workflow.jobs)) sections.push([`job ${name}`, job?.concurrency]);
  }
  for (const [name, concurrency] of sections) {
    if (!record(concurrency) || !Object.hasOwn(concurrency, "queue")) continue;
    if (!["single", "max"].includes(concurrency.queue)) {
      throw new Error(`${name}: concurrency.queue must be the literal single or max.`);
    }
    if (concurrency.queue === "max" && concurrency["cancel-in-progress"] !== undefined
      && concurrency["cancel-in-progress"] !== false) {
      throw new Error(`${name}: queue max requires cancel-in-progress to be false or absent.`);
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const name of readdirSync(".github/workflows").filter((name) => /\.ya?ml$/u.test(name))) {
    try {
      validateWorkflowConcurrencyQueue(parse(readFileSync(`.github/workflows/${name}`, "utf8")));
    } catch (error) {
      throw new Error(`${name}: ${error.message}`);
    }
  }
  console.log("Workflow concurrency queue declarations are valid.");
}
