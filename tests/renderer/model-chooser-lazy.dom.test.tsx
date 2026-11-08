import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ModelChooser } from "../../src/renderer/src/components/ModelChooser";
import { cursorSdkModelRoute } from "../../src/renderer/src/components/cursor-sdk/cursorSdkModelRoute";
import { nativePreviewSuspended } from "../../src/renderer/src/utils/nativePreviewOverlay";

it("keeps the trigger mounted and does not reopen after dismissing a pending load", async () => {
  const route = cursorSdkModelRoute({ id: "synthetic-model", displayName: "Synthetic model" })!;
  const onOpenChange = vi.fn();
  render(<><ModelChooser routes={[route]} selectedRoute={route} onSelect={vi.fn()} onOpenChange={onOpenChange} /><div data-testid="blank" /></>);
  const trigger = screen.getByRole("button", { name: /Choose model/u });
  fireEvent.click(trigger);
  expect(nativePreviewSuspended()).toBe(true);
  fireEvent.pointerDown(screen.getByTestId("blank"));
  await act(async () => { await vi.dynamicImportSettled(); });
  expect(screen.queryByRole("dialog", { name: "Choose model" })).toBeNull();
  expect(trigger).toHaveFocus();
  expect(nativePreviewSuspended()).toBe(false);
  fireEvent.click(trigger);
  await screen.findByRole("dialog", { name: "Choose model" });
  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() => expect(trigger).toHaveFocus());
  expect(trigger).toBe(screen.getByRole("button", { name: /Choose model/u }));
});
