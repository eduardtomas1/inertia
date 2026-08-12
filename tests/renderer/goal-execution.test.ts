import { describe, expect, it } from "vitest";

import {
  goalControlsBusy,
} from "../../src/renderer/src/utils/goalExecution";

describe("goal execution controls", () => {
  it.each(["connecting", "offline"] as const)(
    "keeps mutations disabled while the runtime is %s",
    (connectionStatus) => {
      expect(goalControlsBusy({
        connectionStatus,
        workflowLoading: false,
        safetyLocked: false,
        executionStatus: "idle",
        busyAction: null,
      })).toBe(true);
    },
  );

  it("keeps mutations disabled until Stop finishes provider cleanup", () => {
    expect(goalControlsBusy({
      connectionStatus: "online",
      workflowLoading: false,
      safetyLocked: false,
      executionStatus: "idle",
      busyAction: "agent.stop",
    })).toBe(true);
  });
});
