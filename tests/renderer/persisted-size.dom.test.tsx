import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { usePersistedSize } from "../../src/renderer/src/hooks/usePersistedSize";

function SizeHarness({ storageKey }: { storageKey: string }): React.JSX.Element {
  const [size, setSize] = usePersistedSize(
    storageKey,
    260,
    { min: 150, max: 520 },
  );
  return (
    <>
      <output aria-label="Current size">{size}</output>
      <button type="button" onClick={() => setSize(280)}>Resize</button>
    </>
  );
}

describe("usePersistedSize", () => {
  let stored: Map<string, string>;

  beforeEach(() => {
    stored = new Map();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => stored.set(key, value),
        removeItem: (key: string) => stored.delete(key),
      },
    });
  });

  it("reloads the owning value when its persistence key changes", async () => {
    window.localStorage.setItem("pane-a", "210");
    window.localStorage.setItem("pane-b", "330");
    const view = render(<SizeHarness storageKey="pane-a" />);

    expect(screen.getByLabelText("Current size")).toHaveTextContent("210");
    fireEvent.click(screen.getByRole("button", { name: "Resize" }));
    await waitFor(() => {
      expect(window.localStorage.getItem("pane-a")).toBe("280");
    });

    view.rerender(<SizeHarness storageKey="pane-b" />);

    expect(screen.getByLabelText("Current size")).toHaveTextContent("330");
    expect(window.localStorage.getItem("pane-a")).toBe("280");
    await waitFor(() => {
      expect(window.localStorage.getItem("pane-b")).toBe("330");
    });
  });
});
