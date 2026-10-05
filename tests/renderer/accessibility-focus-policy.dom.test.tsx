import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ModelChooser } from "../../src/renderer/src/components/ModelChooser";
import { UsageIndicator } from "../../src/renderer/src/components/UsageIndicator";
import { Composer } from "../../src/renderer/src/components/Composer";
import type { ComposerModelRoute } from "../../src/renderer/src/utils/modelChooserRoutes";
import type { ProviderInfo } from "../../src/shared/contracts";
import {
  continuationIdentityForSelection,
  providerNativeModelSelection,
} from "../../src/shared/model-routing";
import { composerProps, conversation, deferred, provider } from "./composer-fixtures";

vi.mock("../../src/renderer/src/utils/modelRouteTransition", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/renderer/src/utils/modelRouteTransition")>(),
  resolveModelRouteTransition: (
    context: { projectId: string },
    candidate: { selection: ComposerModelRoute["selection"] },
  ) => ({
    projectId: context.projectId,
    selection: candidate.selection,
    changeKind: "model",
    reasonCode: "model-boundary",
    reason: "This route starts in a new chat.",
    kind: "create-new-conversation",
    providerSessionDisposition: "start-unbound",
    continuationAction: "new-conversation-required",
  }),
}));

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

describe("route-change confirmation focus", () => {
  function routeProviders(): ProviderInfo[] {
    const catalogState = {
      freshness: "fresh" as const,
      provenance: "provider" as const,
      updatedAt: "2026-08-01T00:00:00.000Z",
      lastAttemptedAt: "2026-08-01T00:00:00.000Z",
      refreshing: false,
    };
    const codex: ProviderInfo = {
      ...provider,
      models: [{
        id: "codex-route",
        label: "Codex Route",
        description: "Current route",
        isDefault: true,
        inputModalities: ["text"],
        reasoningOptions: [{ value: "high", label: "High", description: "" }],
        defaultReasoningEffort: "high",
      }],
      metadataState: { models: catalogState, rateLimits: catalogState },
    };
    return [codex, {
      ...codex,
      id: "claude",
      label: "Claude",
      models: [{ ...codex.models[0]!, id: "claude-route", label: "Claude Route", description: "Destination route" }],
    }];
  }

  function renderRouteComposer(onCreateConversationForSelection = vi.fn(async () => undefined)) {
    const current = conversation("route-focus");
    current.modelSelection = providerNativeModelSelection({
      providerId: "codex",
      modelId: "codex-route",
      alias: "Codex Route",
      reasoningEffort: "high",
    });
    current.model = "codex-route";
    current.reasoningEffort = "high";
    render(<Composer {...composerProps(current, {
      providers: routeProviders(),
      onCreateConversationForSelection,
    })} />);
    return onCreateConversationForSelection;
  }

  async function chooseClaudeRoute(): Promise<HTMLElement> {
    fireEvent.click(screen.getByRole("button", { name: /Choose model/u }));
    fireEvent.click(await screen.findByRole("button", { name: "Claude, 2 models" }));
    const claudeRoute = screen.getByTitle("Claude Route").closest("button");
    if (!claudeRoute) throw new Error("Expected the Claude route action.");
    fireEvent.click(claudeRoute);
    return await screen.findByRole("alertdialog", { name: /Continue in a new chat with .*Claude Route\?/u });
  }

  it("focuses Cancel, leaves ordinary controls reachable, and restores the model chip on Escape", async () => {
    renderRouteComposer();
    const confirmation = await chooseClaudeRoute();
    const cancel = within(confirmation).getByRole("button", { name: "Cancel" });

    expect(confirmation).toHaveAttribute("aria-modal", "false");
    await waitFor(() => expect(cancel).toHaveFocus());
    const message = screen.getByRole("textbox", { name: "Message" });
    message.focus();
    expect(message).toHaveFocus();
    expect(confirmation).toBeInTheDocument();

    cancel.focus();
    fireEvent.keyDown(cancel, { key: "Escape" });

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toHaveClass("selected-model-chip"));
  });

  it("keeps the confirmation open and busy while its new chat is being created", async () => {
    const creation = deferred<undefined>();
    const create = renderRouteComposer(vi.fn(() => creation.promise));
    const confirmation = await chooseClaudeRoute();

    fireEvent.click(within(confirmation).getByRole("button", { name: "Continue" }));

    expect(create).toHaveBeenCalledTimes(1);
    expect(confirmation).toHaveAttribute("aria-busy", "true");
    expect(within(confirmation).getByRole("button", { name: "Cancel" })).toBeDisabled();
    fireEvent.keyDown(confirmation, { key: "Escape" });
    expect(confirmation).toBeInTheDocument();

    await act(async () => { creation.resolve(undefined); await creation.promise; });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  });

  it("cancels its pending focus frame when dismissed before focus settles", async () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    const cancelFrame = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
      frames.delete(id);
    });
    const flushFrames = (): number[] => {
      const scheduledBefore = nextFrame;
      act(() => {
        for (const [id, callback] of Array.from(frames)) {
          frames.delete(id);
          callback(16);
        }
      });
      return [...frames.keys()].filter((id) => id > scheduledBefore);
    };
    renderRouteComposer();
    const confirmation = await chooseClaudeRoute();
    const cancel = within(confirmation).getByRole("button", { name: "Cancel" });
    const settleFrames = flushFrames();
    expect(settleFrames.length).toBeGreaterThan(0);
    expect(cancel).not.toHaveFocus();

    fireEvent.keyDown(confirmation, { key: "Escape" });

    expect(settleFrames.some((id) => cancelFrame.mock.calls.some(([cancelled]) => cancelled === id)))
      .toBe(true);
    flushFrames();
    expect(cancel).not.toHaveFocus();
    expect(document.activeElement).toHaveClass("selected-model-chip");
  });
});
