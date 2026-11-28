import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  ConversationPane,
  type ConversationDetailWithQueue,
} from "../../src/renderer/private-connect/src/workspace/ConversationPane";
import type { PrivateConnectQueueProjection } from "../../src/renderer/private-connect/src/workspace/QueueSection";
import type { Shell } from "../../src/renderer/private-connect/src/types";

const conversationId = "10101010-1010-4010-8010-101010101010";

function makeShell(scopes: Shell["capabilities"]["scopes"]): Shell {
  return {
    generatedAt: "2026-11-26T00:00:00.000Z",
    projects: [{ id: "proj-1", name: "Inertia" }],
    conversations: [{
      id: conversationId,
      projectId: "proj-1",
      title: "Queue sync",
      providerLabel: "Claude",
      runId: "run-1",
      status: "running",
      pendingLocalApproval: false,
      pendingLocalAction: false,
      updatedAt: "2026-11-26T00:00:00.000Z",
    }],
    capabilities: {
      scopes,
      preset: scopes.includes("private:prompt") ? "collaborate" : "monitor",
      expiresAt: "2026-12-01T00:00:00.000Z",
    },
  };
}

function makeQueue(overrides: Partial<PrivateConnectQueueProjection> = {}): PrivateConnectQueueProjection {
  return {
    revision: 4,
    held: true,
    holdReason: "stopped",
    canResume: true,
    items: [
      {
        id: "item-text",
        content: "Check the logs next",
        attachmentCount: 0,
        state: "waiting",
        queueHeld: true,
        editRevision: 2,
        editable: true,
        sendLabel: "send-now",
        attribution: "device",
        modelLabel: "Claude Sonnet",
        error: null,
      },
      {
        id: "item-media",
        content: "Review attached spec",
        attachmentCount: 2,
        state: "waiting",
        queueHeld: true,
        editRevision: 1,
        editable: true,
        sendLabel: "none",
        attribution: "user",
        modelLabel: "GPT-5",
        error: null,
      },
    ],
    ...overrides,
  };
}

function makeDetail(overrides: Partial<ConversationDetailWithQueue> = {}): ConversationDetailWithQueue {
  return {
    generatedAt: "2026-11-26T00:00:00.000Z",
    conversation: {
      id: conversationId,
      projectId: "proj-1",
      title: "Queue sync",
      providerLabel: "Claude",
      runId: "run-1",
      status: "running",
      pendingLocalApproval: false,
      pendingLocalAction: false,
      updatedAt: "2026-11-26T00:00:00.000Z",
    },
    messages: [],
    questions: [],
    inputRequestId: null,
    waitingForLocalAction: false,
    queue: makeQueue(),
    ...overrides,
  };
}

