import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { validateWorkflowConcurrencyQueue } from "../../scripts/check-workflow-concurrency.mjs";

describe("supported GitHub concurrency queue declarations", () => {
  it.each([{ queue: "single" }, { queue: "max" }, { queue: "max", "cancel-in-progress": false },
    { queue: "single", "cancel-in-progress": true }, "a-concurrency-group", undefined])("accepts %j", (concurrency) => {
    expect(() => validateWorkflowConcurrencyQueue({ concurrency, jobs: { upload: { concurrency } } })).not.toThrow();
  });

  it.each([{ queue: "all" }, { queue: true }, { queue: 100 }, { queue: null },
    { queue: ["max"] }, { queue: "max", "cancel-in-progress": true },
    { queue: "max", "cancel-in-progress": "${{ github.ref == 'main' }}" }])("rejects %j at either workflow or job scope", (concurrency) => {
    expect(() => validateWorkflowConcurrencyQueue({ concurrency })).toThrow();
    expect(() => validateWorkflowConcurrencyQueue({ jobs: { upload: { concurrency } } })).toThrow();
  });

  it("keeps the exception limited to the unsupported key and runs its replacement check in the quality gate", () => {
    const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
    const lint = workflow.jobs.gate.steps.find((step: { name: string }) => step.name === "Validate workflow syntax and expressions");
    expect(lint.run).toContain('-ignore \'^unexpected key "queue" for "concurrency" section\\. expected one of "cancel-in-progress", "group"$\'');
    const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts;
    expect(scripts["check:quality"]).toContain("npm run check:workflow-concurrency");
    expect(scripts["check:workflow-concurrency"]).toBe("node scripts/check-workflow-concurrency.mjs");
    expect(workflow.jobs.gate.steps.some((step: { run?: string }) => step.run?.includes("npm run check:quality"))).toBe(true);
  });
});
