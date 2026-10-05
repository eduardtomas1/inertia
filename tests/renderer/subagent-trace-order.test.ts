import { describe, expect, it } from "vitest";

import {
  compareSubagentTraces,
  mergeProjectionRecords,
} from "../../src/renderer/src/utils/terminalTurnProjection";
import { taskTrace } from "./background-task-fixtures";

describe("delegated task order", () => {
  it("keeps tasks created in the same millisecond in place when telemetry bumps their sequence", () => {
    const first = taskTrace({ id: "a", sequence: 1 });
    const second = taskTrace({ id: "b", sequence: 2 });
    expect(mergeProjectionRecords([first, second], [], compareSubagentTraces).map(({ id }) => id))
      .toEqual(["a", "b"]);
    expect(mergeProjectionRecords(
      [first, second],
      [{ ...first, sequence: 3 }],
      compareSubagentTraces,
    ).map(({ id }) => id)).toEqual(["a", "b"]);
  });

  it("orders by creation time first", () => {
    const later = taskTrace({ id: "a", createdAt: "2030-01-01T00:00:02.000Z" });
    const earlier = taskTrace({ id: "b", createdAt: "2030-01-01T00:00:01.000Z" });
    expect([later, earlier].sort(compareSubagentTraces).map(({ id }) => id)).toEqual(["b", "a"]);
  });
});
