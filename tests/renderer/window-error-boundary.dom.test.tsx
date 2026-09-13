import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WindowErrorBoundary } from "../../src/renderer/src/components/WindowErrorBoundary";
import { createSurfaceLoader } from "../../src/renderer/src/utils/surfaceLoader";
import { useLoadedSurface } from "../../src/renderer/src/hooks/useLoadedSurface";

function Surface({ load }: { load: ReturnType<typeof createSurfaceLoader<{ default: () => React.JSX.Element }>> }): React.JSX.Element {
  const Loaded = useLoadedSurface(load, true);
  return Loaded ? <Loaded /> : <p>Loading</p>;
}

describe("window loading recovery", () => {
  it("retries a failed prefetch and caches the successful module", async () => {
    const module = { default: () => <p>Ready</p> };
    const load = vi.fn().mockRejectedValueOnce(new Error("missing chunk")).mockResolvedValue(module);
    const loader = createSurfaceLoader(load);
    const first = loader();
    expect(loader()).toBe(first);
    await expect(first).rejects.toThrow("missing chunk");
    expect(loader.peek()).toBeNull();
    await expect(loader()).resolves.toBe(module);
    expect(loader.peek()).toBe(module);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("renders a reload action instead of unmounting the window after a surface failure", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const load = createSurfaceLoader<{ default: () => React.JSX.Element }>(() => Promise.reject(new Error("missing chunk")));
      render(<WindowErrorBoundary><Surface load={load} /></WindowErrorBoundary>);
      expect(await screen.findByRole("alert")).toHaveTextContent("This window could not finish loading.");
      expect(screen.getByRole("button", { name: "Reload window" })).toBeEnabled();
    } finally { error.mockRestore(); }
  });
});
