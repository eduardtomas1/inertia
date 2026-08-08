// @vitest-environment happy-dom

import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useLoadedSurface } from "../../src/renderer/src/hooks/useLoadedSurface";
import type { SurfaceLoader } from "../../src/renderer/src/utils/surfaceLoader";

function ReadySurface(): React.JSX.Element {
  return <p>Surface ready</p>;
}

function Harness({
  loader,
}: {
  loader: SurfaceLoader<{ default: typeof ReadySurface }>;
}): React.JSX.Element {
  const Surface = useLoadedSurface(loader, true);
  return Surface ? <Surface /> : <p>Loading surface</p>;
}

describe("useLoadedSurface", () => {
  it("renders a prefetched surface without starting another async handoff", () => {
    const module = { default: ReadySurface };
    const loader = Object.assign(vi.fn(async () => module), {
      peek: () => module,
    });

    render(<Harness loader={loader} />);

    expect(screen.getByText("Surface ready")).toBeTruthy();
    expect(loader).not.toHaveBeenCalled();
  });

  it("loads an unprefetched surface and replaces the fallback", async () => {
    const module = { default: ReadySurface };
    let loaded: typeof module | null = null;
    const loader = Object.assign(
      vi.fn(async () => {
        loaded = module;
        return module;
      }),
      { peek: () => loaded },
    );

    render(<Harness loader={loader} />);

    expect(screen.getByText("Loading surface")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("Surface ready")).toBeTruthy());
    expect(loader).toHaveBeenCalledTimes(1);
  });
});
