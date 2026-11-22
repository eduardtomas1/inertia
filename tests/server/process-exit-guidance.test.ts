import { describe, expect, it } from "vitest";

import {
  providerProcessExitGuidance,
  providerProcessExitStatus,
} from "../../src/server/provider/process-exit-guidance";

describe("provider process exit guidance", () => {
  it("recognises EPERM output without repeating it", () => {
    for (const output of ["EPERM: operation not permitted, open '/Users/me/Desktop/a'", "Operation not permitted (os error 1)"]) {
      const guidance = providerProcessExitGuidance(output);
      expect(guidance).toMatch(/^It was denied access to a file or folder \(EPERM\)\. On macOS, allow Inertia /u);
      expect(guidance).not.toContain("/Users/me");
    }
    for (const output of ["", "operation not permitted", "NOT_EPERMITTED", undefined, 42]) {
      expect(providerProcessExitGuidance(output)).toBe("Check the details for the provider's output, then retry the turn.");
    }
  });

  it("names only a well-formed exit code or signal", () => {
    expect(providerProcessExitStatus(1, null)).toBe(" with code 1");
    expect(providerProcessExitStatus(null, "SIGKILL")).toBe(" after signal SIGKILL");
    expect(providerProcessExitStatus(1, "SIGTERM")).toBe(" after signal SIGTERM");
    expect(providerProcessExitStatus(1.5, null)).toBe("");
    expect(providerProcessExitStatus(null, "SIGKILL; rm -rf /")).toBe("");
    expect(providerProcessExitStatus(null, null)).toBe("");
  });
});
