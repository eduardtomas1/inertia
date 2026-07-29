import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ChatAttachment,
  Conversation,
  ProviderInfo,
} from "../../src/shared/contracts";
import { nativeModelSelection } from "../../src/shared/model-routing";
import { Composer } from "../../src/renderer/src/components/Composer";

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
      reasoningEffort: "medium",
    }),
    continuationIdentity: null,
    model: "",
    reasoningEffort: "medium",
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
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
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
    onSend: async () => undefined,
    onUpdateConversation: () => undefined,
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
    onProbeBackendProfile: async () => undefined,
    onUsageDisplayModeChange: () => undefined,
    onStop: async () => undefined,
    ...overrides,
  };
}

afterEach(() => {
  window.localStorage.clear();
});

describe("composer asynchronous ownership", () => {
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
});
