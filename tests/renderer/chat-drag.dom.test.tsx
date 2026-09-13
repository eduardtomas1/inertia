import { fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SplitDropLayer } from "../../src/renderer/src/components/SplitDropLayer";
import {
  currentChatDrag,
  registerChatDropTarget,
  startChatDrag,
} from "../../src/renderer/src/utils/chatDrag";

function matchMedia(matches: boolean): typeof window.matchMedia {
  return vi.fn((media: string) => ({
    matches,
    media,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function DragSource({
  onClick = () => undefined,
  onStart,
}: {
  onClick?: () => void;
  onStart?: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      onPointerDown={(event) => startChatDrag(
        event,
        { conversationId: "chat-b", title: "Chat B" },
        onStart,
      )}
    >
      Chat B
    </button>
  );
}

function press(element: Element, x = 10, y = 10): void {
  fireEvent.pointerDown(element, {
    button: 0,
    buttons: 1,
    pointerId: 1,
    clientX: x,
    clientY: y,
  });
}

function moveTo(x: number, y: number, buttons = 1): void {
  fireEvent.pointerMove(document, { pointerId: 1, buttons, clientX: x, clientY: y });
}

function release(x: number, y: number): void {
  fireEvent.pointerUp(document, { pointerId: 1, buttons: 0, clientX: x, clientY: y });
}

const target = {
  zone: "right" as const,
  left: 500,
  top: 50,
  width: 400,
  height: 400,
};

describe("chat drag", () => {
  let unregister: () => void = () => undefined;

  beforeEach(() => {
    vi.stubGlobal("matchMedia", matchMedia(false));
  });

  afterEach(() => {
    unregister();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps a click that barely moves a click", () => {
    const onClick = vi.fn();
    const drop = vi.fn();
    unregister = registerChatDropTarget({ resolve: () => target, drop });
    render(<DragSource onClick={onClick} />);
    const button = screen.getByRole("button", { name: "Chat B" });

    press(button);
    moveTo(13, 12);
    release(13, 12);
    fireEvent.click(button);

    expect(currentChatDrag()).toBeNull();
    expect(drop).not.toHaveBeenCalled();
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("previews the target past the threshold and drops on release", () => {
    const onClick = vi.fn();
    const onStart = vi.fn();
    const resolve = vi.fn(() => target);
    const drop = vi.fn();
    unregister = registerChatDropTarget({ resolve, drop });
    render(<DragSource onClick={onClick} onStart={onStart} />);
    const button = screen.getByRole("button", { name: "Chat B" });

    press(button);
    moveTo(40, 10);

    expect(currentChatDrag()).toEqual({
      conversationId: "chat-b",
      title: "Chat B",
      x: 40,
      y: 10,
      target,
    });
    expect(resolve).toHaveBeenCalledWith("chat-b", 40, 10);
    expect(document.documentElement.dataset.chatDrag).toBe("active");
    expect(onStart).toHaveBeenCalledOnce();

    release(40, 10);
    fireEvent.click(button);

    expect(drop).toHaveBeenCalledWith("chat-b", "right");
    expect(currentChatDrag()).toBeNull();
    expect(document.documentElement.dataset.chatDrag).toBeUndefined();
    expect(onClick).not.toHaveBeenCalled();
  });

  it("cancels with Escape without dropping", () => {
    const drop = vi.fn();
    unregister = registerChatDropTarget({ resolve: () => target, drop });
    render(<DragSource />);

    press(screen.getByRole("button", { name: "Chat B" }));
    moveTo(60, 30);
    fireEvent.keyDown(window, { key: "Escape" });
    release(60, 30);

    expect(currentChatDrag()).toBeNull();
    expect(drop).not.toHaveBeenCalled();
  });

  it("keeps a drag cancelled with Escape from clicking the row on release", async () => {
    const onClick = vi.fn();
    const drop = vi.fn();
    unregister = registerChatDropTarget({ resolve: () => target, drop });
    render(<DragSource onClick={onClick} />);
    const button = screen.getByRole("button", { name: "Chat B" });

    press(button);
    moveTo(60, 30);
    fireEvent.keyDown(window, { key: "Escape" });
    await new Promise((resolve) => window.setTimeout(resolve, 10));
    moveTo(70, 30);

    expect(currentChatDrag()).toBeNull();
    expect(document.documentElement.dataset.chatDrag).toBeUndefined();

    release(70, 30);
    fireEvent.click(button);

    expect(drop).not.toHaveBeenCalled();
    expect(onClick).not.toHaveBeenCalled();
  });

  it("cancels when the button was released outside the window", () => {
    const drop = vi.fn();
    unregister = registerChatDropTarget({ resolve: () => target, drop });
    render(<DragSource />);

    press(screen.getByRole("button", { name: "Chat B" }));
    moveTo(60, 30);
    moveTo(80, 30, 0);
    release(80, 30);

    expect(currentChatDrag()).toBeNull();
    expect(drop).not.toHaveBeenCalled();
  });
});

describe("SplitDropLayer", () => {
  function Workspace({
    activeConversationId,
    splitConversationId = null,
    onDrop,
  }: {
    activeConversationId: string;
    splitConversationId?: string | null;
    onDrop: (conversationId: string, zone: string) => void;
  }): React.JSX.Element {
    const surfaceRef = useRef<HTMLDivElement>(null);
    return (
      <>
        <DragSource />
        <div ref={surfaceRef} data-testid="workspace" />
        <SplitDropLayer
          surfaceRef={surfaceRef}
          activeConversationId={activeConversationId}
          splitConversationId={splitConversationId}
          onDrop={onDrop}
        />
      </>
    );
  }

  beforeEach(() => {
    vi.stubGlobal("matchMedia", matchMedia(false));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function pointAtWorkspace(): void {
    const workspace = screen.getByTestId("workspace");
    vi.spyOn(workspace, "getBoundingClientRect").mockReturnValue(
      new DOMRect(100, 50, 800, 400),
    );
    document.elementFromPoint = vi.fn(() => workspace);
  }

  it("paints the receiving half with a title chip and drops there", () => {
    const onDrop = vi.fn();
    render(<Workspace activeConversationId="chat-a" onDrop={onDrop} />);
    pointAtWorkspace();

    press(screen.getByRole("button", { name: "Chat B" }));
    moveTo(880, 250);

    const highlight = document.querySelector<HTMLElement>(".split-drop-highlight");
    expect(highlight).toHaveAttribute("data-split-drop-zone", "right");
    expect(highlight?.style.left).toBe("500px");
    expect(highlight?.style.width).toBe("400px");
    expect(document.querySelector(".chat-drag-chip")).toHaveTextContent("Chat B");

    release(880, 250);

    expect(onDrop).toHaveBeenCalledWith("chat-b", "right");
    expect(document.querySelector(".split-drop-highlight")).toBeNull();
    expect(document.querySelector(".chat-drag-chip")).toBeNull();
  });

  it("offers no target for the chat that is already the only one shown", () => {
    const onDrop = vi.fn();
    render(<Workspace activeConversationId="chat-b" onDrop={onDrop} />);
    pointAtWorkspace();

    press(screen.getByRole("button", { name: "Chat B" }));
    moveTo(880, 250);

    expect(document.querySelector(".split-drop-highlight")).toBeNull();
    expect(document.querySelector(".chat-drag-chip")).toHaveTextContent("Chat B");

    release(880, 250);

    expect(onDrop).not.toHaveBeenCalled();
  });

  it("lets a chat already in the split be moved to another side", () => {
    const onDrop = vi.fn();
    render(
      <Workspace
        activeConversationId="chat-b"
        splitConversationId="chat-c"
        onDrop={onDrop}
      />,
    );
    pointAtWorkspace();

    press(screen.getByRole("button", { name: "Chat B" }));
    moveTo(500, 440);
    release(500, 440);

    expect(onDrop).toHaveBeenCalledWith("chat-b", "bottom");
  });

  it("ignores pointers that are over something other than the workspace", () => {
    const onDrop = vi.fn();
    render(<Workspace activeConversationId="chat-a" onDrop={onDrop} />);
    pointAtWorkspace();
    document.elementFromPoint = vi.fn(() => document.body);

    press(screen.getByRole("button", { name: "Chat B" }));
    moveTo(880, 250);
    release(880, 250);

    expect(onDrop).not.toHaveBeenCalled();
  });
});
