import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { UsageIndicator } from "../../src/renderer/src/components/UsageIndicator";
import * as placement from "../../src/renderer/src/utils/composerPopoverPlacement";

afterEach(() => vi.restoreAllMocks());

function usage() {
  return render(<UsageIndicator usage={null} rateLimits={[]}
    rateLimitState={{ freshness: "unavailable", provenance: null,
      updatedAt: null, lastAttemptedAt: null, refreshing: false }}
    quotaSource="selected-route" mode="expanded" providerLabel="Codex"
    onModeChange={() => undefined} />);
}

it("observes the visible usage popover and cleans up placement on close and unmount", async () => {
  const stop = vi.fn();
  const observe = vi.spyOn(placement, "observeComposerPopover").mockImplementation((_trigger, popover) => {
    popover.dataset.composerPopoverPositioned = "true";
    return stop;
  });
  const view = usage();
  const trigger = screen.getByRole("button", { name: /Open usage and context/ });
  fireEvent.click(trigger);
  await act(async () => { await vi.dynamicImportSettled(); });
  const dialog = screen.getByRole("dialog", { name: "Usage & context" });
  expect(observe).toHaveBeenCalledExactlyOnceWith(trigger, dialog, expect.any(Function));
  fireEvent.click(screen.getByRole("button", { name: "Close usage and context" }));
  expect(stop).toHaveBeenCalledOnce();
  expect(dialog).not.toHaveAttribute("data-composer-popover-positioned");

  fireEvent.click(trigger);
  await act(async () => { await vi.dynamicImportSettled(); });
  expect(observe).toHaveBeenCalledTimes(2);
  view.unmount();
  expect(stop).toHaveBeenCalledTimes(2);
});

it("does not attach placement after the usage popover closes while its module loads", async () => {
  const observe = vi.spyOn(placement, "observeComposerPopover");
  usage();
  fireEvent.click(screen.getByRole("button", { name: /Open usage and context/ }));
  fireEvent.click(screen.getByRole("button", { name: "Close usage and context" }));
  await act(async () => { await vi.dynamicImportSettled(); });
  expect(observe).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog", { name: "Usage & context" })).not.toBeInTheDocument();
});
