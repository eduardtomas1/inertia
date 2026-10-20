import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { WatcherDockHost } from "../../src/renderer/src/components/watcher/WatcherDockHost";
import { WatcherContext } from "../../src/renderer/src/components/watcher/watcherContext";
import { resetWatcherDockStore, setWatcherDockOpen } from "../../src/renderer/src/hooks/useWatcherDock";
import { WATCHED_ID, surfaceModel } from "./watcher-fixtures";

let broken = true;

vi.mock("../../src/renderer/src/components/watcher/WatcherDock", () => ({
  WatcherDock: () => {
    if (broken) throw new Error("render failed");
    return <p>Dock loaded</p>;
  },
}));

const settle = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
});

beforeEach(() => {
  window.localStorage.clear();
  resetWatcherDockStore();
  broken = true;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

function renderHost(): void {
  render(
    <WatcherContext.Provider value={surfaceModel()}>
      <WatcherDockHost watchedId={WATCHED_ID} />
    </WatcherContext.Provider>,
  );
}

describe("a dock that fails while open", () => {
  it("leaves the handle in its place and loads again from it", async () => {
    renderHost();
    await settle();
    const handle = screen.getByRole("button", { name: "Open watcher" });
    expect(handle).toHaveAttribute("aria-expanded", "false");
    broken = false;
    fireEvent.click(handle);
    await settle();
    expect(screen.getByText("Dock loaded")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open watcher" })).not.toBeInTheDocument();
  });

  it("loads again when Open watcher comes from elsewhere", async () => {
    renderHost();
    await settle();
    broken = false;
    act(() => setWatcherDockOpen(WATCHED_ID, true, { focusHeading: true }));
    await settle();
    expect(screen.getByText("Dock loaded")).toBeInTheDocument();
  });
});
