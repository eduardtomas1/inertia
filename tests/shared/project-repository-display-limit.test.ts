import { describe, expect, it } from "vitest";

import { clientCommandSchema } from "../../src/shared/contracts";
import {
  PROJECT_REPOSITORY_DISPLAY_LIMITS,
  projectRepositoryLimitChoices,
} from "../../src/shared/project-repository-limit";

describe("project repository display limit", () => {
  it("offers the sidebar's two choices", () => {
    expect(PROJECT_REPOSITORY_DISPLAY_LIMITS).toEqual([16, 32]);
  });

  it("offers the stored limit itself when it is not one of the two choices", () => {
    expect(projectRepositoryLimitChoices(16)).toEqual([16, 32]);
    expect(projectRepositoryLimitChoices(32)).toEqual([16, 32]);
    expect(projectRepositoryLimitChoices(24)).toEqual([16, 24, 32]);
    expect(projectRepositoryLimitChoices(1_024)).toEqual([16, 32, 1_024]);
  });

  it("accepts every offered choice at the command boundary", () => {
    for (const gitRepositoryLimit of PROJECT_REPOSITORY_DISPLAY_LIMITS) {
      expect(clientCommandSchema.safeParse({
        type: "project.update",
        requestId: "11111111-1111-4111-8111-111111111111",
        payload: { projectId: "22222222-2222-4222-8222-222222222222", gitRepositoryLimit },
      }).success).toBe(true);
    }
  });
});