describe("Private Connect QueueSection and ConversationPane", () => {
  it("renders a read-only queue with metadata and zero mutation controls in Monitor mode", () => {
    render(
      <ConversationPane
        shell={makeShell(["private:read"])}
        detail={makeDetail()}
        prompt=""
        busy={false}
        offline={false}
        messagesRef={createRef()}
        onScrollIntent={vi.fn()}
        onPromptChange={vi.fn()}
        onSendPrompt={vi.fn()}
        onAnswer={vi.fn()}
        onStopRun={vi.fn()}
      />,
    );

    const queueRegion = screen.getByRole("region", { name: "Queued messages" });
    expect(within(queueRegion).getByRole("status")).toHaveAttribute("aria-live", "polite");
    expect(within(queueRegion).getByText("Check the logs next")).toBeInTheDocument();
    expect(within(queueRegion).getByText("2 attachments")).toBeInTheDocument();
    expect(within(queueRegion).getByText("Claude Sonnet")).toBeInTheDocument();
    expect(within(queueRegion).getByText("From device")).toBeInTheDocument();
    expect(within(queueRegion).getByText("Queue paused · Stopped")).toBeInTheDocument();
    expect(within(queueRegion).queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByRole("textbox", { name: "Send a prompt" })).toBeNull();
  });

  it("enables Collaborate actions (Resume, Send now, text-only Edit, Remove), forbids sending/editing attachment items, never renders Stop and send, and offers no reorder controls", async () => {
    const onSendQueueItem = vi.fn(async () => undefined);
    const onEditQueueItem = vi.fn(async () => true);
    const onRemoveQueueItem = vi.fn(async () => undefined);
    const onResumeQueue = vi.fn(async () => undefined);

    render(
      <ConversationPane
        shell={makeShell(["private:read", "private:prompt", "private:stop"])}
        detail={makeDetail()}
        prompt=""
        busy={false}
        offline={false}
        messagesRef={createRef()}
        onScrollIntent={vi.fn()}
        onPromptChange={vi.fn()}
        onSendPrompt={vi.fn()}
        onAnswer={vi.fn()}
        onStopRun={vi.fn()}
        onSendQueueItem={onSendQueueItem}
        onEditQueueItem={onEditQueueItem}
        onRemoveQueueItem={onRemoveQueueItem}
        onResumeQueue={onResumeQueue}
      />,
    );

    expect(screen.getByPlaceholderText("Queue a follow-up prompt")).toBeInTheDocument();

    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    // Text-only item has Send now, Edit, Remove.
    expect(within(items[0]!).getByRole("button", { name: "Send now" })).toBeEnabled();
    expect(within(items[0]!).getByRole("button", { name: "Edit" })).toBeEnabled();
    expect(within(items[0]!).getByRole("button", { name: "Remove" })).toBeEnabled();
    // Item with attachments has Remove ONLY — NEVER Send now, Stop and send, or Edit.
    expect(within(items[1]!).queryByRole("button", { name: "Send now" })).toBeNull();
    expect(within(items[1]!).queryByRole("button", { name: "Stop and send" })).toBeNull();
    expect(within(items[1]!).queryByRole("button", { name: "Edit" })).toBeNull();
    expect(within(items[1]!).getByRole("button", { name: "Remove" })).toBeEnabled();
    // Zero reorder buttons (N13).
    expect(screen.queryByRole("button", { name: /\b(move|reorder|up|down)\b/iu })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(onResumeQueue).toHaveBeenCalledOnce();

    fireEvent.click(within(items[0]!).getByRole("button", { name: "Send now" }));
    expect(onSendQueueItem).toHaveBeenCalledWith("item-text");

    fireEvent.click(within(items[1]!).getByRole("button", { name: "Remove" }));
    expect(onRemoveQueueItem).toHaveBeenCalledWith("item-media");

    // Inline text-only edit submits expectedRevision and trimmed content.
    fireEvent.click(within(items[0]!).getByRole("button", { name: "Edit" }));
    const editBox = screen.getByRole("textbox", { name: "Edit queued message" });
    fireEvent.change(editBox, { target: { value: "  Updated logs check  " } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect(onEditQueueItem).toHaveBeenCalledWith("item-text", 2, "Updated logs check");
  });

  it("hides Resume when pending questions exist or desktop action is required", () => {
    const detail = makeDetail({
      waitingForLocalAction: true,
      questions: [{
        id: "q-1",
        label: "Which target?",
        allowCustomAnswer: false,
        allowMultiple: false,
        options: [{ id: "o-1", label: "Web" }],
      }],
    });
    render(
      <ConversationPane
        shell={makeShell(["private:read", "private:prompt"])}
        detail={detail}
        prompt=""
        busy={false}
        offline={false}
        messagesRef={createRef()}
        onScrollIntent={vi.fn()}
        onPromptChange={vi.fn()}
        onSendPrompt={vi.fn()}
        onAnswer={vi.fn()}
        onStopRun={vi.fn()}
      />,
    );
    expect(screen.getByText("Queue paused · Stopped")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
  });

  it("never renders Stop and send or a send button for attachment or non-steerable rows", () => {
    const detail = makeDetail({
      queue: makeQueue({
        items: [
          {
            id: "item-non-steerable",
            content: "Waiting for non-steerable harness",
            attachmentCount: 0,
            state: "waiting",
            queueHeld: false,
            editRevision: 0,
            editable: true,
            sendLabel: "stop-and-send",
            attribution: "user",
            modelLabel: null,
            error: null,
          },
          {
            id: "item-attached-defensive",
            content: "Has attachment",
            attachmentCount: 1,
            state: "waiting",
            queueHeld: false,
            editRevision: 0,
            editable: false,
            sendLabel: "send-now",
            attribution: "user",
            modelLabel: null,
            error: null,
          },
          {
            id: "item-executable",
            content: "Executable text item",
            attachmentCount: 0,
            state: "waiting",
            queueHeld: false,
            editRevision: 0,
            editable: true,
            sendLabel: "send-now",
            attribution: "user",
            modelLabel: null,
            error: null,
          },
        ],
      }),
    });

    render(
      <ConversationPane
        shell={makeShell(["private:read", "private:prompt"])}
        detail={detail}
        prompt=""
        busy={false}
        offline={false}
        messagesRef={createRef()}
        onScrollIntent={vi.fn()}
        onPromptChange={vi.fn()}
        onSendPrompt={vi.fn()}
        onAnswer={vi.fn()}
        onStopRun={vi.fn()}
      />,
    );

    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(within(items[0]!).queryByRole("button", { name: "Stop and send" })).toBeNull();
    expect(within(items[0]!).queryByRole("button", { name: "Send now" })).toBeNull();
    expect(within(items[1]!).queryByRole("button", { name: "Send now" })).toBeNull();
    expect(within(items[1]!).queryByRole("button", { name: "Stop and send" })).toBeNull();
    expect(within(items[2]!).getByRole("button", { name: "Send now" })).toBeEnabled();
  });

  it("captures editRevision when editing starts so polled desktop updates still submit the original revision, and keeps the draft open on conflict", async () => {
    const onEditQueueItem = vi.fn(async () => false);
    const makeProps = (editRevision: number, content: string) => ({
      shell: makeShell(["private:read", "private:prompt"]),
      detail: makeDetail({
        queue: makeQueue({
          items: [{
            id: "item-conflict",
            content,
            attachmentCount: 0,
            state: "waiting",
            queueHeld: false,
            editRevision,
            editable: true,
            sendLabel: "send-now",
            attribution: "device",
            modelLabel: null,
            error: null,
          }],
        }),
      }),
      prompt: "",
      busy: false,
      offline: false,
      messagesRef: createRef<HTMLDivElement>(),
      onScrollIntent: vi.fn(),
      onPromptChange: vi.fn(),
      onSendPrompt: vi.fn(),
      onAnswer: vi.fn(),
      onStopRun: vi.fn(),
      onEditQueueItem,
    });

    const { rerender } = render(<ConversationPane {...makeProps(0, "Original mobile draft")} />);

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const editBox = screen.getByRole("textbox", { name: "Edit queued message" });
    fireEvent.change(editBox, { target: { value: "My typed mobile revision" } });

    // A background poll updates editRevision from 0 to 1 while the user is editing.
    rerender(<ConversationPane {...makeProps(1, "Desktop edited version")} />);

    expect(screen.getByText(/Updated on desktop/i)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Edit queued message" })).toHaveValue("My typed mobile revision");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });

    // Must submit the revision captured at startEdit (0), NOT the polled revision (1).
    expect(onEditQueueItem).toHaveBeenCalledWith("item-conflict", 0, "My typed mobile revision");

    // Because onEditQueueItem returned false (conflict), the textarea and typed draft stay open with alert feedback.
    expect(screen.getByRole("textbox", { name: "Edit queued message" })).toHaveValue("My typed mobile revision");
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
});
