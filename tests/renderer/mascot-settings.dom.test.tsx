import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MascotSettings } from "../../src/renderer/src/components/MascotSettings";
import {
  emptyMascotStatus, MASCOT_SPRITE_STATES, type MascotSettingsBridge, type MascotSnapshot, type MascotSprites,
} from "../../src/shared/mascot";

afterEach(() => { Reflect.deleteProperty(window, "inertiaMascot"); });

const url = (id: string, name: string): string => `inertia://bundle/mascot-sprites/${id}/${name}`;
function sprites(id: string, animated: number): MascotSprites {
  return {
    id, animated,
    files: Object.fromEntries(MASCOT_SPRITE_STATES.map((state, index) => [state, {
      poster: url(id, `${state}.png`), animation: url(id, index < animated ? `${state}.webp` : `${state}.png`),
    }])) as MascotSprites["files"],
  };
}

function install() {
  let snapshot: MascotSnapshot = { preferences: { enabled: false, motion: true }, status: emptyMascotStatus() };
  const bridge = {
    snapshot: vi.fn(async () => snapshot),
    onChanged: vi.fn(() => () => undefined),
    action: vi.fn(async () => undefined),
    configure: vi.fn(async (preferences: MascotSnapshot["preferences"]) => (snapshot = { ...snapshot, preferences })),
    importSprites: vi.fn<MascotSettingsBridge["importSprites"]>(),
    applySprites: vi.fn(async (id: string) => (snapshot = { ...snapshot, sprites: sprites(id, 2) })),
    resetSprites: vi.fn(async () => (snapshot = { preferences: snapshot.preferences, status: snapshot.status })),
    exportSpriteTemplate: vi.fn<MascotSettingsBridge["exportSpriteTemplate"]>(),
  } satisfies MascotSettingsBridge;
  window.inertiaMascot = bridge;
  return bridge;
}

describe("mascot custom sprite settings", () => {
  it("exports the template, previews a valid import, applies it and resets to the default artwork", async () => {
    const bridge = install();
    render(<MascotSettings />);
    const section = await screen.findByRole("region", { name: "Custom sprites" });
    expect(section).toHaveTextContent("5 PNG images, 96 × 96 pixels each, plus optional animations.");
    expect(within(section).queryByRole("list")).toBeNull();

    bridge.exportSpriteTemplate.mockResolvedValueOnce({ status: "exported" });
    fireEvent.click(screen.getByRole("button", { name: "Export template" }));
    expect(await screen.findByText("Template exported. Replace its PNG files, then import the folder.")).toBeInTheDocument();

    bridge.importSprites.mockResolvedValueOnce({ status: "invalid", message: "idea.png must be 96 × 96 pixels, not 128 × 128." });
    fireEvent.click(screen.getByRole("button", { name: "Import sprites" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("idea.png must be 96 × 96 pixels, not 128 × 128.");

    bridge.importSprites.mockResolvedValueOnce({ status: "ready", sprites: sprites("0123456789abcdef", 2) });
    fireEvent.click(screen.getByRole("button", { name: "Import sprites" }));
    const preview = await screen.findByRole("list", { name: "Sprite preview" });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(within(preview).getAllByRole("listitem").map((item) => item.querySelector("span")!.textContent)).toEqual(["Idle", "Thinking", "Working", "Complete", "Picked up"]);
    expect(within(preview).getAllByRole("listitem").map((item) => item.querySelector("small")?.textContent ?? null)).toEqual(["Animated", "Animated", null, null, null]);
    expect(preview.querySelector("img")).toHaveAttribute("src", url("0123456789abcdef", "idle.png"));
    expect(preview.querySelector("source")).toHaveAttribute("srcset", url("0123456789abcdef", "idle.webp"));
    expect(preview.querySelector("source")).toHaveAttribute("media", "(prefers-reduced-motion: no-preference)");
    expect(section).toHaveTextContent("Preview: 5 states, 2 animated. Apply to use them.");
    expect(bridge.applySprites).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Apply sprites" }));
    expect(await screen.findByText("Custom sprites applied.")).toBeInTheDocument();
    expect(bridge.applySprites).toHaveBeenCalledWith("0123456789abcdef");
    expect(screen.getByRole("list", { name: "Current sprites" })).toBeInTheDocument();
    expect(section).toHaveTextContent("Using your sprites: 5 states, 2 animated.");

    fireEvent.click(screen.getByRole("button", { name: "Reset to default" }));
    expect(await screen.findByText("Default sprites restored.")).toBeInTheDocument();
    expect(bridge.resetSprites).toHaveBeenCalledOnce();
    expect(within(section).queryByRole("list")).toBeNull();
    expect(screen.queryByRole("button", { name: "Reset to default" })).toBeNull();
  });

  it("discards a preview without applying it and reports bridge failures", async () => {
    const bridge = install();
    render(<MascotSettings />);
    await screen.findByRole("region", { name: "Custom sprites" });
    bridge.importSprites.mockResolvedValueOnce({ status: "ready", sprites: sprites("fedcba9876543210", 1) });
    fireEvent.click(screen.getByRole("button", { name: "Import sprites" }));
    expect(await screen.findByText("Preview: 5 states, 1 animated. Apply to use them.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Discard preview" }));
    expect(screen.queryByRole("list")).toBeNull();
    expect(bridge.applySprites).not.toHaveBeenCalled();
    bridge.exportSpriteTemplate.mockRejectedValueOnce(new Error("disk full"));
    fireEvent.click(screen.getByRole("button", { name: "Export template" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not export the template.");
  });
});
