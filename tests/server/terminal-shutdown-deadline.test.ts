import { describe, expect, it } from "vitest";
import { runtimeShutdownDeadlineMs } from "../../src/node/runtime-shutdown-deadline";
import { terminalCloseTimeoutMs } from "../../src/server/terminal-shutdown-deadline";

describe("terminal shutdown deadline", () => {
  it("keeps the Linux terminal close inside the authoritative runtime deadline", () => {
    expect(runtimeShutdownDeadlineMs("linux")).toBe(
      terminalCloseTimeoutMs("linux") + 2_500,
    );
  });
});
