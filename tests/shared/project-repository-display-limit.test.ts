import { describe, expect, it } from "vitest";

import { clientCommandSchema } from "../../src/shared/contracts";
import {
  PROJECT_REPOSITORY_DISPLAY_LIMITS,
  projectRepositoryDisplayLimit,
} from "../../src/shared/project-repository-limit";

describe("project repository display limit", () => {
  it("offers the sidebar's two choices", () => {
    expect(PROJECT_REPOSITORY_DISPLAY_LIMITS).toEqual([16, 32]);
  });

  it("maps every stored limit to one offered choice", () => {
    expect(projectRepositoryDisplayLimit(16)).toBe(16);
    expect(projectRepositoryDisplayLimit(31)).toBe(16);
    expect(projectRepositoryDisplayLimit(32)).toBe(32);
    expect(projectRepositoryDisplayLimit(128)).toBe(32);
    expect(projectRepositoryDisplayLimit(1_024)).toBe(32);
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
