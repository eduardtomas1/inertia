import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MascotSettings } from "../../src/renderer/src/components/MascotSettings";
import { emptyMascotStatus, type MascotSettingsBridge, type MascotSnapshot } from "../../src/shared/mascot";
import { MASCOT_SPRITE_STATES, type MascotSprites } from "../../src/shared/mascot-sprites";

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
    expect(section).toHaveTextContent("Import your own artwork for each state. The built-in mascot stays until you apply a set.");
    const guide = section.querySelector("details.mascot-sprite-guide")!;
    expect(guide).toHaveProperty("open", true);
    expect(within(section).getByText("How custom sprites work")).toBeInTheDocument();
    expect(within(section).getByRole("list", { name: "Steps" }).querySelectorAll("li")).toHaveLength(4);
    expect(within(section).getByRole("list", { name: "Steps" })).toHaveTextContent("Export template to get a folder with the five built-in images");
    const format = within(section).getByRole("list", { name: "Format" });
    expect(format).toHaveTextContent("Each state needs a PNG: 96 × 96 pixels, a single frame, up to 512 KB.");
    expect(format).toHaveTextContent("To animate a state, add a .webp or .gif with the same name, like working.webp.");
    expect(format).toHaveTextContent("When animation is paused or reduced motion is on, the still PNG is shown.");
    const required = within(section).getByRole("list", { name: "Required files" });
    expect(within(required).getAllByRole("listitem").map((item) => [
      item.querySelector("code")!.textContent,
      item.querySelector("strong")!.textContent,
      item.querySelector("small")!.textContent,
    ])).toEqual([
      ["idle.png", "Idle", "Ready, or the latest chat stopped without finishing."],
      ["thinking.png", "Thinking", "Queued, starting, retrying, or waiting for your answer or approval."],
      ["working.png", "Working", "An agent is running, delegating, or stopping."],
      ["idea.png", "Complete", "Plays once for about 3 seconds when work finishes."],
      ["pickup.png", "Picked up", "Shown while you drag the mascot."],
    ]);
    expect(within(section).queryByRole("list", { name: "Sprite preview" })).toBeNull();

    bridge.exportSpriteTemplate.mockResolvedValueOnce({ status: "exported" });
    fireEvent.click(screen.getByRole("button", { name: "Export template" }));
    expect(await screen.findByText("Template exported. Replace its PNG files, then import the folder.")).toBeInTheDocument();

    bridge.importSprites.mockResolvedValueOnce({ status: "invalid", message: "idea.png must be 96 × 96 pixels, not 128 × 128." });
    fireEvent.click(screen.getByRole("button", { name: "Import sprites" }));
    const rejected = await within(section).findByRole("alert");
    expect(rejected).toHaveTextContent("idea.png must be 96 × 96 pixels, not 128 × 128.");
    expect(rejected).toHaveClass("mascot-sprites-error");
    expect(rejected.previousElementSibling).toBe(within(section).getByRole("list", { name: "Required files" }));

    bridge.importSprites.mockResolvedValueOnce({ status: "ready", sprites: sprites("0123456789abcdef", 2) });
    fireEvent.click(screen.getByRole("button", { name: "Import sprites" }));
    const preview = await screen.findByRole("list", { name: "Sprite preview" });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(within(preview).getAllByRole("listitem").map((item) => item.querySelector("span")!.textContent)).toEqual(["Idle", "Thinking", "Working", "Complete", "Picked up"]);
    expect(within(preview).getAllByRole("listitem").map((item) => item.querySelector("code")!.textContent)).toEqual(["idle.png", "thinking.png", "working.png", "idea.png", "pickup.png"]);
    expect(within(preview).getAllByRole("listitem").map((item) => item.querySelector("small")?.textContent ?? null)).toEqual(["Animated", "Animated", null, null, null]);
    expect(within(section).queryByRole("list", { name: "Required files" })).toBeNull();
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
    expect(within(section).queryByRole("list", { name: "Current sprites" })).toBeNull();
    expect(within(section).getByRole("list", { name: "Required files" })).toBeInTheDocument();
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
    expect(screen.queryByRole("list", { name: "Sprite preview" })).toBeNull();
    expect(screen.getByRole("list", { name: "Required files" })).toBeInTheDocument();
    expect(bridge.applySprites).not.toHaveBeenCalled();
    bridge.exportSpriteTemplate.mockRejectedValueOnce(new Error("disk full"));
    fireEvent.click(screen.getByRole("button", { name: "Export template" }));
    expect(await within(screen.getByRole("region", { name: "Custom sprites" })).findByRole("alert")).toHaveTextContent("Could not export the template.");
  });

  it("shows progress, makes apply the primary action, hints when the mascot is off and folds the guide once a set is applied", async () => {
    const bridge = install();
    render(<MascotSettings />);
    const section = await screen.findByRole("region", { name: "Custom sprites" });
    let finishImport: (value: Awaited<ReturnType<MascotSettingsBridge["importSprites"]>>) => void = () => undefined;
    bridge.importSprites.mockReturnValueOnce(new Promise((resolve) => { finishImport = resolve; }));
    fireEvent.click(screen.getByRole("button", { name: "Import sprites" }));
    expect(await screen.findByRole("button", { name: "Importing…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Export template" })).toBeDisabled();
    finishImport({ status: "invalid", message: "idle.png is missing." });
    expect(await within(section).findByRole("alert")).toHaveTextContent("idle.png is missing.");

    bridge.importSprites.mockResolvedValueOnce({ status: "ready", sprites: sprites("0011223344556677", 0) });
    fireEvent.click(screen.getByRole("button", { name: "Import sprites" }));
    const apply = await screen.findByRole("button", { name: "Apply sprites" });
    expect(apply).toHaveClass("primary-button");
    expect(screen.getByRole("button", { name: "Discard preview" })).toHaveClass("secondary-button");
    expect(section).toHaveTextContent("Turn on Desktop mascot above to see these sprites on your desktop.");

    bridge.importSprites.mockResolvedValueOnce({ status: "invalid", message: "working.png is missing." });
    fireEvent.click(screen.getByRole("button", { name: "Import sprites" }));
    expect(await within(section).findByRole("alert")).toHaveTextContent("working.png is missing.");
    bridge.importSprites.mockResolvedValueOnce({ status: "ready", sprites: sprites("8899aabbccddeeff", 0) });
    fireEvent.click(screen.getByRole("button", { name: "Import sprites" }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard preview" }));
    expect(within(section).queryByRole("alert")).toBeNull();

    bridge.importSprites.mockResolvedValueOnce({ status: "ready", sprites: sprites("0123456789abcdef", 2) });
    fireEvent.click(screen.getByRole("button", { name: "Import sprites" }));
    fireEvent.click(await screen.findByRole("button", { name: "Apply sprites" }));
    expect(await screen.findByText("Custom sprites applied.")).toBeInTheDocument();
    expect(section.querySelector("details.mascot-sprite-guide")).toHaveProperty("open", false);
    expect(within(section).getByText("How custom sprites work")).toBeInTheDocument();
  });
});
