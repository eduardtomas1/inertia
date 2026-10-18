import { describe, expect, it } from "vitest";

import { markdownPlanSteps } from "../../src/server/provider/markdown-plan-steps";

const CODEX_PLAN = [
  "# Move the settings module",
  "",
  "## Summary",
  "Move the settings code into its own folder and keep every import working.",
  "",
  "## Key Changes",
  "1. Move `src/settings.ts` to `src/settings/index.ts`.",
  "   - Keep the default export.",
  "   - Re-export the option types.",
  "2. Update every import of `./settings`.",
  "",
  "```diff",
  "- import settings from \"./settings.ts\";",
  "+ import settings from \"./settings\";",
  "```",
  "",
  "## Test Plan",
  "- Run `npm test`.",
  "  * Include the settings dialog tests.",
].join("\n");

describe("markdown plan steps", () => {
  it("takes only the plan's top-level list items as steps", () => {
    expect(markdownPlanSteps(CODEX_PLAN, 1_000)).toEqual([
      { step: "Move `src/settings.ts` to `src/settings/index.ts`.", status: "pending" },
      { step: "Update every import of `./settings`.", status: "pending" },
      { step: "Run `npm test`.", status: "pending" },
    ]);
  });

  it("keeps a code block open until a fence of the same kind and length closes it", () => {
    const plan = [
      "~~~markdown",
      "```",
      "- Not a step inside the example",
      "```",
      "- Still inside the example",
      "~~~",
      "- Add the example to the README.",
      "````",
      "```",
      "- Inside a longer fence",
      "````",
      "- Run the docs check.",
    ].join("\n");
    expect(markdownPlanSteps(plan, 1_000).map(({ step }) => step)).toEqual([
      "Add the example to the README.",
      "Run the docs check.",
    ]);
  });

  it("makes no steps for a plan written as prose", () => {
    expect(markdownPlanSteps("# Plan\n\nRename the module, then update its imports and run the tests.", 1_000)).toEqual([]);
  });

  it("bounds each step's length", () => {
    expect(markdownPlanSteps("- Rename the settings module", 6)).toEqual([{ step: "Rename", status: "pending" }]);
  });
});
