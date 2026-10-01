import { describe, expect, it } from "vitest";
import { projectToolEnvironmentToken } from "../../src/main/project-tool-environment";
import { projectToolTokenReference } from "../../src/shared/project-tools";

describe("privileged project tool environment lookup", () => {
  it("resolves only explicitly opted-in variables and respects cancellation", () => {
    const environment = { INERTIA_MCP_DOCS: "synthetic-test-value", ANTHROPIC_API_KEY: "synthetic-unrelated-value" };
    expect(projectToolEnvironmentToken(projectToolTokenReference("INERTIA_MCP_DOCS"), environment)).toBe("synthetic-test-value");
    expect(projectToolEnvironmentToken("secret:project-tool-env:ANTHROPIC_API_KEY", environment)).toBeNull();
    expect(projectToolEnvironmentToken("secret:project-tool-env:INERTIA_MCP_ABSENT", environment)).toBeNull();
    expect(projectToolEnvironmentToken(projectToolTokenReference("INERTIA_MCP_DOCS"), environment, AbortSignal.abort())).toBeNull();
    expect(() => projectToolTokenReference("ANTHROPIC_API_KEY")).toThrow();
  });
  it("refuses multiline, empty and oversized values", () => {
    for (const value of ["", "x", "synthetic\nheader", "synthetic\rheader", "synthetic\0header", "x".repeat(8193)]) {
      expect(projectToolEnvironmentToken(projectToolTokenReference("INERTIA_MCP_DOCS"), { INERTIA_MCP_DOCS: value })).toBeNull();
    }
  });
});
