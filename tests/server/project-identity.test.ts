import { describe, expect, it } from "vitest";

import { normalizeIdentityPath } from "../../src/server/project-identity";

describe("project identity paths", () => {
  it("normalizes Windows drive casing, separators, spaces, and Unicode deterministically", () => {
    expect(normalizeIdentityPath("C:\\Users\\Twin Dev\\Código\\", "win32")).toBe("c:/users/twin dev/código");
    expect(normalizeIdentityPath("c:/USERS/Twin Dev/Código", "win32")).toBe("c:/users/twin dev/código");
  });

  it("normalizes POSIX separators without case-folding case-sensitive paths", () => {
    expect(normalizeIdentityPath("/Work//Repo/", "linux")).toBe("/Work/Repo");
    expect(normalizeIdentityPath("/work/repo", "linux")).not.toBe(normalizeIdentityPath("/Work/Repo", "linux"));
  });
});
