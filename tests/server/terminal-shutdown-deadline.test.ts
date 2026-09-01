import { describe, expect, it } from "vitest";
import { runtimeShutdownDeadlineMs } from "../../src/node/runtime-shutdown-deadline";
import {
  terminalCloseTimeoutMs,
  terminalShutdownTimeoutMs,
} from "../../src/server/terminal-shutdown-deadline";

describe("terminal shutdown deadline", () => {
  it("preserves platform-specific bounded cleanup headroom", () => {
    expect(terminalShutdownTimeoutMs("linux")).toBe(1_000);
    expect(terminalShutdownTimeoutMs("darwin")).toBe(5_000);
    expect(terminalShutdownTimeoutMs("win32")).toBe(3_000);
  });

  it("includes bounded process admission in ordinary close headroom", () => {
    expect(terminalCloseTimeoutMs("linux")).toBe(9_500);
    expect(terminalCloseTimeoutMs("darwin")).toBe(12_750);
    expect(terminalCloseTimeoutMs("win32")).toBe(5_500);
  });

  it("keeps the Linux terminal close inside the authoritative runtime deadline", () => {
    expect(runtimeShutdownDeadlineMs("linux")).toBe(
      terminalCloseTimeoutMs("linux") + 2_500,
    );
  });
});
