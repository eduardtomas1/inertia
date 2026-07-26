import { describe, expect, it } from "vitest";

import {
  assembleReadOnlyReviewRequest,
} from "../../src/server";

describe("diff review workflow", () => {
  it("keeps Ask's actual question visible and sends diff/control content only to the provider", () => {
    const request = assembleReadOnlyReviewRequest(
      process.cwd(),
      "Could this introduce a race?",
      {
        diffSelections: [{
          path: "src/race.ts",
          hunkHeader: "@@ -1 +1 @@",
          content: "+await coordinate();",
          selectedLineCount: 1,
        }],
      },
    );

    expect(request.visibleContent).toBe("Could this introduce a race?");
    expect(request.visibleContent).not.toContain("+await coordinate();");
    expect(request.executionPrompt).toContain("Could this introduce a race?");
    expect(request.executionPrompt).toContain("+await coordinate();");
    expect(request.executionPrompt).toContain("Do not modify files");
    expect(JSON.stringify(request.persistence.manifest)).not.toContain("Do not modify files");
  });
});
