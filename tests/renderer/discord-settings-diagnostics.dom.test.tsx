import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DiscordSettings } from "../../src/renderer/src/components/DiscordSettings";
import { DISCORD_RELEASE_WEBHOOK_PROFILE_ID } from "../../src/shared/backend-credentials";

afterEach(() => { Reflect.deleteProperty(window, "inertia"); });

function setup(incidentId: string | null, capture: boolean) {
  const queryDiagnostics = vi.fn(async () => ({ capture }));
  Object.defineProperty(window, "inertia", { configurable: true, value: {
    getBackendCredentialState: vi.fn(async () => ({ profileId: DISCORD_RELEASE_WEBHOOK_PROFILE_ID, hasSecret: true,
      storage: { available: true, provider: "keychain", message: "" } })),
    reportValidationDiagnostic: vi.fn(async () => incidentId ? { incidentId } : null),
    queryDiagnostics,
  } });
  render(<DiscordSettings disabled={false} repositoryUrl="" onUpdate={vi.fn()} />);
  return { queryDiagnostics };
}

async function post(): Promise<void> {
  await act(async () => { await Promise.resolve(); });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Post release to Discord…" })));
  await act(async () => { await Promise.resolve(); });
}

it("says capture was off when a failure produced no diagnostics record", async () => {
  setup(null, false);
  await post();
  expect(screen.getByText("Add a release repository URL before posting.")).toBeVisible();
  expect(screen.getByText("Diagnostics capture is off, so this was not recorded.")).toBeVisible();
  expect(screen.queryByRole("button", { name: "View diagnostics" })).toBeNull();
});

it("links the recorded failure and stays quiet about capture while it is on", async () => {
  setup("00000000-0000-4000-8000-000000000001", true);
  await post();
  expect(screen.getByRole("button", { name: "View diagnostics" })).toBeVisible();
  expect(screen.queryByText(/capture is off/u)).toBeNull();
});
