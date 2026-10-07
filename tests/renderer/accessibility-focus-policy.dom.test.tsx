import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ModelChooser } from "../../src/renderer/src/components/ModelChooser";
import { UsageIndicator } from "../../src/renderer/src/components/UsageIndicator";
import type { ComposerModelRoute } from "../../src/renderer/src/utils/modelChooserRoutes";
import {
  continuationIdentityForSelection,
  providerNativeModelSelection,
} from "../../src/shared/model-routing";

afterEach(() => {
  vi.restoreAllMocks();
});

function chooserRoute(): ComposerModelRoute {
  const selection = {
    ...providerNativeModelSelection({
      providerId: "codex",
      modelId: "team-alpha",
      alias: "Team Alpha",
      reasoningEffort: "high",
    }),
    backendProfileId: "custom:team",
    backendProfileDisplayName: "Team gateway",
    backendConfigurationRevision: 5,
  };
  return {
    key: "team-alpha",
    displayName: "Team Alpha",
    modelId: selection.modelId,
    alias: selection.alias,
    harnessId: selection.harnessId,
    harnessLabel: "Codex harness",
    backendProfileId: selection.backendProfileId,
    backendProfileName: selection.backendProfileDisplayName,
    backendConfigurationRevision: 5,
    providerLabel: "Team gateway",
    source: "custom",
    routeTerms: [],
    reasoningEffort: "high",
    reasoningOptions: ["high"],
    selectable: true,
    unavailableReason: null,
    selection,
    continuationIdentity: continuationIdentityForSelection(selection, "opaque-team-route-5", true),
    compatibility: { state: "verified", allowsModelSwitchWithinSession: false },
    rowCompatibility: null,
    providerId: "codex",
    providerReady: true,
  };
}

function renderUsage() {
  return render(<>
    <UsageIndicator usage={null} rateLimits={[]}
      rateLimitState={{ freshness: "unavailable", provenance: null,
        updatedAt: null, lastAttemptedAt: null, refreshing: false }}
      quotaSource="selected-route" mode="expanded" providerLabel="Codex"
      onModeChange={() => undefined} />
    <div data-testid="blank-surface" />
    <button type="button">Outside action</button>
  </>);
}

function renderChooser() {
  const route = chooserRoute();
  return render(<>
    <ModelChooser routes={[route]} selectedRoute={route} onSelect={vi.fn()} />
    <div data-testid="blank-surface" />
    <button type="button">Outside action</button>
  </>);
}

describe("outside-pointer focus policy", () => {
  it("returns model chooser focus to its trigger after a blank outside press", async () => {
    renderChooser();
    const trigger = screen.getByRole("button", { name: /Choose model/u });
    fireEvent.click(trigger);
    const search = screen.getByRole("combobox", { name: "Search models" });
    await waitFor(() => expect(search).toHaveFocus());

    fireEvent.pointerDown(screen.getByTestId("blank-surface"));

    expect(screen.queryByRole("dialog", { name: "Choose model" })).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("leaves focus with a real destination pressed outside the model chooser", async () => {
    renderChooser();
    const trigger = screen.getByRole("button", { name: /Choose model/u });
    fireEvent.click(trigger);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Search models" })).toHaveFocus());
    const destination = screen.getByRole("button", { name: "Outside action" });

    fireEvent.pointerDown(destination);
    destination.focus();
    await act(async () => {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    });

    expect(screen.queryByRole("dialog", { name: "Choose model" })).not.toBeInTheDocument();
    expect(destination).toHaveFocus();
  });

  it("returns usage focus to its trigger after a blank outside press", async () => {
    renderUsage();
    const trigger = screen.getByRole("button", { name: /Open usage and context/u });
    fireEvent.click(trigger);
    await act(async () => { await vi.dynamicImportSettled(); });
    expect(screen.getByRole("dialog", { name: "Usage & context" })).toBeInTheDocument();
    screen.getByRole("button", { name: "Close usage and context" }).focus();

    fireEvent.pointerDown(screen.getByTestId("blank-surface"));

    expect(screen.queryByRole("dialog", { name: "Usage & context" })).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("leaves focus with a real destination pressed outside the usage popover", async () => {
    renderUsage();
    fireEvent.click(screen.getByRole("button", { name: /Open usage and context/u }));
    await act(async () => { await vi.dynamicImportSettled(); });
    const destination = screen.getByRole("button", { name: "Outside action" });

    fireEvent.pointerDown(destination);
    destination.focus();
    await act(async () => {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    });

    expect(screen.queryByRole("dialog", { name: "Usage & context" })).not.toBeInTheDocument();
    expect(destination).toHaveFocus();
  });
});

describe("model search active descendant", () => {
  it("keeps active-descendant ownership on the focused search and favorites on each row", async () => {
    renderChooser();
    fireEvent.click(screen.getByRole("button", { name: /Choose model/u }));
    const search = screen.getByRole("combobox", { name: "Search models" });
    await waitFor(() => expect(search).toHaveFocus());
    const results = screen.getByRole("grid", { name: "Model results" });
    fireEvent.keyDown(search, { key: "Home" });
    await waitFor(() => expect(search).toHaveAttribute("aria-activedescendant"));

    expect(document.querySelectorAll("[aria-activedescendant]")).toHaveLength(1);
    expect(search).toHaveAttribute("aria-controls", results.id);
    expect(document.getElementById(search.getAttribute("aria-activedescendant")!))
      .toHaveTextContent("Team Alpha");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Model favorite actions" })).not.toBeInTheDocument();
    expect(within(results).getByRole("button", { name: /Add Team Alpha .* to favorites/u }))
      .toBeInTheDocument();
  });
});
