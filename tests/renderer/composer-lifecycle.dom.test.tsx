import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ChatAttachment,
  Conversation,
  ProviderInfo,
  ServerEvent,
} from "../../src/shared/contracts";
import {
  continuationIdentityForSelection,
  nativeModelSelection,
} from "../../src/shared/model-routing";
import { Composer } from "../../src/renderer/src/components/Composer";
import {
  DRAFT_PERSISTENCE_DELAY_MS,
  DRAFT_PERSISTENCE_MAX_WAIT_MS,
} from "../../src/renderer/src/components/composer/Composer";
import { useAppRuntimeActions } from "../../src/renderer/src/hooks/useAppRuntimeActions";

const provider: ProviderInfo = {
  id: "codex",
  label: "Codex",
  command: "codex",
  available: true,
  version: "1.0.0",
  executable: "/opt/bin/codex",
  installState: "installed",
  authState: "authenticated",
  canRun: true,
  statusMessage: "Connected",
  models: [],
  rateLimits: [],
  metadataState: {
    models: {
      freshness: "unavailable",
      provenance: null,
      updatedAt: null,
      lastAttemptedAt: null,
      refreshing: false,
    },
    rateLimits: {
      freshness: "unavailable",
      provenance: null,
      updatedAt: null,
      lastAttemptedAt: null,
      refreshing: false,
    },
  },
};

function conversation(id: string): Conversation {
  return {
    id,
    projectId: "11111111-1111-4111-8111-111111111111",
    title: id,
    providerId: "codex",
    modelSelection: nativeModelSelection({
      providerId: "codex",
      modelId: "provider-default",
      reasoningEffort: null,
    }),
    continuationIdentity: null,
    model: "",
    reasoningEffort: "",
    interactionMode: "build",
    accessMode: "supervised",
    status: "idle",
    attentionKind: null,
    branch: "main",
    worktreePath: null,
    providerSessionId: null,
    archivedAt: null,
    settledAt: null,
    completedAt: null,
    lastViewedAt: null,
    createdAt: "2026-07-29T08:00:00.000Z",
    updatedAt: "2026-07-29T08:00:00.000Z",
  };
}

