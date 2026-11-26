import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/shared/backend-presets", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/shared/backend-presets")>();
  const gemini = {
    harnessId: "antigravity-acp",
    protocol: "antigravity-managed",
    authenticationMode: "api-key",
    baseUrl: "https://generativelanguage.googleapis.com",
    displayName: "Gemini API key",
    providerId: "antigravity",
    defaultModels: [{ id: "gemini-3-pro", displayName: "Gemini 3 Pro" }],
  };
  const presets = { ...original.BACKEND_PRESETS, "gemini-api-key": gemini };
  return {
    ...original,
    BACKEND_PRESETS: presets,
    isBackendPresetId: (value: unknown) => typeof value === "string" && Object.hasOwn(presets, value),
    backendPresetDefinition: (preset: string) => presets[preset as keyof typeof presets],
  };
});

const { ModelBackendsSettings } = await import("../../src/renderer/src/components/ModelBackendsSettings");

describe("Antigravity with a Gemini API key", () => {
  it("offers Add API key next to the policy note when the Gemini preset exists", async () => {
    const user = userEvent.setup();
    render(<ModelBackendsSettings
      profiles={[]}
      providers={[]}
      disabled={false}
      onConnectProvider={vi.fn()}
      onRefreshProvider={vi.fn()}
      onLoadDetail={vi.fn()}
      onCreate={vi.fn()}
      onUpdate={vi.fn()}
      onSetCredential={vi.fn()}
      onClearCredential={vi.fn()}
      onProbe={vi.fn()}
      onDiscoverModels={vi.fn()}
      onDelete={vi.fn(async () => undefined)}
    />);
    const card = screen.getByRole("region", { name: "Antigravity" });
    expect(within(card).getByText("Official agy acp. Use a Gemini API key or Enterprise ADC.")).toBeInTheDocument();
    expect(within(card).getByText("No API keys yet. Add a Gemini API key to use your API credits.")).toBeInTheDocument();
    await user.click(within(card).getByRole("button", { name: "Add API key for Antigravity" }));
    expect(screen.getByRole("dialog", { name: "Add Gemini API key" })).toBeInTheDocument();
  });
});
