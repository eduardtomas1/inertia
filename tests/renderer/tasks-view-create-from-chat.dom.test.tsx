import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TaskCreatedNotice } from "../../src/renderer/src/components/tasks/TaskCreatedNotice";
import {
  TASK_CREATED_NOTICE_LIFETIME_MS,
  useTaskCreationController,
  useTaskCreator,
} from "../../src/renderer/src/components/tasks/taskCreation";
import type { CommandWithoutId } from "../../src/renderer/src/lib/runtimeCommands";
import type { AppSnapshot, Conversation, ServerEvent } from "../../src/shared/contracts";
import type { TodoTextDraft } from "../../src/shared/todos";

const conversationId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const snapshot = {
  conversations: [{ id: conversationId, projectId, title: "Release prep" } as Conversation],
} as AppSnapshot;

function Harness({
  request,
  onError,
  onOpenTasks,
  compose,
  target = conversationId,
}: {
  request(command: CommandWithoutId): Promise<ServerEvent>;
  onError(message: string): void;
  onOpenTasks(): void;
  compose(chat: Conversation): TodoTextDraft | null;
  target?: string;
}): React.JSX.Element {
  const { creator, notice, dismissNotice } = useTaskCreationController({ snapshot, request, onError });
  return (
    <>
      <button type="button" onClick={() => creator.create(target, compose)}>Make task</button>
      <Consumer />
      {notice && <TaskCreatedNotice notice={notice} onOpenTasks={onOpenTasks} onDismiss={dismissNotice} />}
    </>
  );
}

function Consumer(): React.JSX.Element {
  return <span data-testid="outside-provider">{useTaskCreator() ? "provided" : "none"}</span>;
}

function setup(overrides: Partial<React.ComponentProps<typeof Harness>> = {}) {
  const props = {
    request: vi.fn(async (_command: CommandWithoutId): Promise<ServerEvent> => ({ type: "request.ok", requestId: "request" })),
    onError: vi.fn(),
    onOpenTasks: vi.fn(),
    compose: vi.fn((chat: Conversation): TodoTextDraft | null => ({ title: "Fix the build", note: `From ${chat.title}` })),
    ...overrides,
  };
  render(<Harness {...props} />);
  return props;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("creating tasks from a chat", () => {
  it("sends a todo.create that remembers the source chat without handing the task to it", async () => {
    const props = setup();
    expect(screen.getByTestId("outside-provider")).toHaveTextContent("none");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Make task" })));

    expect(props.compose).toHaveBeenCalledWith(snapshot.conversations[0]);
    expect(props.request).toHaveBeenCalledOnce();
    const [command] = vi.mocked(props.request).mock.calls[0]!;
    expect(command).toEqual({
      type: "todo.create",
      payload: {
        id: expect.stringMatching(uuid),
        title: "Fix the build",
        note: "From Release prep",
        priority: null,
        dueDate: null,
        dueTime: null,
        sourceConversationId: conversationId,
        projectId,
      },
    });
    expect(command).not.toHaveProperty("payload.conversationId");
    const notice = screen.getByRole("status");
    expect(notice).toHaveTextContent("Task created");
    expect(notice).toHaveTextContent("Fix the build");

    fireEvent.click(screen.getByRole("button", { name: "Open tasks" }));
    expect(props.onOpenTasks).toHaveBeenCalledOnce();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("dismisses the confirmation by hand or after a while", async () => {
    vi.useFakeTimers();
    setup();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Make task" })));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss task confirmation" }));
    expect(screen.queryByRole("status")).toBeNull();

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Make task" })));
    expect(screen.getByRole("status")).toBeTruthy();
    act(() => { vi.advanceTimersByTime(TASK_CREATED_NOTICE_LIFETIME_MS); });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("reports a missing chat or empty text without sending anything", async () => {
    const missing = setup({ target: "33333333-3333-4333-8333-333333333333" });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Make task" })));
    expect(missing.onError).toHaveBeenCalledWith("That chat is no longer available.");
    expect(missing.compose).not.toHaveBeenCalled();
    expect(missing.request).not.toHaveBeenCalled();
    cleanup();

    const empty = setup({ compose: vi.fn(() => null) });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Make task" })));
    expect(empty.onError).toHaveBeenCalledWith("There is no text to make a task from.");
    expect(empty.request).not.toHaveBeenCalled();
  });

  it("writes one task when the action is chosen twice before the first finishes", async () => {
    let finish!: () => void;
    const request = vi.fn((_command: CommandWithoutId) => new Promise<ServerEvent>((resolve) => {
      finish = () => resolve({ type: "request.ok", requestId: "request" });
    }));
    const props = setup({ request });
    const button = screen.getByRole("button", { name: "Make task" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(props.request).toHaveBeenCalledOnce();
    await act(async () => finish());
    expect(screen.getByRole("status")).toHaveTextContent("Fix the build");

    fireEvent.click(button);
    expect(props.request).toHaveBeenCalledTimes(2);
    await act(async () => finish());
  });

  it("allows another attempt after a failed creation", async () => {
    const request = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ type: "request.ok", requestId: "request" });
    setup({ request });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Make task" })));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Make task" })));
    expect(request).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("status")).toHaveTextContent("Task created");
  });

  it("keeps the confirmation while it is hovered or focused, then lets it go", async () => {
    vi.useFakeTimers();
    setup();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Make task" })));
    const notice = screen.getByRole("status");

    fireEvent.pointerEnter(notice);
    act(() => { vi.advanceTimersByTime(TASK_CREATED_NOTICE_LIFETIME_MS * 2); });
    expect(screen.getByRole("status")).toBe(notice);
    fireEvent.pointerLeave(notice);

    act(() => { vi.advanceTimersByTime(TASK_CREATED_NOTICE_LIFETIME_MS / 2); });
    act(() => screen.getByRole("button", { name: "Open tasks" }).focus());
    act(() => { vi.advanceTimersByTime(TASK_CREATED_NOTICE_LIFETIME_MS * 2); });
    expect(screen.getByRole("status")).toBe(notice);

    act(() => screen.getByRole("button", { name: "Make task" }).focus());
    act(() => { vi.advanceTimersByTime(TASK_CREATED_NOTICE_LIFETIME_MS / 2 - 1); });
    expect(screen.getByRole("status")).toBe(notice);
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("returns focus to the control that asked for the task when dismissed by hand", async () => {
    setup();
    const button = screen.getByRole("button", { name: "Make task" });
    button.focus();
    await act(async () => fireEvent.click(button));
    const dismiss = screen.getByRole("button", { name: "Dismiss task confirmation" });
    dismiss.focus();
    fireEvent.click(dismiss);
    expect(screen.queryByRole("status")).toBeNull();
    expect(button).toHaveFocus();
  });

  it("leaves a rejected creation to the runtime error toast", async () => {
    const props = setup({ request: vi.fn(async () => { throw new Error("The chat does not belong to this project."); }) });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Make task" })));
    expect(props.request).toHaveBeenCalledOnce();
    expect(screen.queryByRole("status")).toBeNull();
    expect(props.onError).not.toHaveBeenCalled();
  });
});
