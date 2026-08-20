import * as XLSX from "xlsx";
import { render, screen, waitFor } from "@testing-library/react";
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

function previewResponse(bytes: Uint8Array, mimeType: string): Response {
  const body = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(body).set(bytes);
  return new Response(body, {
    status: 200,
    headers: {
      "content-length": String(bytes.byteLength),
      "content-type": mimeType,
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("document attachment previews", () => {
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
    {
      name: "forecast.csv",
      mimeType: "text/csv",
      bytes: new TextEncoder().encode("Region,Revenue\nNorth,1200\n"),
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
});
