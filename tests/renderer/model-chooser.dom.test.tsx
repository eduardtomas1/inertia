import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ModelChooser } from "../../src/renderer/src/components/ModelChooser";
import type { ComposerModelRoute } from "../../src/renderer/src/utils/modelChooserRoutes";
import type { ModelSearchRoute } from "../../src/renderer/src/utils/modelSearch";
import {
  continuationIdentityForSelection,
  nativeModelSelection,
} from "../../src/shared/model-routing";

const localStorageDescriptor = Object.getOwnPropertyDescriptor(
  window,
  "localStorage",
);

function storage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
}

function currentRoute(): ComposerModelRoute {
  const selection = {
    ...nativeModelSelection({
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
    key: "current-team-alpha",
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
    continuationIdentity: continuationIdentityForSelection(
      selection,
      "opaque-team-route-5",
      true,
    ),
    compatibility: {
      state: "verified",
      allowsModelSwitchWithinSession: false,
    },
    rowCompatibility: null,
    providerId: "codex",
  };
}

describe("model chooser active route", () => {
  beforeEach(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: storage(),
    });
  });

  afterEach(() => {
    if (localStorageDescriptor) {
      Object.defineProperty(window, "localStorage", localStorageDescriptor);
    } else {
      Reflect.deleteProperty(window, "localStorage");
    }
  });

  it("does not mark the current revision active for a stale selection", () => {
    const route = currentRoute();
    const staleSelection = {
      ...route,
      key: "stale-team-alpha",
      backendConfigurationRevision: 4,
      selectable: false,
      unavailableReason: "This saved model route is no longer available.",
    } satisfies ModelSearchRoute;
    render(
      <ModelChooser
        routes={[route]}
        selectedRoute={staleSelection}
        onSelect={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Choose model/u }));

    expect(screen.getByRole("option", { name: /Team Alpha/u }))
      .toHaveAttribute("aria-selected", "false");
    expect(screen.queryByText("Active model")).not.toBeInTheDocument();
  });
});
