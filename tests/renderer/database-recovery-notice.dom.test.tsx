import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DatabaseRecoveryNotice } from "../../src/renderer/src/components/DatabaseRecoveryNotice";

const baseNotice = {
  id: "runtime-1-database-recovery",
  trigger: "primary-corrupt" as const,
  preservedCorruptPrimary: true,
  invalidBackupsSkipped: 1,
  unsupportedBackupsSkipped: 0,
};

describe("DatabaseRecoveryNotice", () => {
  it("prominently reports created-empty data loss and exposes safe recovery actions", async () => {
    const onImportRecovery = vi.fn(async () => undefined);
    const onCopyReport = vi.fn(async () => undefined);
    const onDismiss = vi.fn();
    render(
      <DatabaseRecoveryNotice
        notice={{ ...baseNotice, outcome: "created-empty" }}
        onDismiss={onDismiss}
        onImportRecovery={onImportRecovery}
        onCopyReport={onCopyReport}
      />,
    );

    expect(screen.getByText("Inertia started with empty data")).toBeVisible();
    expect(screen.getByText(/No valid backup was available/u)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Import recovery file/u }));
    await waitFor(() => expect(onImportRecovery).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: /Copy report/u }));
    await waitFor(() => expect(onCopyReport).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", {
      name: "Dismiss database recovery warning",
    }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("distinguishes a successful validated restore from empty-data recovery", () => {
    render(
      <DatabaseRecoveryNotice
        notice={{ ...baseNotice, outcome: "restored" }}
        onDismiss={vi.fn()}
        onImportRecovery={vi.fn(async () => undefined)}
        onCopyReport={vi.fn(async () => undefined)}
      />,
    );

    expect(screen.getByText("Inertia restored a validated backup")).toBeVisible();
    expect(screen.queryByText("Inertia started with empty data")).toBeNull();
  });
});
