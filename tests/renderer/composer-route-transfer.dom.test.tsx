import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Composer } from "../../src/renderer/src/components/Composer";
import {
  clearPersistedComposerDraft,
  handOffComposerDraft,
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

afterEach(() => {
  window.localStorage.clear();
});

async function confirmNewChat(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: /Choose model/u }));
  fireEvent.click(screen.getByTitle("Routed Agent").closest("button")!);
  fireEvent.click(await screen.findByRole("button", { name: "New chat" }));
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
      _selection: unknown,
      options?: { prefillText?: string },
    ): Promise<void> => {
      if (options?.prefillText) persistComposerDraft(target.id, options.prefillText);
      if (switchFirst) act(showTarget);
    });
    view = render(<Composer {...composerProps(source, { providers: [routedProvider], onCreateConversationForSelection })} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: text } });

    await confirmNewChat();
    await waitFor(() => expect(onCreateConversationForSelection).toHaveBeenCalledOnce());
    expect(onCreateConversationForSelection.mock.calls[0]![1]).toEqual({ prefillText: text });
    await act(async () => { await Promise.resolve(); });
    if (!switchFirst) act(showTarget);

    await waitFor(() => expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue(text));
    expect(window.localStorage.getItem(`inertia:draft:${source.id}`)).toBeNull();
    expect(window.localStorage.getItem(`inertia:draft:${target.id}`)).toBe(text);
  });

  it("releases an in-memory handoff once the composer accepts or replaces it", () => {
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("Storage is full.", "QuotaExceededError");
    });
    try {
      handOffComposerDraft("handoff-sent", "Handed-off text");
      handOffComposerDraft("handoff-kept", "Handed-off text");
      expect(readComposerDraft("handoff-sent")).toBe("Handed-off text");

      clearPersistedComposerDraft("handoff-sent", "Handed-off text");
      clearPersistedComposerDraft("handoff-kept", "A different draft");
      expect(readComposerDraft("handoff-sent")).toBe("");
      expect(readComposerDraft("handoff-kept")).toBe("Handed-off text");

      persistComposerDraft("handoff-kept", "");
      expect(readComposerDraft("handoff-kept")).toBe("");
    } finally {
      vi.restoreAllMocks();
    }
  });
});
