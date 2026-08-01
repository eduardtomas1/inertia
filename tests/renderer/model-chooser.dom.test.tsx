import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ModelChooser } from "../../src/renderer/src/components/ModelChooser";
import type { ComposerModelRoute } from "../../src/renderer/src/utils/modelChooserRoutes";
import type { ModelSearchRoute } from "../../src/renderer/src/utils/modelSearch";
import {
  continuationIdentityForSelection,
  nativeModelSelection,
} from "../../src/shared/model-routing";

function catalogRoute(index: number): ComposerModelRoute {
  const base = currentRoute();
  const modelId = `team-model-${String(index).padStart(4, "0")}`;
  const selection = {
    ...base.selection,
    modelId,
    alias: `Team Model ${index}`,
  };
  return {
    ...base,
    key: `route-${index}`,
    displayName: `Team Model ${index}`,
    modelId,
    alias: selection.alias,
    selection,
    continuationIdentity: continuationIdentityForSelection(
      selection,
      `opaque-team-route-${index}`,
      true,
    ),
  };
}

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

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
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

    const result = screen.getByRole("list", { name: "Model results" })
      .querySelector(".model-chooser-row-option");
    expect(result).not.toBeNull();
    expect(result).not.toHaveAttribute("aria-current");
    expect(screen.queryByText("Active model")).not.toBeInTheDocument();
  });

  it("restores trigger focus after an acknowledged selection re-enables it", async () => {
    const route = currentRoute();
    const acknowledgement = deferred();

    function PendingSelectionChooser() {
      const [disabled, setDisabled] = useState(false);
      return (
        <ModelChooser
          routes={[route]}
          selectedRoute={route}
          disabled={disabled}
          onSelect={() => {
            setDisabled(true);
            void acknowledgement.promise.then(() => setDisabled(false));
          }}
        />
      );
    }

    render(<PendingSelectionChooser />);
    const trigger = screen.getByRole("button", { name: /Choose model/u });
    fireEvent.click(trigger);
    const result = screen.getByRole("list", { name: "Model results" })
      .querySelector(".model-chooser-row-option");
    if (!result) throw new Error("Expected a model result action.");
    fireEvent.click(result);

    expect(screen.queryByRole("dialog", { name: "Choose model" }))
      .not.toBeInTheDocument();
    expect(trigger).toBeDisabled();
    expect(trigger).not.toHaveFocus();

    await act(async () => acknowledgement.resolve());

    await waitFor(() => expect(trigger).toBeEnabled());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("windows a 750-route catalog within render and keyboard latency budgets", async () => {
    const routes = Array.from({ length: 750 }, (_, index) =>
      catalogRoute(index));
    render(
      <ModelChooser
        routes={routes}
        selectedRoute={routes[0]!}
        onSelect={vi.fn()}
      />,
    );

    const startedAt = performance.now();
    fireEvent.click(screen.getByRole("button", { name: /Choose model/u }));
    const elapsed = performance.now() - startedAt;

    const resultList = screen.getByRole("list", { name: "Model results" });
    await waitFor(() => {
      expect(resultList.querySelectorAll(":scope > li").length)
        .toBeGreaterThan(0);
    });
    const results = resultList.querySelectorAll(":scope > li");
    expect(results.length).toBeLessThanOrEqual(24);
    expect(results.length).toBeLessThan(750);
    expect(document.querySelector(".model-chooser-favorite-actions"))
      .toBeNull();
    const first = results[0]!;
    expect(first).toHaveAttribute("aria-posinset", "1");
    expect(first).toHaveAttribute("aria-setsize", "750");
    expect(first.querySelectorAll(".model-chooser-row-option"))
      .toHaveLength(1);
    expect(first.querySelectorAll("button")).toHaveLength(2);
    expect(first.querySelectorAll(".model-chooser-row-favorite"))
      .toHaveLength(1);
    expect(elapsed).toBeLessThan(750);

    const search = screen.getByRole("searchbox", { name: "Search models" });
    const endStartedAt = performance.now();
    fireEvent.keyDown(search, { key: "End" });
    await waitFor(() => {
      const activeId = search.getAttribute("aria-activedescendant");
      expect(activeId).not.toBeNull();
      expect(document.getElementById(activeId!)).toHaveTextContent(
        "Team Model 749",
      );
    });
    expect(performance.now() - endStartedAt).toBeLessThan(500);
    expect(resultList.querySelectorAll(":scope > li").length)
      .toBeLessThanOrEqual(24);

    fireEvent.keyDown(search, { key: "Home" });
    await waitFor(() => {
      const activeId = search.getAttribute("aria-activedescendant");
      expect(document.getElementById(activeId!)).toHaveTextContent(
        "Team Model 0",
      );
    });

    const favorite = resultList.querySelector<HTMLButtonElement>(
      ".model-chooser-row-favorite",
    )!;
    favorite.focus();
    fireEvent.click(favorite);
    expect(favorite).toHaveFocus();
    expect(favorite).toHaveAttribute("aria-pressed", "true");
  });
});
