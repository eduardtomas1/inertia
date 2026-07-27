import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const hookSource = readFileSync(
  new URL("../../src/renderer/src/hooks/useProviderMaintenance.ts", import.meta.url),
  "utf8",
);
const appSource = readFileSync(
  new URL("../../src/renderer/src/App.tsx", import.meta.url),
  "utf8",
);

describe("provider maintenance renderer projection", () => {
  it("consumes cached snapshot state and the two authoritative runtime events", () => {
    expect(hookSource).toContain("maintenance ? [[maintenance.providerId, maintenance]");
    expect(hookSource).toContain(
      'event.type === "provider.maintenance.updated"',
    );
    expect(hookSource).toContain(
      'event.type === "provider.maintenance.operation"',
    );
    expect(hookSource).not.toContain("setInterval");
    expect(hookSource).not.toContain("setTimeout");
  });

  it("uses only the selected conversation provider for the composer notice", () => {
    expect(appSource).toContain(
      "providerMaintenance.statuses.get(selectedMaintenanceProviderId)",
    );
    expect(appSource).toContain(
      "maintenanceStatus={selectedMaintenanceStatus}",
    );
    expect(appSource).not.toMatch(
      /setActionError\([^)]*provider\.maintenance/su,
    );
  });
});
