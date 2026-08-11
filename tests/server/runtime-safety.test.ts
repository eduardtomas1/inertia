import { describe, expect, it } from "vitest";

import { RUNTIME_COMMAND_TYPES } from "../../src/server/runtime/commands/command-router";
import {
  RUNTIME_SAFETY_READ_COMMAND_TYPES,
  runtimeSafetyAllowsCommand,
} from "../../src/server/runtime/commands/runtime-safety";

describe("runtime recovery safety command boundary", () => {
  it("defaults every command except exact conversation detail reads to denied", () => {
    const allowed = RUNTIME_COMMAND_TYPES.filter(runtimeSafetyAllowsCommand);
    expect(allowed).toEqual([...RUNTIME_SAFETY_READ_COMMAND_TYPES]);
    expect(RUNTIME_COMMAND_TYPES).toHaveLength(
      RUNTIME_COMMAND_TYPES.filter((type) => !runtimeSafetyAllowsCommand(type))
        .length + RUNTIME_SAFETY_READ_COMMAND_TYPES.length,
    );
  });
});
