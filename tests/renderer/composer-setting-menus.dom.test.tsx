import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { ProviderInfo } from "../../src/shared/contracts";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import { Composer } from "../../src/renderer/src/components/Composer";
import { composerProps, conversation, routedProvider } from "./composer-fixtures";
import { ComposerResponseSpeedOptions } from "../../src/renderer/src/components/composer/ComposerResponseSpeedOptions";
import { declarationsFor, parseCssRules } from "./css-rules";
import { readSourceText } from "../helpers/source-text";

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

const longestLabelProvider: ProviderInfo = {
  ...routedProvider,
  models: [{
    id: "agent",
    label: "Routed Agent",
    description: "",
    isDefault: true,
    inputModalities: ["text"],
    reasoningOptions: [
      { value: "medium", label: "Medium", description: "Balanced" },
      { value: "xhigh", label: "Extra high", description: "Deepest" },
    ],
    defaultReasoningEffort: "medium",
    fastMode: { providerValue: "priority", label: "Fast", description: "Faster replies", isDefault: false },
  }],
};

const FOLD = "@container (max-width: 820px) or ((max-width: 900px) and style(--interface-scale: large))";

afterEach(() => {
  delete document.documentElement.dataset.interfaceScale;
});

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

  it("draws every setting as one chip of icon, label and chevron", () => {
    renderComposer();
    const family = screen.getByRole("group", { name: "Composer settings" });
    const chips = [...family.querySelectorAll<HTMLButtonElement>("button[data-composer-setting]")];
    expect(chips.map((chip) => chip.dataset.composerSetting)).toEqual(["reasoning", "access", "mode"]);
    const icons = { reasoning: "lucide-gauge", access: "lucide-shield-check", mode: "lucide-hammer" };
    for (const chip of chips) {
      const parts = [...chip.children].map((child) => child.getAttribute("class") ?? "");
      expect(parts, chip.dataset.composerSetting).toEqual([
        expect.stringContaining("composer-setting-icon"),
        "composer-setting-value",
        expect.stringContaining("composer-setting-chevron"),
      ]);
      expect(chip.firstElementChild).toHaveClass(icons[chip.dataset.composerSetting as keyof typeof icons]);
      expect(chip.firstElementChild).toHaveAttribute("aria-hidden", "true");
      expect(chip.lastElementChild).toHaveAttribute("aria-hidden", "true");
      expect(chip).toHaveAttribute("aria-haspopup", "menu");
      expect(chip).toHaveAttribute("aria-expanded", "false");
    }
    expect(chips.map((chip) => chip.textContent)).toEqual(["High", "Supervised", "Build"]);
    expect(family.textContent).not.toContain("·");
  });

  it("opens each chip's menu by click and by ArrowDown and marks the open chip expanded", () => {
    renderComposer();
    for (const [setting, menuName] of [
      ["reasoning", "Reasoning level"],
      ["access", "Project access"],
      ["mode", "Work mode"],
    ] as const) {
      const chip = document.querySelector<HTMLButtonElement>(`[data-composer-setting="${setting}"]`)!;
      fireEvent.click(chip);
      expect(screen.getByRole("menu", { name: menuName })).toBeVisible();
      expect(chip).toHaveAttribute("aria-expanded", "true");
      fireEvent.click(chip);
      expect(screen.queryByRole("menu", { name: menuName })).toBeNull();
      chip.focus();
      fireEvent.keyDown(chip, { key: "ArrowDown" });
      expect(screen.getByRole("menu", { name: menuName })).toBeVisible();
      fireEvent.keyDown(screen.getByRole("menu", { name: menuName }), { key: "Escape" });
      expect(screen.queryByRole("menu", { name: menuName })).toBeNull();
    }
  });

  it("keeps the longest chip labels whole at Large scale and folds them into More up to a 900px composer", async () => {
    document.documentElement.dataset.interfaceScale = "large";
    render(<Composer {...composerProps({
      ...conversation("large-longest-labels"),
      accessMode: "auto-edit",
      modelSelection: providerNativeModelSelection({ providerId: "codex", modelId: "agent", reasoningEffort: "xhigh" }),
      reasoningEffort: "xhigh",
    }, { providers: [longestLabelProvider] })} />);
    const family = screen.getByRole("group", { name: "Composer settings" });
    const chips = [...family.querySelectorAll<HTMLButtonElement>("button[data-composer-setting]")];
    expect(chips.map((chip) => [chip.dataset.composerSetting, chip.textContent])).toEqual([
      ["reasoning", "Extra high"],
      ["speed", "Standard"],
      ["access", "Auto-accept edits"],
      ["mode", "Build"],
    ]);
    for (const chip of chips) {
      expect(chip.querySelector(".composer-setting-chevron")).toHaveAttribute("width", "12");
      expect(chip.querySelector(".composer-setting-value")?.childNodes).toHaveLength(1);
    }

    fireEvent.click(await screen.findByRole("button", { name: "More composer options" }));
    const more = screen.getByRole("menu", { name: "More composer options" });
    expect(within(more).getAllByRole("menuitem").map((row) => row.textContent)).toEqual([
      "ReasoningExtra high",
      "Response speedStandard",
      "ModeBuild",
      "AccessAuto-accept edits",
    ]);

    const css = parseCssRules([
      readSourceText("src/renderer/src/styles.css"),
      readSourceText("src/renderer/src/components/composer/ComposerSurface.css"),
    ].join("\n"));
    expect(declarationsFor(css, ':root[data-interface-scale="large"]').get("--interface-scale")).toBe("large");
    expect(declarationsFor(css, ".composer-setting-family", FOLD).get("display")).toBe("none");
    expect(declarationsFor(css, ".composer-options > .composer-more-control", FOLD).get("display")).toBe("block");
    expect(declarationsFor(css, ".composer-shell .composer-options", FOLD).get("min-width")).toBe("var(--composer-control-height)");
    expect(css.some(({ context }) => context === "@container (max-width: 820px)")).toBe(false);
    const chip = declarationsFor(css, ".composer-shell .composer-setting-family .composer-pill");
    expect([chip.get("max-width"), chip.get("padding")]).toEqual(["none", "0 8px"]);
    expect(declarationsFor(css, ".composer-pill").get("white-space")).toBe("nowrap");
    expect(declarationsFor(css, ".composer-setting-value").get("max-width")).toBe("9em !important");
  });

  it("shows the access chip with the icon for its access mode, in every access mode", () => {
    for (const accessMode of ["supervised", "auto-edit", "full"] as const) {
      const current = conversation(`access-${accessMode}`);
      const { unmount } = render(<Composer {...composerProps({ ...current, accessMode })} />);
      const label = { supervised: "Supervised", "auto-edit": "Auto-accept edits", full: "Full access" }[accessMode];
      const icon = { supervised: "lucide-shield-check", "auto-edit": "lucide-pen-line", full: "lucide-lock-open" }[accessMode];
      const trigger = screen.getByRole("button", { name: `Choose project access. Current access: ${label}.` });
      expect(trigger).toHaveTextContent(label);
      expect(trigger.firstElementChild).toHaveClass("composer-setting-icon");
      expect([...trigger.querySelectorAll("svg")].map((svg) => svg.getAttribute("class"))).toEqual([
        expect.stringContaining(`${icon} `),
        expect.stringContaining("composer-setting-chevron"),
      ]);
      fireEvent.click(trigger);
      expect(within(screen.getByRole("menu", { name: "Project access" })).getByRole("menuitemradio", { name: new RegExp(label, "u") }))
        .toHaveAttribute("aria-checked", "true");
      unmount();
    }
  });

  it("runs Antigravity's Supervised as Auto-accept edits and explains why Supervised is unavailable", () => {
    const current = {
      ...conversation("access-antigravity"),
      providerId: "antigravity" as const,
      modelSelection: providerNativeModelSelection({ providerId: "antigravity" }),
      accessMode: "supervised" as const,
    };
    render(<Composer {...composerProps(current)} />);
    const trigger = screen.getByRole("button", { name: "Choose project access. Current access: Auto-accept edits." });
    fireEvent.click(trigger);
    const access = screen.getByRole("menu", { name: "Project access" });
    const supervised = within(access).getByRole("menuitemradio", { name: /Supervised/u });
    expect(supervised).toBeDisabled();
    expect(supervised).toHaveAttribute("aria-checked", "false");
    expect(supervised).toHaveTextContent("Antigravity can't pause for approval");
    expect(within(access).getByRole("menuitemradio", { name: /^Auto-accept edits/u })).toHaveAttribute("aria-checked", "true");
    expect(within(access).getByRole("menuitemradio", { name: /Full access/u })).toBeEnabled();
  });

  it("keeps Supervised available for providers that can ask for approval", () => {
    render(<Composer {...composerProps({ ...conversation("access-claude"), providerId: "claude", modelSelection: providerNativeModelSelection({ providerId: "claude" }) })} />);
    fireEvent.click(screen.getByRole("button", { name: "Choose project access. Current access: Supervised." }));
    expect(within(screen.getByRole("menu", { name: "Project access" })).getByRole("menuitemradio", { name: /Supervised/u })).toBeEnabled();
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

  it("opens the More tools tray to its options only, without a Chat tools label", async () => {
    const current = conversation("chat-tools");
    render(<Composer {...composerProps(current, {
      providers: [{ ...reasoningProvider, agentThreadManagement: { state: "supported", detail: "Agents can read other chats." } }],
    })} />);
    fireEvent.click(screen.getByRole("button", { name: "More tools" }));
    const tray = screen.getByRole("group", { name: "Add context" });
    expect(tray.closest(".composer-more-tools")).not.toHaveAttribute("hidden");
    expect(tray).not.toHaveTextContent("Chat tools");
    expect(screen.queryByLabelText(/Agent chat tools/u)).toBeNull();
    expect((await within(tray).findAllByRole("button")).length).toBeGreaterThan(0);
  });

  it("keeps a preset being written when a turn starts on its own", async () => {
    window.localStorage.clear();
    const props = composerProps(conversation("preset-while-turn-starts"));
    const view = render(<Composer {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "More tools" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Prompt presets/u }));
    fireEvent.click(await screen.findByRole("button", { name: "Create a preset" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Release checklist" } });

    view.rerender(<Composer {...props} running />);

    expect(screen.getByLabelText("Name")).toHaveValue("Release checklist");
    expect(screen.getByRole("button", { name: /^Prompt presets/u })).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps the scratch prompts menu open when a turn starts on its own", async () => {
    window.localStorage.clear();
    const props = composerProps(conversation("stash-while-turn-starts"));
    const view = render(<Composer {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "More tools" }));
    const trigger = await screen.findByRole("button", { name: /^Scratch prompts/u });
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    view.rerender(<Composer {...props} running />);

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menu", { name: /^Scratch prompts/u })).toBeVisible();
  });

  it("leaves out the More tools button when chat tools support is the only thing it would show", () => {
    const current = conversation("chat-tools-only");
    render(<Composer {...composerProps(current, {
      providers: [{ ...reasoningProvider, agentThreadManagement: { state: "supported", detail: "Agents can read other chats." } }],
      promptPresetsEnabled: false,
      promptStashEnabled: false,
    })} />);
    expect(screen.queryByRole("button", { name: "More tools" })).toBeNull();
  });
});
