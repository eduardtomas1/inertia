import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type {
  ProviderMaintenanceOperation,
} from "../../src/shared/provider-maintenance";
import {
  providerMaintenanceOperationMap,
} from "../../src/renderer/src/utils/providerMaintenance";

const hookSource = readFileSync(
  new URL("../../src/renderer/src/hooks/useProviderMaintenance.ts", import.meta.url),
  "utf8",
);
const appSource = readFileSync(
  new URL("../../src/renderer/src/App.tsx", import.meta.url),
  "utf8",
);
const sceneModelSource = readFileSync(
  new URL(
    "../../src/renderer/src/components/workspace-scene/createWorkspaceSceneModel.ts",
    import.meta.url,
  ),
  "utf8",
);

describe("provider maintenance renderer projection", () => {
  it("consumes full synchronization and the two authoritative runtime events", () => {
    expect(hookSource).toContain(
      "snapshot?.maintenanceOperations",
    );
    expect(hookSource).toContain(
      'event.type === "server.welcome"',
    );
    expect(hookSource).toContain(
      "event.snapshot.maintenanceOperations",
    );
    expect(hookSource).toContain(
      'event.type === "provider.maintenance.updated"',
    );
    expect(hookSource).toContain(
      'event.type === "provider.maintenance.operation"',
    );
    expect(hookSource).not.toContain("setInterval");
    expect(hookSource).not.toContain("setTimeout");
  });

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

  it("uses only the selected conversation provider for the composer notice", () => {
    expect(appSource).toContain(
      "providerMaintenance.statuses.get(selectedMaintenanceProviderId)",
    );
    expect(sceneModelSource).toContain(
      "maintenanceStatus: selectedMaintenanceStatus",
    );
    expect(appSource).not.toMatch(
      /setActionError\([^)]*provider\.maintenance/su,
    );
  });

  it("does not start a duplicate maintenance refresh from provider refresh", () => {
    expect(sceneModelSource).toContain(
      "onRefreshProvider: (providerId) => {\n"
      + "        actions.refreshProvider(providerId);\n"
      + "      },\n"
      + "      onRefreshProviderMaintenance:",
    );
  });
});
