import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ProviderMaintenanceNotice } from "../../src/renderer/src/components/ProviderMaintenanceNotice";
import type { ProviderMaintenanceOperation, ProviderMaintenanceStatus } from "../../src/shared/provider-maintenance";

const status: ProviderMaintenanceStatus = {
  providerId: "codex",
  installedVersion: "1.0.0",
  latestVersion: null,
  versionStatus: "unknown",
  freshness: "unavailable",
  checkedAt: null,
  installMethod: "npm-global",
  updateAvailability: "instructions-only",
  updateLabel: null,
  instructionsUrl: "https://github.com/openai/codex#installing-and-running-codex-cli",
  message: "Latest-version check timed out. This Codex installation is not writable by your account.",
  manualCommand: null,
};

describe("Settings provider maintenance", () => {
  it("offers instructions and lets an unavailable check recover after a completed operation", async () => {
    const onRefresh = vi.fn(async () => undefined);
    const onOpenInstructions = vi.fn();
    const props = {
      providerLabel: "Codex",
      status,
      operation: null as ProviderMaintenanceOperation | null,
      showStatus: true,
      dismissible: false,
      onRefresh,
      onOpenInstructions,
      onUpdate: vi.fn(async () => undefined),
      onCancel: vi.fn(async () => undefined),
    };
    const { rerender } = render(<ProviderMaintenanceNotice {...props} />);
    expect(screen.getByText(/not writable by your account/u)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Update" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Instructions" }));
    expect(onOpenInstructions).toHaveBeenCalledWith(status.instructionsUrl);
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    rerender(<ProviderMaintenanceNotice {...props} operation={{
      id: "completed", providerId: "codex", status: "succeeded", startedAt: null,
      finishedAt: "2026-09-28T10:00:00Z", beforeVersion: "0.9.0", afterVersion: "1.0.0",
      targetVersion: "1.0.0", message: "Provider updated.", output: null, outputTruncated: false,
    }} />);
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(2));
    expect(props.onUpdate).not.toHaveBeenCalled();
  });

  it("shows the exact command when Inertia cannot run the update itself", () => {
    const props = {
      providerLabel: "Codex",
      operation: null,
      showStatus: true,
      dismissible: false,
      onRefresh: vi.fn(async () => undefined),
      onOpenInstructions: vi.fn(),
      onUpdate: vi.fn(async () => undefined),
      onCancel: vi.fn(async () => undefined),
    };
    const { rerender } = render(<ProviderMaintenanceNotice {...props} status={{
      ...status,
      message: "Your account cannot write this installation.",
      manualCommand: "sudo npm install -g --prefix /usr @openai/codex@latest",
    }} />);
    expect(screen.getByText(/Your account cannot write this installation\./u)).toBeInTheDocument();
    expect(screen.getByText("sudo npm install -g --prefix /usr @openai/codex@latest").tagName).toBe("CODE");
    expect(screen.queryByRole("button", { name: /Update/u })).not.toBeInTheDocument();

    rerender(<ProviderMaintenanceNotice {...props} status={{
      ...status,
      latestVersion: "1.1.0",
      versionStatus: "update-available",
      updateAvailability: "available",
      message: null,
      manualCommand: "npm install -g --prefix ~/.npm-global @openai/codex@latest",
    }} />);
    expect(screen.getByRole("button", { name: "Update" })).toBeInTheDocument();
    expect(screen.queryByText(/npm install/u)).not.toBeInTheDocument();
  });
});
