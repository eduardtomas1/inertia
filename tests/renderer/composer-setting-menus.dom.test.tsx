import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ProviderInfo } from "../../src/shared/contracts";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import { Composer } from "../../src/renderer/src/components/Composer";
import { composerProps, conversation, routedProvider } from "./composer-fixtures";
import { ComposerResponseSpeedOptions } from "../../src/renderer/src/components/composer/ComposerResponseSpeedOptions";

const reasoningProvider: ProviderInfo = {
  ...routedProvider,
  models: [{
    id: "agent",
    label: "Routed Agent",
    description: "",
    isDefault: true,
    inputModalities: ["text"],
    reasoningOptions: [
      { value: "medium", label: "Medium", description: "Balanced" },
      { value: "high", label: "High", description: "Deeper" },
    ],
    defaultReasoningEffort: "medium",
    fastMode: { providerValue: "fast", label: "Fast", description: "Faster replies", isDefault: false },
  }],
};

function renderComposer(): void {
  const current = conversation("setting-menus");
  render(<Composer {...composerProps({
    ...current,
    modelSelection: providerNativeModelSelection({ providerId: "codex", modelId: "agent", reasoningEffort: "high" }),
    reasoningEffort: "high",
  }, { providers: [reasoningProvider] })} />);
}

function expectQuietMenu(menu: HTMLElement): void {
  expect(menu.querySelector(".popover-title")).toBeNull();
  expect(menu.querySelector(".option-check")).toBeNull();
}

describe("composer setting menus", () => {
  it("marks the chosen reasoning, speed and access rows by state alone, without titles or dots", () => {
    renderComposer();
    fireEvent.click(screen.getByRole("button", { name: /^Choose reasoning level/u }));
    const reasoning = screen.getByRole("menu", { name: "Reasoning level" });
    expectQuietMenu(reasoning);
    expect(within(reasoning).getByRole("menuitemradio", { name: /High/u })).toHaveAttribute("aria-checked", "true");

    fireEvent.click(screen.getByRole("button", { name: /^Choose project access/u }));
    const access = screen.getByRole("menu", { name: "Project access" });
    expectQuietMenu(access);
    expect(within(access).getByRole("menuitemradio", { name: /Supervised/u })).toHaveAttribute("aria-checked", "true");
  });

  it("leaves Standard speed without a description that repeats its label and without a dot", () => {
    const { container } = render(
      <div role="menu" aria-label="Response speed">
        <ComposerResponseSpeedOptions
          fastMode={{ providerValue: "fast", label: "Fast", description: "Faster replies", isDefault: false }}
          selectedFastMode={false}
          pending={false}
          onUpdate={async () => undefined}
          onSelected={() => undefined}
        />
      </div>,
    );
    expectQuietMenu(container);
    const standard = screen.getByRole("menuitemradio", { name: "Standard" });
    expect(standard).toHaveAttribute("aria-checked", "true");
    expect(standard.querySelector("small")).toBeNull();
    expect(screen.getByRole("menuitemradio", { name: /Fast/u })).toHaveTextContent("Faster replies");
  });

  it("keeps the More menu to rows and a back header without repeated titles or mode helper lines", async () => {
    renderComposer();
    fireEvent.click(await screen.findByRole("button", { name: "More composer options" }));
    const root = screen.getByRole("menu", { name: "More composer options" });
    expectQuietMenu(root);
    fireEvent.click(within(root).getByRole("menuitem", { name: /^Mode/u }));
    const mode = screen.getByRole("menu", { name: "Mode options" });
    expectQuietMenu(mode);
    expect(mode).not.toHaveTextContent("Composer options");
    expect(mode).not.toHaveTextContent("Work directly in the project");
    expect(mode).not.toHaveTextContent("Inspect and propose steps first");
  });
});
