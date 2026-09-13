import { fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SplitDropLayer } from "../../src/renderer/src/components/SplitDropLayer";
import {
  currentChatDrag,
  registerChatDropTarget,
  startChatDrag,
  type ChatDragTarget,
} from "../../src/renderer/src/utils/chatDrag";
import type { SplitDropPlan } from "../../src/renderer/src/utils/splitLayout";

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

const insertRight: SplitDropPlan = {
  kind: "insert",
  owner: "secondary",
  target: "primary",
  zone: "right",
};

const target: ChatDragTarget = {
  plan: insertRight,
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

    expect(drop).toHaveBeenCalledWith("chat-b", target);
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
    planDrop,
    onDrop,
    children,
  }: {
    planDrop: Parameters<typeof SplitDropLayer>[0]["planDrop"];
    onDrop: (conversationId: string, plan: SplitDropPlan) => void;
    children?: React.ReactNode;
  }): React.JSX.Element {
    const surfaceRef = useRef<HTMLDivElement>(null);
    return (
      <>
        <DragSource />
        <div ref={surfaceRef} data-testid="workspace">{children}</div>
        <SplitDropLayer surfaceRef={surfaceRef} planDrop={planDrop} onDrop={onDrop} />
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

  function pointAt(element: HTMLElement, rect: DOMRect): void {
    vi.spyOn(element, "getBoundingClientRect").mockReturnValue(rect);
    document.elementFromPoint = vi.fn(() => element);
  }

  it("paints the receiving half with a title chip and drops the planned change", () => {
    const planDrop = vi.fn(() => insertRight);
    const onDrop = vi.fn();
    render(<Workspace planDrop={planDrop} onDrop={onDrop} />);
    pointAt(screen.getByTestId("workspace"), new DOMRect(100, 50, 800, 400));

    press(screen.getByRole("button", { name: "Chat B" }));
    moveTo(880, 250);

    expect(planDrop).toHaveBeenLastCalledWith("chat-b", "primary", ["right", "bottom"]);
    const highlight = document.querySelector<HTMLElement>(".split-drop-highlight");
    expect(highlight).toHaveAttribute("data-split-drop-zone", "right");
    expect(highlight).toHaveAttribute("data-split-drop-action", "insert");
    expect(highlight?.style.left).toBe("500px");
    expect(highlight?.style.width).toBe("400px");
    expect(highlight).toHaveTextContent("");
    expect(document.querySelector(".chat-drag-chip")).toHaveTextContent("Chat B");

    release(880, 250);

    expect(onDrop).toHaveBeenCalledWith("chat-b", insertRight);
    expect(document.querySelector(".split-drop-highlight")).toBeNull();
    expect(document.querySelector(".chat-drag-chip")).toBeNull();
  });

  it("offers no target when the drop would change nothing", () => {
    const onDrop = vi.fn();
    render(<Workspace planDrop={() => null} onDrop={onDrop} />);
    pointAt(screen.getByTestId("workspace"), new DOMRect(100, 50, 800, 400));

    press(screen.getByRole("button", { name: "Chat B" }));
    moveTo(880, 250);

    expect(document.querySelector(".split-drop-highlight")).toBeNull();
    expect(document.querySelector(".chat-drag-chip")).toHaveTextContent("Chat B");

    release(880, 250);

    expect(onDrop).not.toHaveBeenCalled();
  });

  it("targets the pane under the pointer and marks a whole-pane replacement", () => {
    const replace: SplitDropPlan = { kind: "replace", target: "secondary" };
    const planDrop = vi.fn(() => replace);
    const onDrop = vi.fn();
    render(
      <Workspace planDrop={planDrop} onDrop={onDrop}>
        <main className="conversation-split-view">
          <section data-split-pane-owner="primary" />
          <section data-split-pane-owner="secondary"><p>Transcript</p></section>
        </main>
      </Workspace>,
    );
    const secondary = document.querySelector<HTMLElement>('[data-split-pane-owner="secondary"]')!;
    vi.spyOn(secondary, "getBoundingClientRect").mockReturnValue(new DOMRect(500, 50, 400, 400));
    document.elementFromPoint = vi.fn(() => secondary.querySelector("p"));

    press(screen.getByRole("button", { name: "Chat B" }));
    moveTo(880, 250);

    expect(planDrop).toHaveBeenLastCalledWith("chat-b", "secondary", ["right", "bottom"]);
    const highlight = document.querySelector<HTMLElement>(".split-drop-highlight");
    expect(highlight).toHaveAttribute("data-split-drop-action", "replace");
    expect(highlight).not.toHaveAttribute("data-split-drop-zone");
    expect(highlight?.style.left).toBe("500px");
    expect(highlight?.style.width).toBe("400px");
    expect(highlight).toHaveTextContent("Replace chat");

    release(880, 250);

    expect(onDrop).toHaveBeenCalledWith("chat-b", replace);
  });

  it("ignores the gutters between split panes", () => {
    const planDrop = vi.fn(() => insertRight);
    render(
      <Workspace planDrop={planDrop} onDrop={vi.fn()}>
        <main className="conversation-split-view" data-testid="split">
          <section data-split-pane-owner="primary" />
        </main>
      </Workspace>,
    );
    pointAt(screen.getByTestId("split"), new DOMRect(100, 50, 800, 400));

    press(screen.getByRole("button", { name: "Chat B" }));
    moveTo(500, 250);

    expect(planDrop).not.toHaveBeenCalled();
    expect(document.querySelector(".split-drop-highlight")).toBeNull();
    release(500, 250);
  });

  it("ignores pointers that are over something other than the workspace", () => {
    const onDrop = vi.fn();
    render(<Workspace planDrop={() => insertRight} onDrop={onDrop} />);
    pointAt(screen.getByTestId("workspace"), new DOMRect(100, 50, 800, 400));
    document.elementFromPoint = vi.fn(() => document.body);

    press(screen.getByRole("button", { name: "Chat B" }));
    moveTo(880, 250);
    release(880, 250);

    expect(onDrop).not.toHaveBeenCalled();
  });
});
