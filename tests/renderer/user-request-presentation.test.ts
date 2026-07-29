import { describe, expect, it } from "vitest";

import {
  collapsedUserRequestPreview,
  shouldCollapseUserRequest,
} from "../../src/renderer/src/utils/userRequestPresentation";

describe("long user request presentation", () => {
  it("keeps ordinary requests complete", () => {
    const content = "Please inspect this file and fix the failing test.";
    expect(shouldCollapseUserRequest(content)).toBe(false);
    expect(collapsedUserRequestPreview(content)).toBe(content);
  });

  it("bounds pasted specifications without losing their persisted content", () => {
    const content = Array.from(
      { length: 40 },
      (_, index) => `Requirement ${index + 1}: preserve authoritative ordering.`,
    ).join("\n");
    const preview = collapsedUserRequestPreview(content);

    expect(shouldCollapseUserRequest(content)).toBe(true);
    expect(preview.length).toBeLessThan(content.length);
    expect(preview).toMatch(/…$/u);
    expect(content).toContain("Requirement 40");
    expect(preview).not.toContain("Requirement 40");
  });
});
