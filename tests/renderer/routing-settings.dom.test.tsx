import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SettingsView } from "../../src/renderer/src/components/SettingsView";
import { searchSettings } from "../../src/renderer/src/components/settings/settingsMatcher";
import { SETTINGS_SECTION_ROWS } from "../../src/renderer/src/components/settingsRows";
import { clampRoutingControl } from "../../src/renderer/src/components/settings/sections/RoutingSettings";
import { routingPresetOptions } from "../../src/renderer/src/components/routing/RoutingTierPresets";
import { defaultSettings, type AppSettings, type AppSettingsUpdate, type ProviderInfo } from "../../src/shared/contracts";
import { routingCatalogFromProviders } from "../../src/shared/routing/routing-catalog";
import { defaultRoutingSettings, type RoutingPreset } from "../../src/shared/routing/routing-policy";
import { settingsProvider, settingsViewProps } from "./settings-view-fixtures";

const codex: ProviderInfo = {
  ...settingsProvider("codex", "Codex"),
  models: [
    {
      id: "gpt-5.6", label: "GPT-5.6", description: "", isDefault: true, inputModalities: ["text", "image"],
      reasoningOptions: [{ value: "medium", label: "Medium", description: "" }, { value: "high", label: "High", description: "" }],
      defaultReasoningEffort: "medium",
    },
    {
      id: "gpt-5.4-mini", label: "GPT-5.4 Mini", description: "", isDefault: false, inputModalities: ["text"],
      reasoningOptions: [{ value: "low", label: "Low", description: "" }], defaultReasoningEffort: "low",
    },
  ],
};
const custom: RoutingPreset[] = [
  { providerId: "codex", backendProfileId: "builtin:openai", modelId: "gpt-5.6", reasoningEffort: "high", fastMode: false, weight: "prefer" },
  { providerId: "codex", backendProfileId: "builtin:openai", modelId: "gpt-5.4-mini", reasoningEffort: "low", fastMode: false, weight: "normal" },
];

function renderRouting(routing: Partial<AppSettings["routing"]> = {}) {
  const onUpdate = vi.fn<(update: AppSettingsUpdate) => Promise<void>>(async () => undefined);
  const settings = { ...defaultSettings, routing: { ...defaultRoutingSettings(), ...routing } };
  render(<SettingsView {...settingsViewProps({ target: { section: "routing" }, settings, providers: [codex], onUpdate })} />);
  return { onUpdate };
}

