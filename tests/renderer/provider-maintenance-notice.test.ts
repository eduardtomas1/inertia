import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  ProviderMaintenanceNotice,
  shouldShowProviderMaintenanceNotice,
} from "../../src/renderer/src/components/ProviderMaintenanceNotice";
import type {
  ProviderMaintenanceOperation,
  ProviderMaintenanceStatus,
} from "../../src/shared/contracts";

const actions = {
  onRefresh: async () => undefined,
  onUpdate: async () => undefined,
  onCancel: async () => undefined,
  onOpenInstructions: () => undefined,
};

function status(
  update: Partial<ProviderMaintenanceStatus> = {},
): ProviderMaintenanceStatus {
  return {
    providerId: "codex",
    installedVersion: "1.2.3",
    latestVersion: "1.3.0",
    versionStatus: "update-available",
    freshness: "fresh",
    checkedAt: "2026-07-27T12:00:00.000Z",
    installMethod: "npm-global",
    updateAvailability: "available",
    updateLabel: "Update Codex",
    instructionsUrl: "https://developers.openai.com/codex",
    message: null,
    ...update,
  };
}

function operation(
  update: Partial<ProviderMaintenanceOperation> = {},
): ProviderMaintenanceOperation {
  return {
    id: "b2dd9572-a7dd-4f52-a67f-7fb9dcb8f504",
    providerId: "codex",
    status: "running",
    startedAt: "2026-07-27T12:01:00.000Z",
    finishedAt: null,
    beforeVersion: "1.2.3",
    afterVersion: null,
    targetVersion: "1.3.0",
    message: "Updating Codex safely.",
    output: "SECRET=/private/path npm install --global package",
    outputTruncated: false,
    ...update,
  };
}

function render(
  maintenanceStatus: ProviderMaintenanceStatus | null,
  maintenanceOperation: ProviderMaintenanceOperation | null = null,
): string {
  return renderToStaticMarkup(createElement(ProviderMaintenanceNotice, {
    providerLabel: "Codex",
    status: maintenanceStatus,
    operation: maintenanceOperation,
    ...actions,
  }));
}

describe("provider maintenance notice", () => {
  it("shows one quiet provider-specific Update action only when the backend allows it", () => {
    const html = render(status());

    expect(html).toContain("Codex update available");
    expect(html).toContain(">Update</button>");
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("Dismiss Codex update notice");
    expect(html).not.toContain("Instructions");
  });

  it("routes instructions-only advisories to official instructions without pretending to update", () => {
    const html = render(status({
      updateAvailability: "instructions-only",
    }));

    expect(html).toContain(">Instructions</button>");
    expect(html).not.toContain(">Update</button>");
  });

  it("renders bounded operation state without exposing output, argv, or paths", () => {
    const running = render(status(), operation());
    const failed = render(status(), operation({
      status: "failed",
      finishedAt: "2026-07-27T12:02:00.000Z",
      message: "The provider update failed.",
    }));

    expect(running).toContain("Updating");
    expect(running).toContain('aria-busy="true"');
    expect(running).toContain(">Cancel</button>");
    expect(running).not.toContain("SECRET");
    expect(running).not.toContain("/private/path");
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("The provider update failed.");
    expect(failed).not.toContain("npm install");
  });

  it("stays absent when the provider is current and no operation needs attention", () => {
    expect(render(status({
      latestVersion: "1.2.3",
      versionStatus: "current",
      updateAvailability: "unavailable",
    }))).toBe("");
  });

  it("offers a provider-managed action when version discovery is unavailable", () => {
    const cursorStatus = status({
      providerId: "cursor",
      installedVersion: null,
      latestVersion: null,
      versionStatus: "unknown",
      freshness: "unavailable",
      installMethod: "provider-managed",
      updateAvailability: "available",
      updateLabel: "Update Cursor",
      message: "Cursor does not publish a machine-readable latest version.",
    });
    const composerHtml = render(cursorStatus);
    const settingsHtml = renderToStaticMarkup(createElement(
      ProviderMaintenanceNotice,
      {
        providerLabel: "Cursor",
        status: cursorStatus,
        operation: null,
        showManagedUpdateAction: true,
        dismissible: false,
        ...actions,
      },
    ));

    expect(composerHtml).toBe("");
    expect(settingsHtml).toContain("Cursor maintenance");
    expect(settingsHtml).toContain("Check &amp; update");
    expect(settingsHtml).toContain(
      "Cursor does not publish a machine-readable latest version.",
    );
    expect(settingsHtml).not.toContain("Cursor update available");
    expect(settingsHtml).not.toContain("Latest");
  });

  it("lets a new update supersede a dismissed terminal operation", () => {
    const completed = operation({
      status: "succeeded",
      finishedAt: "2026-07-27T12:02:00.000Z",
      afterVersion: "1.3.0",
      message: "Provider updated.",
    });
    const values = new Map<string, string>([
      [
        "inertia:provider-maintenance-operations-dismissed:v1",
        JSON.stringify([completed.id]),
      ],
    ]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };
    vi.stubGlobal("window", {
      localStorage: storage,
      sessionStorage: storage,
    });
    try {
      const html = render(status({
        installedVersion: "1.3.0",
        latestVersion: "1.4.0",
        versionStatus: "update-available",
      }), completed);

      expect(html).toContain("Codex update available");
      expect(html).toContain(">Update</button>");
      expect(html).not.toContain("Updated to 1.3.0");
      expect(html).not.toContain("Provider updated.");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps settings actions visible when the composer update was dismissed", () => {
    const values = new Map<string, string>([
      [
        "inertia:provider-updates-dismissed:v1",
        JSON.stringify({ codex: "1.3.0" }),
      ],
    ]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };
    vi.stubGlobal("window", {
      localStorage: storage,
      sessionStorage: storage,
    });
    try {
      expect(render(status())).toBe("");
      const settingsHtml = renderToStaticMarkup(createElement(
        ProviderMaintenanceNotice,
        {
          providerLabel: "Codex",
          status: status(),
          operation: null,
          dismissible: false,
          ...actions,
        },
      ));
      expect(settingsHtml).toContain("Codex update available");
      expect(settingsHtml).toContain(">Update</button>");
      expect(settingsHtml).not.toContain("Dismiss Codex update notice");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("removes a dismissed terminal operation from the composer notice", () => {
    const completed = operation({
      status: "succeeded",
      finishedAt: "2026-07-27T12:02:00.000Z",
      afterVersion: "1.3.0",
    });

    expect(shouldShowProviderMaintenanceNotice({
      operation: completed,
      updateAvailable: false,
      updateDismissed: false,
      operationDismissed: false,
    })).toBe(true);
    expect(shouldShowProviderMaintenanceNotice({
      operation: completed,
      updateAvailable: false,
      updateDismissed: false,
      operationDismissed: true,
    })).toBe(false);
    expect(shouldShowProviderMaintenanceNotice({
      operation: completed,
      updateAvailable: true,
      updateDismissed: false,
      operationDismissed: true,
    })).toBe(true);
    expect(shouldShowProviderMaintenanceNotice({
      operation: completed,
      updateAvailable: true,
      updateDismissed: true,
      operationDismissed: true,
    })).toBe(false);
    expect(shouldShowProviderMaintenanceNotice({
      operation: operation(),
      updateAvailable: true,
      updateDismissed: true,
      operationDismissed: true,
    })).toBe(true);
  });
});
