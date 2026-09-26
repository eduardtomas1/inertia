import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { AttachmentStorageSettings } from "../../src/renderer/src/components/AttachmentStorageSettings";
import { defaultSettings, type ServerEvent } from "../../src/shared/contracts";

const storage = { state: "ready" as const, records: 70, bytes: 100 * 1024 ** 2,
  maxBytes: 16 * 1024 ** 3, maxRecords: 65_536, availableDiskBytes: 500 * 1024 ** 3,
  removableRecords: 64, removableBytes: 80 * 1024 ** 2 };
function response(removed?: { records: number; bytes: number }, removableRecords = storage.removableRecords): ServerEvent {
  return { type: "request.result", requestId: "request", result: { kind: "attachment.storage", storage: { ...storage, removableRecords }, removed } };
}

it("shows global disk usage and changes the budget without deleting attachments", async () => {
  const request = vi.fn().mockResolvedValue(response());
  const onUpdate = vi.fn().mockResolvedValue(undefined);
  render(<AttachmentStorageSettings settings={defaultSettings} disabled={false} request={request} onUpdate={onUpdate} />);
  expect(await screen.findByText(/100.0 MiB used · 70 of 65,536 files/u)).toBeVisible();
  fireEvent.change(screen.getByRole("combobox", { name: "Global attachment disk budget" }), { target: { value: "64" } });
  await waitFor(() => expect(onUpdate).toHaveBeenCalledWith({ attachmentStorageGiB: 64 }));
  expect(request.mock.calls.every(([command]) => command.type === "attachment.storage.get")).toBe(true);
  expect(screen.getByText(/This disk budget does not reserve RAM/u)).toBeVisible();
});

it("requires confirmation for both explicit deletion and automatic eviction and allows cancellation", async () => {
  const request = vi.fn().mockResolvedValue(response({ records: 64, bytes: 80 * 1024 ** 2 }));
  const onUpdate = vi.fn().mockResolvedValue(undefined);
  render(<AttachmentStorageSettings settings={defaultSettings} disabled={false} request={request} onUpdate={onUpdate} />);
  const remove = await screen.findByRole("button", { name: /Remove oldest files \(64/u });
  fireEvent.click(remove);
  expect(screen.getByRole("group", { name: "Confirm attachment deletion" })).toHaveFocus();
  expect(screen.getByText(/including archived chats/u)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(request.mock.calls).toHaveLength(1);
  expect(remove).toHaveFocus();
  fireEvent.click(remove);
  fireEvent.click(screen.getByRole("button", { name: "Remove stored files" }));
  expect(await screen.findByText("Removed 64 files and freed 80.0 MiB.")).toBeVisible();
  expect(request).toHaveBeenCalledWith({ type: "attachment.storage.cleanup" });
  await waitFor(() => expect(remove).toHaveFocus());
  fireEvent.click(screen.getByRole("checkbox"));
  expect(onUpdate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Allow automatic removal" }));
  await waitFor(() => expect(onUpdate).toHaveBeenCalledWith({ autoRemoveOldAttachments: true }));
  await waitFor(() => expect(screen.getByRole("checkbox")).toHaveFocus());
});

it("returns keyboard focus to the panel after failed updates and when cleanup leaves nothing removable", async () => {
  const request = vi.fn(async ({ type }: { type: string }) => type === "attachment.storage.cleanup"
    ? response({ records: 64, bytes: 80 * 1024 ** 2 }, 0) : response());
  const onUpdate = vi.fn().mockRejectedValue(new Error("fixture update failed"));
  render(<AttachmentStorageSettings settings={defaultSettings} disabled={false} request={request} onUpdate={onUpdate} />);
  const checkbox = screen.getByRole("checkbox");
  await screen.findByRole("button", { name: /Remove oldest files \(64/u });
  fireEvent.click(checkbox);
  fireEvent.click(screen.getByRole("button", { name: "Allow automatic removal" }));
  expect(await screen.findByText(/Storage operation did not finish/u)).toBeVisible();
  await waitFor(() => expect(checkbox).toHaveFocus());
  fireEvent.click(screen.getByRole("button", { name: /Remove oldest files \(64/u }));
  fireEvent.click(screen.getByRole("button", { name: "Remove stored files" }));
  expect(await screen.findByText("Removed 64 files and freed 80.0 MiB.")).toBeVisible();
  await waitFor(() => expect(screen.getByRole("button", { name: "Refresh storage" })).toHaveFocus());
});
