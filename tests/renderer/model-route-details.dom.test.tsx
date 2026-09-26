import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ModelChooser } from "../../src/renderer/src/components/ModelChooser";
import { ModelRouteDetails } from "../../src/renderer/src/components/ModelRouteDetails";
import type { ComposerModelRoute } from "../../src/renderer/src/utils/modelChooserRoutes";
import { continuationIdentityForSelection, providerNativeModelSelection } from "../../src/shared/model-routing";

function route(): ComposerModelRoute {
  const selection = providerNativeModelSelection({ providerId: "claude", modelId: "sonnet", alias: "Claude Sonnet", reasoningEffort: null });
  return {
    key: "sonnet-route", displayName: "Claude Sonnet", modelId: "sonnet", alias: "Claude Sonnet",
    harnessId: selection.harnessId, harnessLabel: "Claude", backendProfileId: selection.backendProfileId,
    backendProfileName: "Claude", source: "built-in", providerId: "claude", providerLabel: "Claude",
    routeTerms: [], reasoningEffort: null, reasoningOptions: [], selectable: true, unavailableReason: null,
    providerReady: true, selection, continuationIdentity: continuationIdentityForSelection(selection, null, true),
    compatibility: { state: "verified", allowsModelSwitchWithinSession: false }, rowCompatibility: null,
  };
}

describe("model route capability details", () => {
  it("retains the selected provider alias without inventing a canonical model or missing capabilities", () => {
    const current = route();
    render(<ModelRouteDetails route={current} selection={current} />);
    fireEvent.click(screen.getByText("Model details"));
    expect(screen.getByText("sonnet")).toBeInTheDocument();
    expect(screen.getByText("Not reported before the turn")).toBeInTheDocument();
    expect(screen.getByText("Not reported")).toBeInTheDocument();
    expect(screen.getByText("Starts a new session")).toBeInTheDocument();
    expect(screen.queryByText("claude-sonnet-4-6")).toBeNull();
  });

  it("distinguishes declared compatibility from verified support and honors harness image restrictions", () => {
    const current = route();
    current.harnessId = "antigravity-cli";
    current.inputModalities = ["text", "image"];
    current.selection.capabilities = [
      { id: "tools", state: "user-declared", provenance: "user", detail: "Configured for this backend" },
      { id: "usage", state: "unavailable", provenance: "harness", detail: null },
    ];
    render(<ModelRouteDetails route={current} selection={current} />);
    fireEvent.click(screen.getByText("Model details"));
    expect(screen.getByText("User declared — Configured for this backend")).toBeInTheDocument();
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
    expect(screen.getByText("Antigravity can't read images in Inertia.")).toBeInTheDocument();
    expect(screen.queryByText("Verified")).toBeNull();
  });

  it("allows keyboard disclosure without selecting the highlighted model", async () => {
    const current = route();
    const onSelect = vi.fn();
    render(<ModelChooser routes={[current]} selectedRoute={current} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: /^Choose model/ }));
    const details = await screen.findByText("Model details");
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Search models" })).toHaveFocus());
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search models" }), { key: "ArrowDown" });
    details.focus();
    fireEvent.keyDown(details, { key: "Enter" });
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(details);
    expect(details.closest("details")).toHaveAttribute("open");
  });
});
