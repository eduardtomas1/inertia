import * as XLSX from "xlsx";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ComposerAttachmentList } from "../../src/renderer/src/components/ComposerAttachmentList";
import type { ChatAttachment } from "../../src/shared/contracts";

function attachment(
  update: Partial<ChatAttachment> = {},
): ChatAttachment {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "forecast.xlsx",
    path: "/private/path-must-not-render/forecast.xlsx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    size: 1_024,
    ...update,
  };
}

function workbookBytes(bookType: "xlsx" | "xls" = "xlsx"): Uint8Array {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["Region", "Revenue"],
      ["North", 1_200],
    ]),
    "Overview",
  );
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([["Owner"], ["Ada"]]),
    "Notes",
  );
  return XLSX.write(workbook, {
    type: "buffer",
    bookType,
  }) as Uint8Array;
}

function previewResponse(bytes: Uint8Array, mimeType: string, truncated = false): Response {
  const body = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(body).set(bytes);
  return new Response(body, {
    status: 200,
    headers: {
      "content-length": String(bytes.byteLength),
      "content-type": mimeType,
      ...(truncated ? { "x-attachment-truncated": "true" } : {}),
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("document attachment previews", () => {
  it.each([
    Buffer.from("Name\nRésumé 東京\n"),
    Buffer.from("\ufeffName\nRésumé 東京\n", "utf16le").swap16(),
  ])("preserves non-ASCII CSV cells in the table preview", async (bytes) => {
    vi.stubGlobal("fetch", vi.fn(async () => previewResponse(bytes, "text/csv")));
    const user = userEvent.setup();
    render(<ComposerAttachmentList attachments={[attachment({ name: "unicode.csv", mimeType: "text/csv", size: bytes.length })]} onRemove={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Preview attachment unicode.csv" }));
    expect(await screen.findByRole("table")).toHaveTextContent("Résumé 東京");
  });

  it.each([
    ["notes.txt", Buffer.from("\ufeffRésumé 東京\n", "utf16le"), "Résumé 東京"],
    ["app.log", Buffer.from("\x1b[31mERROR\x1b[0m: disk full\n"), "ERROR: disk full"],
  ])("previews %s with the shared text decoding", async (name, bytes, text) => {
    vi.stubGlobal("fetch", vi.fn(async () => previewResponse(bytes, "text/plain")));
    const user = userEvent.setup();
    render(<ComposerAttachmentList attachments={[attachment({ name, mimeType: "text/plain", size: bytes.length })]} onRemove={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: `Preview attachment ${name}` }));
    await waitFor(() => expect(screen.getByLabelText(`Text preview of ${name}`)).toHaveTextContent(text));
    expect(screen.getByLabelText(`Text preview of ${name}`).textContent).not.toContain("\x1b");
  });
  it("projects document visibility onto the body-level preview portal", async () => {
    let visibility: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get")
      .mockImplementation(() => visibility);
    vi.stubGlobal("fetch", vi.fn(async () => await new Promise<Response>(() => {})));
    const user = userEvent.setup();
    render(
      <ComposerAttachmentList attachments={[attachment()]} onRemove={vi.fn()} />,
    );

    await user.click(screen.getByRole("button", {
      name: "Preview attachment forecast.xlsx",
    }));
    await screen.findByRole("dialog", { name: "forecast.xlsx" });
    const portal = document.querySelector(".attachment-preview-backdrop");
    expect(portal).toHaveAttribute("data-document-visible", "true");
    expect(portal?.parentElement).toBe(document.body);

    visibility = "hidden";
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(portal).toHaveAttribute("data-document-visible", "false");
  });

  it("renders bounded workbook sheets and cells only after the user opens it", async () => {
    const bytes = workbookBytes();
    const fetchPreview = vi.fn(async () => previewResponse(
      bytes,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ));
    vi.stubGlobal("fetch", fetchPreview);
    const user = userEvent.setup();
    const workbook = attachment({ size: bytes.byteLength });
    const { container } = render(
      <ComposerAttachmentList attachments={[workbook]} onRemove={vi.fn()} />,
    );

    expect(fetchPreview).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain(workbook.path);
    await user.click(screen.getByRole("button", {
      name: "Preview attachment forecast.xlsx",
    }));

    expect(await screen.findByRole("table", {
      name: "forecast.xlsx · Overview",
    })).toHaveTextContent("North");
    expect(screen.getByRole("button", { name: "Overview" }))
      .toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("2 rows · 2 columns · 2 sheets"))
      .toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Notes" }));
    expect(await screen.findByRole("table", {
      name: "forecast.xlsx · Notes",
    })).toHaveTextContent("Ada");
    expect(screen.getByText("2 rows · 1 column · 2 sheets")).toBeInTheDocument();
    expect(fetchPreview).toHaveBeenCalledWith(
      `inertia://bundle/attachment-preview/${workbook.id}`,
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("shows JSON as inert formatted text without rendering provider markup", async () => {
    const bytes = new TextEncoder().encode(
      '{"markup":"<img src=x onerror=alert(1)>","safe":true}',
    );
    vi.stubGlobal("fetch", vi.fn(async () => previewResponse(
      bytes,
      "application/json",
    )));
    const user = userEvent.setup();
    const json = attachment({
      name: "evidence.json",
      mimeType: "application/json",
      size: bytes.byteLength,
    });
    const { container } = render(
      <ComposerAttachmentList attachments={[json]} onRemove={vi.fn()} />,
    );

    await user.click(screen.getByRole("button", {
      name: "Preview attachment evidence.json",
    }));

    await waitFor(() => {
      expect(container.ownerDocument.querySelector(".text-attachment-preview"))
        .toHaveTextContent('"safe": true');
    });
    expect(screen.getByLabelText("Text preview of evidence.json"))
      .toBeInTheDocument();
    expect(container.ownerDocument.querySelector(".text-attachment-preview img"))
      .toBeNull();
  });

  it("traps workbook-preview focus and restores its trigger on Escape", async () => {
    const bytes = workbookBytes();
    vi.stubGlobal("fetch", vi.fn(async () => previewResponse(
      bytes,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )));
    const user = userEvent.setup();
    render(
      <ComposerAttachmentList
        attachments={[attachment({ size: bytes.byteLength })]}
        onRemove={vi.fn()}
      />,
    );
    const trigger = screen.getByRole("button", {
      name: "Preview attachment forecast.xlsx",
    });

    await user.click(trigger);
    const close = await screen.findByRole("button", {
      name: "Close preview of forecast.xlsx",
    });
    await waitFor(() => expect(close).toHaveFocus());
    expect(await screen.findByRole("group", { name: "Workbook sheets" }))
      .toBeInTheDocument();
    const worksheet = screen.getByLabelText(
      "Scrollable worksheet preview for Overview",
    );

    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(worksheet).toHaveFocus();
    await user.keyboard("{Tab}");
    expect(close).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(trigger).toHaveFocus();
  });

  it.each([
    {
      name: "legacy.xls",
      mimeType: "application/vnd.ms-excel",
      bytes: workbookBytes("xls"),
    },
  ] satisfies Array<{
    name: string;
    mimeType: ChatAttachment["mimeType"];
    bytes: Uint8Array;
  }>)("renders $name through the spreadsheet table preview", async ({
    name,
    mimeType,
    bytes,
  }) => {
    vi.stubGlobal("fetch", vi.fn(async () => previewResponse(bytes, mimeType)));
    const user = userEvent.setup();
    render(
      <ComposerAttachmentList
        attachments={[attachment({ name, mimeType, size: bytes.byteLength })]}
        onRemove={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", {
      name: `Preview attachment ${name}`,
    }));

    expect(await screen.findByRole("table")).toHaveTextContent("North");
  });

  it("fails closed when the opaque preview response MIME does not match", async () => {
    const bytes = workbookBytes();
    vi.stubGlobal("fetch", vi.fn(async () => previewResponse(
      bytes,
      "text/plain",
    )));
    const user = userEvent.setup();
    render(
      <ComposerAttachmentList
        attachments={[attachment({ size: bytes.byteLength })]}
        onRemove={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", {
      name: "Preview attachment forecast.xlsx",
    }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Preview unavailable",
    );
  });

  it("keeps the attachment dialog visible with an explicit failure fallback", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Not found", {
      status: 404,
    })));
    const user = userEvent.setup();
    render(
      <ComposerAttachmentList
        attachments={[attachment()]}
        onRemove={vi.fn()}
      />,
    );

    const trigger = screen.getByRole("button", {
      name: "Preview attachment forecast.xlsx",
    });
    await user.click(trigger);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Preview unavailable",
    );
    expect(screen.getByRole("dialog", { name: "forecast.xlsx" }))
      .toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(trigger).toHaveFocus();
  });

  it("keeps the truncated-text notice in its own row below the scrollable preview", async () => {
    const bytes = Buffer.from("INFO first megabyte\n");
    vi.stubGlobal("fetch", vi.fn(async () => previewResponse(bytes, "text/plain", true)));
    const user = userEvent.setup();
    render(<ComposerAttachmentList attachments={[attachment({ name: "service.log", mimeType: "text/plain", size: 4 * 1024 * 1024 })]} onRemove={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Preview attachment service.log" }));
    const notice = await screen.findByText("Showing the first 1 MiB. The complete file is saved and available to the agent.");
    expect(notice).toHaveAttribute("role", "status");
    expect(notice).toHaveClass("text-attachment-preview-notice");
    const frame = notice.parentElement;
    expect(frame).toHaveClass("text-attachment-preview-frame");
    expect(frame?.firstElementChild).toBe(screen.getByLabelText("Text preview of service.log"));
    expect(frame?.lastElementChild).toBe(notice);
  });

  it("states a truncated CSV source once, in the workbook note row", async () => {
    const bytes = Buffer.from("Region,Revenue\nNorth,1200\n");
    vi.stubGlobal("fetch", vi.fn(async () => previewResponse(bytes, "text/csv", true)));
    const user = userEvent.setup();
    render(<ComposerAttachmentList attachments={[attachment({ name: "export.csv", mimeType: "text/csv", size: 4 * 1024 * 1024 })]} onRemove={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Preview attachment export.csv" }));
    expect(await screen.findByRole("table")).toHaveTextContent("North");
    const notice = screen.getByRole("status");
    expect(notice).toHaveClass("spreadsheet-attachment-limit-note");
    expect(notice).toHaveTextContent("Showing the first 1 MiB.");
    expect(screen.queryByText(/Preview is bounded for responsiveness/u)).toBeNull();
  });

  it("presents an opaque file as saved, with a generic file icon and its full name", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const user = userEvent.setup();
    const name = "build-cache-darwin-arm64-with-a-very-long-descriptive-name.tar.zst";
    render(<ComposerAttachmentList attachments={[attachment({ name, mimeType: "application/octet-stream", size: 14 })]} onRemove={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: `Preview attachment ${name}` });
    expect(trigger.querySelector(".lucide-file")).not.toBeNull();
    expect(trigger.querySelector(".lucide-file-text")).toBeNull();
    expect(screen.getByText(name, { exact: true })).toHaveAttribute("title", name);
    await user.click(trigger);
    const dialog = await screen.findByRole("dialog", { name });
    expect(dialog.querySelector(".attachment-preview-header .lucide-file")).not.toBeNull();
    const block = dialog.querySelector(".attachment-preview-unavailable");
    expect(block).not.toBeNull();
    expect(block?.querySelector("strong")).toHaveTextContent("No preview for this file type");
    expect(block).toHaveTextContent("The complete file is saved. The agent can read or search it with file tools.");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});
