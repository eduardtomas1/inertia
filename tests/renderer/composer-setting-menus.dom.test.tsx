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

function expectCheckOnChosenRowOnly(menu: HTMLElement): void {
  const rows = within(menu).getAllByRole("menuitemradio");
  expect(rows.length).toBeGreaterThan(1);
  for (const row of rows) {
    const check = row.querySelector(".composer-option-check");
    if (row.getAttribute("aria-checked") === "true") {
      expect(check).not.toBeNull();
      expect(check).toHaveAttribute("aria-hidden", "true");
    } else {
      expect(check).toBeNull();
    }
  }
}

describe("composer setting menus", () => {
  it("marks the chosen reasoning, mode and access rows with a check, without titles or dots", () => {
    renderComposer();
    fireEvent.click(screen.getByRole("button", { name: /^Choose reasoning level/u }));
    const reasoning = screen.getByRole("menu", { name: "Reasoning level" });
    expectQuietMenu(reasoning);
    expect(within(reasoning).getByRole("menuitemradio", { name: /High/u })).toHaveAttribute("aria-checked", "true");
    expectCheckOnChosenRowOnly(reasoning);

    fireEvent.click(screen.getByRole("button", { name: /^Choose project access/u }));
    const access = screen.getByRole("menu", { name: "Project access" });
    expectQuietMenu(access);
    expect(within(access).getByRole("menuitemradio", { name: /Supervised/u })).toHaveAttribute("aria-checked", "true");
    expectCheckOnChosenRowOnly(access);

    fireEvent.click(screen.getByRole("button", { name: /^Choose work mode/u }));
    const workMode = screen.getByRole("menu", { name: "Work mode" });
    expectQuietMenu(workMode);
    expectCheckOnChosenRowOnly(workMode);
  });

  it("shows the access control as its label and chevron only, in every access mode", () => {
    for (const accessMode of ["supervised", "auto-edit", "full"] as const) {
      const current = conversation(`access-${accessMode}`);
      const { unmount } = render(<Composer {...composerProps({ ...current, accessMode })} />);
      const label = { supervised: "Supervised", "auto-edit": "Auto-accept edits", full: "Full access" }[accessMode];
      const trigger = screen.getByRole("button", { name: `Choose project access. Current access: ${label}.` });
      expect(trigger).toHaveTextContent(label);
      expect(trigger.querySelector(".composer-setting-icon")).toBeNull();
      expect([...trigger.querySelectorAll("svg")].map((icon) => icon.getAttribute("class"))).toEqual([
        expect.stringContaining("composer-setting-chevron"),
      ]);
      fireEvent.click(trigger);
      expect(within(screen.getByRole("menu", { name: "Project access" })).getByRole("menuitemradio", { name: new RegExp(label, "u") }))
        .toHaveAttribute("aria-checked", "true");
      unmount();
    }
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
    expectCheckOnChosenRowOnly(container);
  });

  it("keeps the More menu to rows and a back header, with the mode consequences and a check on the chosen row", async () => {
    renderComposer();
    fireEvent.click(await screen.findByRole("button", { name: "More composer options" }));
    const root = screen.getByRole("menu", { name: "More composer options" });
    expectQuietMenu(root);
    fireEvent.click(within(root).getByRole("menuitem", { name: /^Mode/u }));
    const mode = screen.getByRole("menu", { name: "Mode options" });
    expectQuietMenu(mode);
    expect(mode).not.toHaveTextContent("Composer options");
    expect(within(mode).getByRole("menuitemradio", { name: /Build/u })).toHaveTextContent("Work directly in the project");
    expect(within(mode).getByRole("menuitemradio", { name: /Plan/u })).toHaveTextContent("Inspect and propose steps first");
    expectCheckOnChosenRowOnly(mode);
  });

  it("keeps the Chat tools pill as it was before the restyle", async () => {
    const current = conversation("chat-tools");
    render(<Composer {...composerProps(current, {
      providers: [{ ...reasoningProvider, agentThreadManagement: { state: "supported", detail: "Agents can read other chats." } }],
    })} />);
    const more = screen.queryByRole("button", { name: /More tools/u });
    if (more) fireEvent.click(more);
    const pill = await screen.findByLabelText("Agent chat tools: supported");
    expect(pill).toHaveClass("composer-pill", "composer-action-control", "is-active");
    expect(pill).not.toHaveClass("composer-tools-status");
    expect(pill).toHaveAttribute("title", "Agents can read other chats.");
  });
});
