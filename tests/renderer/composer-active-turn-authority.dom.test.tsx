import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChatAttachment } from "../../src/shared/contracts";
import { Composer } from "../../src/renderer/src/components/Composer";
import type { ComposerProps } from "../../src/renderer/src/components/composer/types";
import type { ComposerAttachmentImportLease } from "../../src/renderer/src/utils/composerAttachments";

import { composerProps, conversation, deferred } from "./composer-fixtures";

type LatestTurn = NonNullable<ComposerProps["latestTurn"]>;
type LatestTurnSummary = NonNullable<ComposerProps["latestTurnSummary"]>;

function image(id: string): ChatAttachment {
  return {
    id,
    name: `${id}.png`,
    path: `/private/tmp/${id}.png`,
    mimeType: "image/png",
    size: 128,
  };
}

function summary(id: string): LatestTurnSummary {
  return {
    ...({} as LatestTurnSummary),
    id,
    status: "running",
    harnessId: "codex-app-server",
  };
}

function loadedTurn(id: string): LatestTurn {
  return {
    ...({} as LatestTurn),
    id,
    status: "running",
    harnessId: "codex-app-server",
  };
}

function pasteImage(input: HTMLElement): File[] {
  const files = [new File(["image"], "pasted.png", { type: "image/png" })];
  fireEvent.paste(input, { clipboardData: { files } });
  return files;
}

afterEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("composer active-turn authority", () => {
  it("keeps an image pasted before the active turn's detail finishes loading", async () => {
    const current = conversation("61616161-6161-4161-8161-616161616161");
    const pasted = image("pasted-while-detail-loads");
    const imported = deferred<ComposerAttachmentImportLease>();
    const commit = vi.fn(async () => undefined);
    const cancel = vi.fn(async () => undefined);
    const props = composerProps(current, {
      running: true,
      latestTurn: null,
      latestTurnSummary: summary("turn-live"),
      onImportAttachments: () => imported.promise,
    });
    const view = render(<Composer {...props} />);

    pasteImage(screen.getByRole("textbox", { name: "Message" }));
    view.rerender(<Composer {...props} latestTurn={loadedTurn("turn-live")} />);
    await act(async () => imported.resolve({ attachments: [pasted], commit, cancel }));

    await waitFor(() => expect(commit).toHaveBeenCalledExactlyOnceWith([pasted.id]));
    expect(cancel).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: `Remove attachment ${pasted.name}` }))
      .toBeVisible();
  });

  it("steers an image follow-up before the active turn's detail finishes loading", async () => {
    const current = conversation("62626262-6262-4262-8262-626262626262");
    const pasted = image("steered-before-detail");
    const onSend = vi.fn(async () => undefined);
    render(<Composer {...composerProps(current, {
      running: true,
      latestTurn: null,
      latestTurnSummary: summary("turn-live"),
      onImportAttachments: async () => ({
        attachments: [pasted],
        commit: async () => undefined,
        cancel: async () => undefined,
      }),
      onSend,
    })} />);
    const input = screen.getByRole("textbox", { name: "Message" });

    pasteImage(input);
    await waitFor(() => expect(screen.getByRole("button", {
      name: `Remove attachment ${pasted.name}`,
    })).toBeEnabled());
    fireEvent.change(input, { target: { value: "Steer with this image." } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(onSend).toHaveBeenCalledExactlyOnceWith(
      "Steer with this image.",
      [pasted],
      undefined,
    ));
  });

  it("still cancels a paste that settles after the active turn changes", async () => {
    const current = conversation("63636363-6363-4363-8363-636363636363");
    const pasted = image("pasted-for-previous-turn");
    const imported = deferred<ComposerAttachmentImportLease>();
    const commit = vi.fn(async () => undefined);
    const cancel = vi.fn(async () => undefined);
    const props = composerProps(current, {
      running: true,
      latestTurn: loadedTurn("turn-a"),
      latestTurnSummary: summary("turn-a"),
      onImportAttachments: () => imported.promise,
    });
    const view = render(<Composer {...props} />);

    pasteImage(screen.getByRole("textbox", { name: "Message" }));
    view.rerender(<Composer {...props} latestTurnSummary={summary("turn-b")} />);
    await act(async () => imported.resolve({ attachments: [pasted], commit, cancel }));

    await waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(commit).not.toHaveBeenCalled();
    expect(screen.queryByText(pasted.name)).not.toBeInTheDocument();
  });
});
