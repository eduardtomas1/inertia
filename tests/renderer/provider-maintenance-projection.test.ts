import { describe, expect, it } from "vitest";

import type {
  ProviderMaintenanceOperation,
} from "../../src/shared/provider-maintenance";
import {
  providerMaintenanceOperationMap,
} from "../../src/renderer/src/utils/providerMaintenance";

describe("provider maintenance renderer projection", () => {
  it("restores one latest active operation per provider from a welcome snapshot", () => {
    const operation = (
      id: string,
      providerId: ProviderMaintenanceOperation["providerId"],
      message: string,
    ): ProviderMaintenanceOperation => ({
      id,
      providerId,
      status: "running",
      startedAt: "2026-07-27T10:00:00.000Z",
      finishedAt: null,
      beforeVersion: "1.0.0",
      afterVersion: null,
      targetVersion: "2.0.0",
      message,
      output: null,
      outputTruncated: false,
    });
    const operations = providerMaintenanceOperationMap([
      operation(
        "00000000-0000-4000-8000-000000000001",
        "claude",
        "Earlier",
      ),
      operation(
        "00000000-0000-4000-8000-000000000002",
        "claude",
        "Current",
      ),
      operation(
        "00000000-0000-4000-8000-000000000003",
        "codex",
        "Queued",
      ),
    ]);

    expect(operations.size).toBe(2);
    expect(operations.get("claude")?.message).toBe("Current");
    expect(operations.get("codex")?.id).toBe(
      "00000000-0000-4000-8000-000000000003",
    );
  });
});