function attachment(id: string): ChatAttachment {
  return {
    id,
    name: `${id}.png`,
    path: `/private/tmp/${id}.png`,
    mimeType: "image/png",
    size: 128,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function composerProps(
  current: Conversation,
  overrides: Partial<React.ComponentProps<typeof Composer>> = {},
): React.ComponentProps<typeof Composer> {
  return {
    conversation: current,
    providers: [provider],
    actions: [],
    disabled: false,
    sending: false,
    running: false,
    mentionResults: [],
    usage: null,
    usageDisplayMode: "compact",
    skills: [],
    skillsCapability: null,
    selectedSkillIds: [],
    skillsLoading: false,
    skillsError: null,
    onSend: async () => undefined,
    onListSkills: async () => undefined,
    onToggleSkill: () => undefined,
    onClearSelectedSkills: () => undefined,
    onUpdateConversation: () => Promise.resolve(),
    onCreateConversationForSelection: async () => undefined,
    onChooseAttachments: async () => [],
    onImportAttachments: async () => [],
    onReleaseAttachment: async () => undefined,
    onRunAction: () => undefined,
    onMentionQuery: () => undefined,
    onConnectProvider: () => undefined,
    onRefreshProvider: () => undefined,
    onOpenProviderSetup: () => undefined,
    onOpenBackendSetup: () => undefined,
    onOpenResume: () => undefined,
    onProbeBackendProfile: async () => undefined,
    onUsageDisplayModeChange: () => undefined,
    onStop: async () => undefined,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
  window.localStorage.clear();
});

describe("composer asynchronous ownership", () => {
  it("opens goal and folder resume flows directly from slash commands", async () => {
    const current = conversation("08080808-0808-4808-8808-080808080808");
    const onOpenResume = vi.fn();
    render(<Composer {...composerProps(current, {
      running: true,
      onOpenResume,
      goal: {
        workflow: null,
        loading: false,
        busy: false,
        error: "Goal state is unavailable in this fixture.",
        onRetry: async () => undefined,
        onSetGoal: async () => undefined,
        onClearGoal: async () => undefined,
      },
    })} />);

    const input = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(input, { target: { value: "/" } });
    expect(screen.getByRole("listbox", { name: "Composer commands" }))
      .toHaveTextContent("/goal");
    expect(screen.getByRole("listbox", { name: "Composer commands" }))
      .toHaveTextContent("/resume");
    expect(screen.getByRole("option", { name: /\/plan/u })).toBeDisabled();
    expect(screen.getByRole("option", { name: /\/build/u })).toBeDisabled();

    fireEvent.change(input, { target: { value: "/resume" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onOpenResume).toHaveBeenCalledTimes(1);
    expect(input).toHaveValue("");

    fireEvent.change(input, { target: { value: "/goal" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByRole("region", { name: "Goal" })).toBeVisible();
    expect(input).toHaveValue("");
  });

  it("keeps the inline goal visible when another workspace control receives focus", async () => {
    const current = conversation("18181818-1818-4818-8818-181818181818");
    render(
      <>
        <Composer {...composerProps(current, {
          goal: {
            workflow: null,
            loading: false,
            busy: false,
            error: "Goal state is unavailable in this fixture.",
            onRetry: async () => undefined,
            onSetGoal: async () => undefined,
            onClearGoal: async () => undefined,
          },
        })} />
        <button type="button">Open another pane</button>
      </>,
    );

    const input = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(input, { target: { value: "/goal" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByRole("region", { name: "Goal" })).toBeVisible();

    const outside = screen.getByRole("button", { name: "Open another pane" });
    fireEvent.pointerDown(outside);
    outside.focus();

    expect(screen.getByRole("region", { name: "Goal" })).toBeVisible();
    expect(outside).toHaveFocus();
  });

  it("submits reasoning as a complete selection and keeps the control open on failure", async () => {
    const current = conversation("09090909-0909-4909-8909-090909090909");
    current.modelSelection = nativeModelSelection({
      providerId: "codex",
      modelId: "gpt-route",
      alias: "GPT Route",
      reasoningEffort: "medium",
    });
    current.model = "gpt-route";
    current.reasoningEffort = "medium";
    const reasoningProvider: ProviderInfo = {
      ...provider,
      models: [{
        id: "gpt-route",
        label: "GPT Route",
        description: "A model with authoritative reasoning choices",
        isDefault: true,
        inputModalities: ["text"],
        reasoningOptions: [
          { value: "medium", label: "Medium", description: "Balanced" },
          { value: "high", label: "High", description: "Deep" },
        ],
        defaultReasoningEffort: "medium",
      }],
    };
    const update = deferred<void>();
    const onUpdateConversation = vi.fn(() => update.promise);
    render(<Composer {...composerProps(current, {
      providers: [reasoningProvider],
      onUpdateConversation,
    })} />);

    fireEvent.click(screen.getByRole("button", {
      name: "Choose reasoning level. Current level: Medium.",
    }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /High/u }));

    expect(onUpdateConversation).toHaveBeenCalledExactlyOnceWith({
      modelSelection: {
        ...current.modelSelection,
        reasoningEffort: "high",
      },
    });
    expect(screen.getByRole("menu", { name: "Reasoning level" }))
      .toBeInTheDocument();

    await act(async () => update.reject(new Error("Reasoning update rejected")));
    expect(screen.getByRole("menu", { name: "Reasoning level" }))
      .toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Reasoning update rejected",
    );
  });

  it("binds new-chat confirmation, transfers text, and supports failure retry", async () => {
    const current = conversation("route-source");
    current.modelSelection = nativeModelSelection({
      providerId: "codex",
      modelId: "codex-route",
      alias: "Codex Route",
      reasoningEffort: "high",
    });
    current.model = "codex-route";
    current.reasoningEffort = "high";
    current.continuationIdentity = continuationIdentityForSelection(
      current.modelSelection,
    );
    current.providerSessionId = "codex-session";
    const catalogState = {
      freshness: "fresh" as const,
      provenance: "provider" as const,
      updatedAt: "2026-08-01T00:00:00.000Z",
      lastAttemptedAt: "2026-08-01T00:00:00.000Z",
      refreshing: false,
    };
    const codexProvider: ProviderInfo = {
      ...provider,
      models: [{
        id: "codex-route",
        label: "Codex Route",
        description: "Current route",
        isDefault: true,
        inputModalities: ["text"],
        reasoningOptions: [{ value: "high", label: "High", description: "" }],
        defaultReasoningEffort: "high",
      }],
      metadataState: { models: catalogState, rateLimits: catalogState },
    };
    const claudeProvider: ProviderInfo = {
      ...codexProvider,
      id: "claude",
      label: "Claude",
      models: [{
        ...codexProvider.models[0]!,
        id: "claude-route",
        label: "Claude Route",
        description: "Destination route",
      }],
    };
    const onCreateConversationForSelection = vi.fn()
      .mockRejectedValueOnce(new Error("Creation failed safely."))
      .mockResolvedValueOnce(undefined);
    render(<Composer {...composerProps(current, {
      providers: [codexProvider, claudeProvider],
      latestTurnSummary: {
        id: "turn-source",
        runId: "run-source",
        status: "completed",
        providerId: "codex",
        harnessId: current.modelSelection.harnessId,
        backendProfileId: current.modelSelection.backendProfileId,
        modelSelection: current.modelSelection,
        continuationIdentity: current.continuationIdentity,
        model: current.modelSelection.modelId,
        reasoningEffort: "high",
        requestedAt: current.createdAt,
        startedAt: current.createdAt,
        completedAt: current.updatedAt,
        terminalReason: null,
        updatedAt: current.updatedAt,
      },
      onCreateConversationForSelection,
    })} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "Carry this exact text." },
    });
    fireEvent.click(screen.getByRole("button", { name: /Choose model/u }));
    fireEvent.click(screen.getByRole("button", { name: "Claude, 2 models" }));
    const claudeRoute = screen.getByTitle("Claude Route").closest("button");
    if (!claudeRoute) throw new Error("Expected the Claude route action.");
    fireEvent.click(claudeRoute);

    const confirmation = screen.getByRole("alertdialog");
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" }))
      .toHaveFocus());
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    await waitFor(() => expect(confirmation).toHaveTextContent(
      "Creation failed safely.",
    ));
    expect(screen.getByRole("textbox", { name: "Message" }))
      .toHaveValue("Carry this exact text.");

    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    await waitFor(() => expect(onCreateConversationForSelection)
      .toHaveBeenCalledTimes(2));
    expect(onCreateConversationForSelection.mock.calls[1]?.[0]).toMatchObject({
      modelId: "claude-route",
    });
    expect(onCreateConversationForSelection.mock.calls[1]?.[1]).toEqual({
      prefillText: "Carry this exact text.",
    });
    await waitFor(() => expect(screen.queryByRole("alertdialog"))
      .not.toBeInTheDocument());
  });

  it("makes the leading draft durable, bounds trailing loss, and flushes ownership boundaries", async () => {
    vi.useFakeTimers();
    const first = conversation("10101010-1010-4010-8010-101010101010");
    const second = conversation("20202020-2020-4020-8020-202020202020");
    window.localStorage.setItem(
      `inertia:draft:${second.id}`,
      "Owned by the second chat",
    );
    const view = render(<Composer {...composerProps(first)} />);
    const editor = screen.getByRole("textbox", { name: "Message" });

    fireEvent.change(editor, { target: { value: "a" } });
    expect(window.localStorage.getItem(`inertia:draft:${first.id}`)).toBe("a");
    fireEvent.change(editor, { target: { value: "ab" } });
    fireEvent.change(editor, { target: { value: "abc" } });
    expect(window.localStorage.getItem(`inertia:draft:${first.id}`)).toBe("a");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DRAFT_PERSISTENCE_DELAY_MS - 1);
    });
    expect(window.localStorage.getItem(`inertia:draft:${first.id}`)).toBe("a");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(window.localStorage.getItem(`inertia:draft:${first.id}`)).toBe("abc");

    fireEvent.change(editor, { target: { value: "continuous-0" } });
    for (let index = 1; index < 5; index += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      fireEvent.change(editor, { target: { value: `continuous-${index}` } });
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        DRAFT_PERSISTENCE_MAX_WAIT_MS - (4 * 200) - 1,
      );
    });
    expect(window.localStorage.getItem(`inertia:draft:${first.id}`)).toBe("abc");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(window.localStorage.getItem(`inertia:draft:${first.id}`))
      .toBe("continuous-4");

    fireEvent.change(editor, { target: { value: "flush on switch" } });
    view.rerender(<Composer {...composerProps(second)} />);
    expect(window.localStorage.getItem(`inertia:draft:${first.id}`))
      .toBe("flush on switch");
    expect(screen.getByRole("textbox", { name: "Message" }))
      .toHaveValue("Owned by the second chat");

    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "flush before unload" },
    });
    window.dispatchEvent(new Event("beforeunload"));
    expect(window.localStorage.getItem(`inertia:draft:${second.id}`))
      .toBe("flush before unload");

    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "flush on unmount" },
    });
    view.unmount();
    expect(window.localStorage.getItem(`inertia:draft:${second.id}`))
      .toBe("flush on unmount");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns conversation-update failures to the control that initiated them", async () => {
    const request = deferred<ServerEvent>();
    const setActionError = vi.fn();
    const hook = renderHook(() => useAppRuntimeActions({
      sendCommand: () => request.promise,
      refreshDetail: vi.fn(),
      setBusyAction: vi.fn(),
      setActionError,
    }));

    const update = hook.result.current.updateConversationById(
      "19191919-1919-4919-8919-191919191919",
      { accessMode: "auto-edit" },
    );
    const rejection = expect(update).rejects.toThrow(
      "Runtime rejected access",
    );
    await act(async () => request.reject(new Error("Runtime rejected access")));

    await rejection;
    expect(setActionError).toHaveBeenCalledWith("Runtime rejected access");
  });

  it("keeps access changes pending until the runtime acknowledges them", async () => {
    const update = deferred<void>();
    const onUpdateConversation = vi.fn(() => update.promise);
    render(<Composer {...composerProps(
      conversation("20202020-2020-4020-8020-202020202020"),
      { onUpdateConversation },
    )} />);

    fireEvent.click(screen.getByRole("button", {
      name: "Choose project access. Current access: Supervised.",
    }));
    expect(screen.getByText(
      "Use this provider's restricted mode and native approvals",
    )).toBeInTheDocument();
    expect(screen.getByText(
      "Allow edits; other actions follow the provider's policy",
    )).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitemradio", {
      name: /Auto-accept edits/,
    }));

    expect(onUpdateConversation).toHaveBeenCalledExactlyOnceWith({
      accessMode: "auto-edit",
    });
    expect(screen.getByRole("menuitemradio", {
      name: /Auto-accept edits/,
    })).toBeDisabled();

    await act(async () => update.reject(new Error("Access update rejected")));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Access update rejected",
    );
    expect(screen.getByRole("menuitemradio", {
      name: /Auto-accept edits/,
    })).not.toBeDisabled();
  });

  it("releases a late attachment picker result instead of moving it to another chat", async () => {
    const first = conversation("22222222-2222-4222-8222-222222222222");
    const second = conversation("33333333-3333-4333-8333-333333333333");
    const picked = deferred<ChatAttachment[]>();
    const release = vi.fn(async () => undefined);
    const view = render(<Composer {...composerProps(first, {
      onChooseAttachments: () => picked.promise,
      onReleaseAttachment: release,
    })} />);

    fireEvent.click(screen.getByRole("button", {
      name: "Attach images or documents",
    }));
    view.rerender(<Composer {...composerProps(second, {
      onChooseAttachments: () => picked.promise,
      onReleaseAttachment: release,
    })} />);
    await act(async () => picked.resolve([attachment("late-picker")]));

    await waitFor(() => expect(release).toHaveBeenCalledExactlyOnceWith(
      "late-picker",
    ));
    expect(screen.queryByText("late-picker.png")).toBeNull();
  });

  it("releases a late imported attachment after the composer unmounts", async () => {
    const imported = deferred<ChatAttachment[]>();
    const release = vi.fn(async () => undefined);
    const view = render(<Composer {...composerProps(
      conversation("44444444-4444-4444-8444-444444444444"),
      {
        onImportAttachments: () => imported.promise,
        onReleaseAttachment: release,
      },
    )} />);

    fireEvent.drop(screen.getByLabelText("Message composer"), {
      dataTransfer: {
        files: [new File(["image"], "source.png", { type: "image/png" })],
        types: ["Files"],
      },
    });
    view.unmount();
    await act(async () => imported.resolve([attachment("late-import")]));

    await waitFor(() => expect(release).toHaveBeenCalledExactlyOnceWith(
      "late-import",
    ));
  });

  it("removes only the submitted draft after a successful navigated-away send", async () => {
    const first = conversation("55555555-5555-4555-8555-555555555555");
    const second = conversation("66666666-6666-4666-8666-666666666666");
    const sent = deferred<void>();
    const view = render(<Composer {...composerProps(first, {
      onSend: () => sent.promise,
    })} />);

    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "Send this once" },
    });
    await waitFor(() => expect(window.localStorage.getItem(
      `inertia:draft:${first.id}`,
    )).toBe("Send this once"));
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    view.rerender(<Composer {...composerProps(second, {
      onSend: () => sent.promise,
    })} />);
    await act(async () => sent.resolve());
    view.rerender(<Composer {...composerProps(first)} />);

    await waitFor(() => expect(
      screen.getByRole("textbox", { name: "Message" }),
    ).toHaveValue(""));
  });

  it("does not erase a newer persisted draft when an older send settles", async () => {
    const first = conversation("77777777-7777-4777-8777-777777777777");
    const second = conversation("88888888-8888-4888-8888-888888888888");
    const sent = deferred<void>();
    const view = render(<Composer {...composerProps(first, {
      onSend: () => sent.promise,
    })} />);

    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "Older submitted draft" },
    });
    await waitFor(() => expect(window.localStorage.getItem(
      `inertia:draft:${first.id}`,
    )).toBe("Older submitted draft"));
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    view.rerender(<Composer {...composerProps(second, {
      onSend: () => sent.promise,
    })} />);
    window.localStorage.setItem(
      `inertia:draft:${first.id}`,
      "Newer local draft",
    );
    await act(async () => sent.resolve());
    view.rerender(<Composer {...composerProps(first)} />);

    await waitFor(() => expect(
      screen.getByRole("textbox", { name: "Message" }),
    ).toHaveValue("Newer local draft"));
  });

  it("does not clear a newer draft after returning to the submitted chat", async () => {
    const first = conversation("99999999-9999-4999-8999-999999999999");
    const second = conversation("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const sent = deferred<void>();
    const chooseAttachments = vi.fn()
      .mockResolvedValueOnce([attachment("submitted")])
      .mockResolvedValueOnce([attachment("newer")]);
    const release = vi.fn(async () => undefined);
    const overrides = {
      onSend: () => sent.promise,
      onChooseAttachments: chooseAttachments,
      onReleaseAttachment: release,
    };
    const view = render(<Composer {...composerProps(first, overrides)} />);

    fireEvent.click(screen.getByRole("button", {
      name: "Attach images or documents",
    }));
    await screen.findByText("submitted.png");
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "Submitted draft" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    view.rerender(<Composer {...composerProps(second, overrides)} />);
    view.rerender(<Composer {...composerProps(first, overrides)} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "Submitted draft" },
    });
    fireEvent.click(screen.getByRole("button", {
      name: "Attach images or documents",
    }));
    await screen.findByText("newer.png");
    await act(async () => sent.resolve());

    expect(screen.getByRole("textbox", { name: "Message" }))
      .toHaveValue("Submitted draft");
    expect(screen.getByText("newer.png")).toBeTruthy();
    expect(release).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(`inertia:draft:${first.id}`))
      .toBe("Submitted draft");
  });

  it("does not restore stale state when a failed send returns to its chat", async () => {
    const first = conversation("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    const second = conversation("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
    const sent = deferred<void>();
    const chooseAttachments = vi.fn()
      .mockResolvedValueOnce([attachment("failed")])
      .mockResolvedValueOnce([attachment("newer")]);
    const release = vi.fn(async () => undefined);
    const overrides = {
      onSend: () => sent.promise,
      onChooseAttachments: chooseAttachments,
      onReleaseAttachment: release,
    };
    const view = render(<Composer {...composerProps(first, overrides)} />);

    fireEvent.click(screen.getByRole("button", {
      name: "Attach images or documents",
    }));
    await screen.findByText("failed.png");
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "Failed submitted draft" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    view.rerender(<Composer {...composerProps(second, overrides)} />);
    view.rerender(<Composer {...composerProps(first, overrides)} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "Newer retry draft" },
    });
    fireEvent.click(screen.getByRole("button", {
      name: "Attach images or documents",
    }));
    await screen.findByText("newer.png");
    await act(async () => sent.reject(new Error("send failed")));

    expect(screen.getByRole("textbox", { name: "Message" }))
      .toHaveValue("Newer retry draft");
    expect(screen.getByText("newer.png")).toBeTruthy();
    expect(screen.queryByText("failed.png")).toBeNull();
    await waitFor(() => expect(release).toHaveBeenCalledExactlyOnceWith(
      "failed",
    ));
    await waitFor(() => expect(
      window.localStorage.getItem(`inertia:draft:${first.id}`),
    ).toBe("Newer retry draft"));
    fireEvent.click(screen.getByRole("button", {
      name: "Remove attachment newer.png",
    }));
    expect(screen.queryByText("newer.png")).toBeNull();
    expect(screen.queryByText("failed.png")).toBeNull();
    await waitFor(() => expect(release).toHaveBeenCalledWith("newer"));
  });

  it("restores an unchanged failed submission after navigating away and back", async () => {
    const first = conversation("dddddddd-dddd-4ddd-8ddd-dddddddddddd");
    const second = conversation("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");
    const sent = deferred<void>();
    const release = vi.fn(async () => undefined);
    const overrides = {
      onSend: () => sent.promise,
      onChooseAttachments: async () => [attachment("retry")],
      onReleaseAttachment: release,
    };
    const view = render(<Composer {...composerProps(first, overrides)} />);

    fireEvent.click(screen.getByRole("button", {
      name: "Attach images or documents",
    }));
    await screen.findByText("retry.png");
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "Retry this submission" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(window.localStorage.getItem(`inertia:draft:${first.id}`))
      .toBe("Retry this submission");

    view.rerender(<Composer {...composerProps(second, overrides)} />);
    view.rerender(<Composer {...composerProps(first, overrides)} />);
    await act(async () => sent.reject(new Error("send failed")));

    expect(screen.getByRole("textbox", { name: "Message" }))
      .toHaveValue("Retry this submission");
    expect(screen.getByText("retry.png")).toBeTruthy();
    expect(release).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", {
      name: "Remove attachment retry.png",
    }));
    await waitFor(() => expect(release).toHaveBeenCalledExactlyOnceWith(
      "retry",
    ));
  });

  it("does not clear context added after an older submission", async () => {
    const first = conversation("ffffffff-ffff-4fff-8fff-ffffffffffff");
    const second = conversation("12121212-1212-4212-8212-121212121212");
    const sent = deferred<void>();
    const clearPromptContext = vi.fn();
    const overrides = {
      onSend: () => sent.promise,
      onClearPromptContext: clearPromptContext,
    };
    const view = render(<Composer {...composerProps(first, overrides)} />);

    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "Inspect this" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    view.rerender(<Composer {...composerProps(second, overrides)} />);
    view.rerender(<Composer {...composerProps(first, {
      ...overrides,
      promptContext: "Diff selection for src/index.ts",
    })} />);
    await act(async () => sent.resolve());

    expect(screen.getByLabelText("Selected diff context")).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Message" }))
      .toHaveValue("Inspect this");
    expect(clearPromptContext).not.toHaveBeenCalled();
  });

  it.each(["success", "failure"] as const)(
    "keeps the newest Stop claim pending after an older %s settlement",
    async (settlement) => {
      const first = conversation("34343434-3434-4434-8434-343434343434");
      const second = conversation("56565656-5656-4656-8656-565656565656");
      const firstStop = deferred<void>();
      const secondStop = deferred<void>();
      const onStop = vi.fn()
        .mockImplementationOnce(() => firstStop.promise)
        .mockImplementationOnce(() => secondStop.promise);
      const overrides = { running: true, onStop };
      const view = render(<Composer {...composerProps(first, overrides)} />);

      fireEvent.click(screen.getByRole("button", { name: "Stop agent" }));
      expect(screen.getByRole("button", { name: "Stopping agent" }))
        .toHaveAttribute("aria-busy", "true");
      view.rerender(<Composer {...composerProps(second, overrides)} />);
      view.rerender(<Composer {...composerProps(first, overrides)} />);
      fireEvent.click(screen.getByRole("button", { name: "Stop agent" }));
      expect(onStop).toHaveBeenCalledTimes(2);

      await act(async () => {
        if (settlement === "success") firstStop.resolve();
        else firstStop.reject(new Error("first stop failed"));
      });

      expect(screen.getByRole("button", { name: "Stopping agent" }))
        .toHaveAttribute("aria-busy", "true");
      await act(async () => secondStop.reject(new Error("second stop failed")));
      expect(screen.getByRole("button", { name: "Stop agent" })).toBeTruthy();
    },
  );
});
