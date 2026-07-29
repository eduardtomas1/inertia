import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ModelChooser } from "../../src/renderer/src/components/ModelChooser";
import { useNativePreviewSuspension } from "../../src/renderer/src/hooks/useNativePreviewSuspension";
import {
  nativePreviewSuspended,
  NATIVE_PREVIEW_OVERLAY_CLOSED,
  NATIVE_PREVIEW_OVERLAY_OPENED,
} from "../../src/renderer/src/utils/nativePreviewOverlay";
import type { SelectedModelChipRoute } from "../../src/renderer/src/utils/selectedModelChip";

function Suspension({ active }: { active: boolean }): null {
  useNativePreviewSuspension(active);
  return null;
}

describe("native preview suspension", () => {
  it("restores the native preview only after the final trusted overlay closes", () => {
    const opened = vi.fn();
    const closed = vi.fn();
    window.addEventListener(NATIVE_PREVIEW_OVERLAY_OPENED, opened);
    window.addEventListener(NATIVE_PREVIEW_OVERLAY_CLOSED, closed);
    const first = render(<Suspension active />);
    const second = render(<Suspension active />);

    expect(nativePreviewSuspended()).toBe(true);
    expect(opened).toHaveBeenCalledOnce();
    first.unmount();
    expect(nativePreviewSuspended()).toBe(true);
    expect(closed).not.toHaveBeenCalled();
    second.unmount();
    expect(nativePreviewSuspended()).toBe(false);
    expect(closed).toHaveBeenCalledOnce();

    window.removeEventListener(NATIVE_PREVIEW_OVERLAY_OPENED, opened);
    window.removeEventListener(NATIVE_PREVIEW_OVERLAY_CLOSED, closed);
  });

  it("suspends native previews while the model chooser is open", async () => {
    const storedValues = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        clear: () => storedValues.clear(),
        getItem: (key: string) => storedValues.get(key) ?? null,
        key: (index: number) => [...storedValues.keys()][index] ?? null,
        get length() {
          return storedValues.size;
        },
        removeItem: (key: string) => storedValues.delete(key),
        setItem: (key: string, value: string) => storedValues.set(key, value),
      } satisfies Storage,
    });
    const selectedRoute = {
      key: "codex-alpha",
      displayName: "Alpha",
      modelId: "alpha",
      alias: "Alpha",
      harnessId: "codex-app-server",
      harnessLabel: "Codex harness",
      backendProfileId: "codex",
      backendProfileName: "Codex",
      reasoningEffort: null,
      source: "built-in",
    } satisfies SelectedModelChipRoute;

    render(
      <ModelChooser
        routes={[]}
        selectedRoute={selectedRoute}
        onSelect={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Choose model/u }));

    expect(nativePreviewSuspended()).toBe(true);
    expect(screen.getByRole("dialog", { name: "Choose model" }))
      .toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => expect(nativePreviewSuspended()).toBe(false));
    expect(screen.queryByRole("dialog", { name: "Choose model" }))
      .not.toBeInTheDocument();
  });
});
