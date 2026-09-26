import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { AttachmentStorageSettings } from "../../src/renderer/src/components/AttachmentStorageSettings";
import { defaultSettings, type ServerEvent } from "../../src/shared/contracts";

const storage = { state: "ready" as const, records: 70, bytes: 100 * 1024 ** 2,
  maxBytes: 16 * 1024 ** 3, maxRecords: 65_536, availableDiskBytes: 500 * 1024 ** 3,
  removableRecords: 64, removableBytes: 80 * 1024 ** 2 };
function response(removed?: { records: number; bytes: number }): ServerEvent {
  return { type: "request.result", requestId: "request", result: { kind: "attachment.storage", storage, removed } };
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
  fireEvent.click(screen.getByRole("checkbox"));
  expect(onUpdate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Allow automatic removal" }));
  await waitFor(() => expect(onUpdate).toHaveBeenCalledWith({ autoRemoveOldAttachments: true }));
});
