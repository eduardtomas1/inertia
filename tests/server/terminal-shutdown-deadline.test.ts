import { describe, expect, it } from "vitest";
import { terminalShutdownTimeoutMs } from "../../src/server/terminal-shutdown-deadline";

describe("terminal shutdown deadline", () => {
  it("preserves platform-specific bounded cleanup headroom", () => {
    expect(terminalShutdownTimeoutMs("linux")).toBe(1_000);
    expect(terminalShutdownTimeoutMs("darwin")).toBe(5_000);
    expect(terminalShutdownTimeoutMs("win32")).toBe(3_000);
  });
});
