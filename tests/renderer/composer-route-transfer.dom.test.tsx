import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Composer } from "../../src/renderer/src/components/Composer";
import {
  clearPersistedComposerDraft,
  persistComposerDraft,
  readComposerDraft,
} from "../../src/renderer/src/utils/composerDraftPersistence";

import { composerProps, conversation, routedProvider } from "./composer-fixtures";

vi.mock("../../src/renderer/src/utils/modelRouteTransition", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/renderer/src/utils/modelRouteTransition")>();
  return {
    ...actual,
    resolveModelRouteTransition: (
      ...parameters: Parameters<typeof actual.resolveModelRouteTransition>
    ) => ({
      ...actual.resolveModelRouteTransition(...parameters),
      kind: "create-new-conversation",
      providerSessionDisposition: "start-unbound",
      continuationAction: "new-conversation-required",
      reason: "This route needs a new chat.",
    }),
  };
});

const storageSpies: { mockRestore: () => void }[] = [];

afterEach(() => {
  for (const spy of storageSpies.splice(0)) spy.mockRestore();
  window.localStorage.clear();
});

type RouteOptions = { prefillText?: string; onCreated?: (conversationId: string) => void };

async function confirmNewChat(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: /Choose model/u }));
  fireEvent.click(screen.getByTitle("Routed Agent").closest("button")!);
  fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
}

describe("composer route transfer", () => {
  it.each([
    ["before", true],
    ["after", false],
  ] as const)("moves the draft exactly once when the composer switches %s the new chat is created", async (_label, switchFirst) => {
    const source = conversation("route-transfer-source");
    const target = conversation("route-transfer-target");
    const text = "Carry this request into the new chat";
    let view!: ReturnType<typeof render>;
    const showTarget = (): void => {
      view.rerender(<Composer {...composerProps(target, { providers: [routedProvider], onCreateConversationForSelection })} />);
    };
    const onCreateConversationForSelection = vi.fn(async (
      options?: RouteOptions,
    ): Promise<void> => {
      if (options?.prefillText) persistComposerDraft(target.id, options.prefillText);
      options?.onCreated?.(target.id);
      if (switchFirst) act(showTarget);
    });
    view = render(<Composer {...composerProps(source, { providers: [routedProvider], onCreateConversationForSelection })} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: text } });

    await confirmNewChat();
    await waitFor(() => expect(onCreateConversationForSelection).toHaveBeenCalledOnce());
    expect(onCreateConversationForSelection.mock.calls[0]![0]).toMatchObject({ prefillText: text });
    await act(async () => { await Promise.resolve(); });
    if (!switchFirst) act(showTarget);

    await waitFor(() => expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue(text));
    expect(window.localStorage.getItem(`inertia:draft:${source.id}`)).toBeNull();
    expect(window.localStorage.getItem(`inertia:draft:${target.id}`)).toBe(text);
    if (switchFirst) {
      await waitFor(() => expect(screen.getByRole("textbox", { name: "Message" })).toHaveFocus());
    }
  });

  it("does not steal focus when another chat was selected before the new chat settles", async () => {
    const source = conversation("route-focus-source");
    const target = conversation("route-focus-target");
    const other = conversation("route-focus-other");
    window.localStorage.setItem(`inertia:draft:${other.id}`, "Other chat draft");
    let settle!: () => void;
    const onCreateConversationForSelection = vi.fn((
      options?: RouteOptions,
    ) => new Promise<void>((resolve) => {
      settle = () => {
        if (options?.prefillText) persistComposerDraft(target.id, options.prefillText);
        options?.onCreated?.(target.id);
        resolve();
      };
    }));
    const props = { providers: [routedProvider], onCreateConversationForSelection };
    const view = render(
      <>
        <button type="button">Elsewhere</button>
        <Composer {...composerProps(source, props)} />
      </>,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "Carry this over" } });
    await confirmNewChat();
    await waitFor(() => expect(onCreateConversationForSelection).toHaveBeenCalledOnce());

    view.rerender(
      <>
        <button type="button">Elsewhere</button>
        <Composer {...composerProps(other, props)} />
      </>,
    );
    const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
    elsewhere.focus();
    await act(async () => settle());
    await act(async () => {
      await new Promise((resolve) => window.requestAnimationFrame(() => resolve(undefined)));
    });

    expect(elsewhere).toHaveFocus();
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("Other chat draft");
    expect(window.localStorage.getItem(`inertia:draft:${other.id}`)).toBe("Other chat draft");
    expect(readComposerDraft(target.id)).toBe("Carry this over");
  });

  it.each([
    ["the same composer", false],
    ["a new composer", true],
  ] as const)("focuses the new chat's message box when %s shows it frames after creation", async (_label, remount) => {
    const source = conversation("route-late-source");
    const target = conversation("route-late-target");
    const onCreateConversationForSelection = vi.fn(async (options?: RouteOptions): Promise<void> => {
      options?.onCreated?.(target.id);
    });
    const props = { providers: [routedProvider], onCreateConversationForSelection };
    const view = render(<Composer key={source.id} {...composerProps(source, props)} />);
    await confirmNewChat();
    await waitFor(() => expect(onCreateConversationForSelection).toHaveBeenCalledOnce());
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    });
    expect(screen.getByRole("textbox", { name: "Message" })).not.toHaveFocus();

    view.rerender(<Composer key={remount ? target.id : source.id} {...composerProps(target, props)} />);

    await waitFor(() => expect(screen.getByRole("textbox", { name: "Message" })).toHaveFocus());
  });

  it("clears an unstored draft only when the cleared draft matches it", () => {
    storageSpies.push(vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("Storage is full.", "QuotaExceededError");
    }));
    persistComposerDraft("unstored-sent", "Handed-off text");
    persistComposerDraft("unstored-kept", "Handed-off text");

    clearPersistedComposerDraft("unstored-sent", "Handed-off text");
    clearPersistedComposerDraft("unstored-kept", "A different draft");
    expect(readComposerDraft("unstored-sent")).toBe("");
    expect(readComposerDraft("unstored-kept")).toBe("Handed-off text");

    persistComposerDraft("unstored-kept", "");
    expect(readComposerDraft("unstored-kept")).toBe("");
  });
});