describe("Settings → Routing", () => {
  it("renders the section with Auto routing off by default", async () => {
    renderRouting();
    expect(await screen.findByRole("heading", { level: 2, name: "Routing" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Enable Auto routing" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("switch", { name: "Use Auto for new chats" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("combobox", { name: "Picker" })).toHaveValue("rules");
    expect(screen.getByText(/Nothing leaves this device/u)).toBeInTheDocument();
  });

  it("toggles Auto routing and the new-chat default", async () => {
    const { onUpdate } = renderRouting({ enabled: true });
    fireEvent.click(await screen.findByRole("switch", { name: "Enable Auto routing" }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith({ routing: { enabled: false } }));
    fireEvent.click(screen.getByRole("switch", { name: "Use Auto for new chats" }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith({ routing: { autoForNewChats: true } }));
    fireEvent.change(screen.getByRole("combobox", { name: "Fallback tier" }), { target: { value: "heavy" } });
    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith({ routing: { fallbackTier: "heavy" } }));
    fireEvent.click(screen.getByRole("radio", { name: "Rebalance" }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith({ routing: { stickiness: "rebalance" } }));
  });

  it("bounds the confidence and quota controls", async () => {
    const { onUpdate } = renderRouting({ confidenceThreshold: 0.5 });
    const confidence = await screen.findByRole("slider", { name: "Confidence threshold" });
    expect(confidence).toHaveAttribute("min", "0.3");
    expect(confidence).toHaveAttribute("max", "0.9");
    expect(confidence).toHaveAttribute("aria-valuetext", "50%");
    fireEvent.change(confidence, { target: { value: "0.75" } });
    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith({ routing: { confidenceThreshold: 0.75 } }));
    const reserve = screen.getByRole("slider", { name: "Quota reserve" });
    expect(reserve).toHaveAttribute("max", "90");
    fireEvent.change(reserve, { target: { value: "25" } });
    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith({ routing: { quotaReservePercent: 25 } }));
    expect(clampRoutingControl(2, 0.3, 0.9, 0.05)).toBe(0.9);
    expect(clampRoutingControl(0.1, 0.3, 0.9, 0.05)).toBe(0.3);
    expect(clampRoutingControl(0.62, 0.3, 0.9, 0.05)).toBe(0.6);
    expect(clampRoutingControl(Number.NaN, 0, 90, 5)).toBe(0);
  });

  it("previews derived defaults and customises, adds and resets a tier", async () => {
    const { onUpdate } = renderRouting();
    const light = await screen.findByRole("region", { name: /^Light/u });
    expect(within(light).getByText("Defaults")).toBeInTheDocument();
    expect(within(light).getByRole("list", { name: "Light presets" })).toHaveTextContent("Codex · GPT-5.4 Mini · low");
    expect(within(light).queryByRole("button", { name: /^Remove/u })).not.toBeInTheDocument();
    fireEvent.change(within(light).getByRole("combobox", { name: "Model to add to Light" }), {
      target: { value: JSON.stringify(["codex", "builtin:openai", "gpt-5.6", "high", false]) },
    });
    fireEvent.click(within(light).getByRole("button", { name: "Add to Light" }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith({ routing: { tiers: { light: { presets: [
      { providerId: "codex", backendProfileId: "builtin:openai", modelId: "gpt-5.4-mini", reasoningEffort: "low", fastMode: false, weight: "prefer" },
      { providerId: "codex", backendProfileId: "builtin:openai", modelId: "gpt-5.6", reasoningEffort: "high", fastMode: false, weight: "normal" },
    ] } } } }));
    const heavy = screen.getByRole("region", { name: /^Heavy/u });
    fireEvent.click(within(heavy).getByRole("button", { name: "Customize Heavy" }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith({ routing: { tiers: { heavy: { presets: [
      { providerId: "codex", backendProfileId: "builtin:openai", modelId: "gpt-5.6", reasoningEffort: "high", fastMode: false, weight: "prefer" },
    ] } } } }));
  });

  it("removes, reorders, reweights and resets custom presets", async () => {
    const { onUpdate } = renderRouting({ tiers: { ...defaultRoutingSettings().tiers, standard: { presets: custom } } });
    const standard = await screen.findByRole("region", { name: /^Standard/u });
    expect(within(standard).getByText("Custom")).toBeInTheDocument();
    expect(within(standard).getByRole("button", { name: "Move Codex · GPT-5.6 · high up" })).toBeDisabled();
    fireEvent.click(within(standard).getByRole("button", { name: "Move Codex · GPT-5.6 · high down" }));
    await waitFor(() => expect(onUpdate).toHaveBeenLastCalledWith({ routing: { tiers: { standard: { presets: [custom[1], custom[0]] } } } }));
    await waitFor(() => expect(within(standard).getByRole("button", { name: "Move Codex · GPT-5.6 · high up" })).toHaveFocus());
    fireEvent.change(within(standard).getByRole("combobox", { name: "Weight for Codex · GPT-5.6 · high" }), { target: { value: "never" } });
    await waitFor(() => expect(onUpdate).toHaveBeenLastCalledWith({ routing: { tiers: { standard: { presets: [
      custom[1], { ...custom[0], weight: "never" },
    ] } } } }));
    fireEvent.click(within(standard).getByRole("button", { name: "Remove Codex · GPT-5.4 Mini · low" }));
    await waitFor(() => expect(onUpdate).toHaveBeenLastCalledWith({ routing: { tiers: { standard: { presets: [
      { ...custom[0], weight: "never" },
    ] } } } }));
    fireEvent.click(within(standard).getByRole("button", { name: "Reset Standard to defaults" }));
    await waitFor(() => expect(onUpdate).toHaveBeenLastCalledWith({ routing: { tiers: { standard: { presets: null } } } }));
  });

  it("refuses to add beyond the per-tier limit", async () => {
    const many = Array.from({ length: 24 }, () => custom[0]!);
    renderRouting({ tiers: { ...defaultRoutingSettings().tiers, max: { presets: many } } });
    const max = await screen.findByRole("region", { name: /^Max/u });
    fireEvent.change(within(max).getByRole("combobox", { name: "Model to add to Max" }), {
      target: { value: JSON.stringify(["codex", "builtin:openai", "gpt-5.6", "medium", false]) },
    });
    expect(within(max).getByRole("button", { name: "Add to Max" })).toBeDisabled();
    expect(within(max).getByText("A tier holds at most 24 presets.")).toHaveAttribute("role", "status");
  });

  it("lists every advertised model and reasoning level as an option", () => {
    expect(routingPresetOptions(routingCatalogFromProviders([codex])).map(({ label }) => label)).toEqual([
      "Codex · GPT-5.6 · medium",
      "Codex · GPT-5.6 · high",
      "Codex · GPT-5.4 Mini · low",
    ]);
  });

  it("is searchable like every other setting", () => {
    const [group] = searchSettings("auto routing", SETTINGS_SECTION_ROWS);
    expect(group?.sectionId).toBe("routing");
    expect(group!.results[0]!.row.id).toBe("routing-enabled");
    const presets = searchSettings("tier presets", SETTINGS_SECTION_ROWS).flatMap(({ results }) => results.map(({ row }) => row.id));
    expect(presets).toContain("routing-tier-presets");
  });
});
