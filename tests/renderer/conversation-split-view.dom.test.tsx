import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useEffect, useState, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ConversationSplitView,
  type SplitPaneView,
} from "../../src/renderer/src/components/ConversationSplitView";
import { currentChatDrag } from "../../src/renderer/src/utils/chatDrag";
import {
  splitLeaves,
  swapSplitPanes,
  type SplitLayout,
  type SplitPaneOwner,
} from "../../src/renderer/src/utils/splitLayout";

function matchMedia(matches: boolean): typeof window.matchMedia {
  return vi.fn(() => ({
    matches,
    media: "(max-width: 860px)",
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

const pair: SplitLayout = {
  axis: "columns",
  ratio: 50,
  first: { owner: "primary" },
  second: { owner: "secondary" },
};

const grid: SplitLayout = {
  axis: "columns",
  ratio: 50,
  first: {
    axis: "rows",
    ratio: 50,
    first: { owner: "primary" },
    second: { owner: "quaternary" },
  },
  second: {
    axis: "rows",
    ratio: 50,
    first: { owner: "secondary" },
    second: { owner: "tertiary" },
  },
};

function pane(
  owner: SplitPaneOwner,
  title: string,
  projectName: string,
  content: ReactNode = <span>{title}</span>,
  details: Partial<SplitPaneView> = {},
): SplitPaneView {
  return {
    owner,
    content,
    title,
    projectName,
    toolsOpen: false,
    onToggleTools: () => undefined,
    terminalOpen: false,
    onToggleTerminal: () => undefined,
    ...details,
  };
}

const routingPanes = [
  pane("primary", "Provider routing", "Inertia"),
  pane("secondary", "Windows focus", "Windows app"),
];

function PaneResource({
  name,
  onUnmount,
}: {
  name: string;
  onUnmount: () => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState(`${name} attachment`);
  useEffect(() => onUnmount, [onUnmount]);
  return (
    <label>
      {name}
      <textarea
        aria-label={`${name} pending resource`}
        value={draft}
        onChange={(event) => setDraft(event.currentTarget.value)}
      />
    </label>
  );
}

describe("ConversationSplitView", () => {
  beforeEach(() => {
    vi.stubGlobal("matchMedia", matchMedia(false));
  });

  it("keeps both chats independently labelled and exposes explicit actions", () => {
    const onLayoutChange = vi.fn();
    const onClosePane = vi.fn();

    render(
      <ConversationSplitView
        layout={pair}
        panes={routingPanes}
        onLayoutChange={onLayoutChange}
        onClosePane={onClosePane}
      />,
    );

    expect(screen.getByRole("main", {
      name: "Split conversation workspace",
    })).toBeVisible();
    expect(screen.getByRole("region", {
      name: "Primary chat: Inertia · Provider routing",
    })).toBeVisible();
    expect(screen.getByRole("region", {
      name: "Second chat: Windows app · Windows focus",
    })).toBeVisible();

    fireEvent.click(screen.getByRole("button", {
      name: "Move Windows focus to the primary position",
    }));
    fireEvent.click(screen.getByRole("button", {
      name: "Close split chat Windows focus",
    }));

    expect(onLayoutChange).toHaveBeenCalledWith(swapSplitPanes(pair, "secondary", "primary"));
    expect(onClosePane).toHaveBeenCalledWith("secondary");
    expect(screen.queryByRole("button", { name: "Close split chat Provider routing" }))
      .toBeNull();
  });

  it("restores focus to an actionable detached primary after closing the split", async () => {
    function Harness(): React.JSX.Element {
      const [split, setSplit] = useState(true);
      const detached = (
        <section className="chat-workspace">
          <button type="button">Focus chat window</button>
        </section>
      );
      return split ? (
        <ConversationSplitView
          layout={pair}
          panes={[
            pane("primary", "Detached owner", "Alpha", detached),
            pane("secondary", "Second chat", "Beta", (
              <section className="chat-workspace"><textarea aria-label="Second draft" /></section>
            )),
          ]}
          onLayoutChange={() => undefined}
          onClosePane={() => setSplit(false)}
        />
      ) : detached;
    }

    render(<Harness />);
    fireEvent.click(screen.getByRole("button", {
      name: "Close split chat Second chat",
    }));

    await waitFor(() => expect(screen.getByRole("button", {
      name: "Focus chat window",
    })).toHaveFocus());
  });

  it("restores focus to the primary composer before transcript fallbacks", async () => {
    function Harness(): React.JSX.Element {
      const [split, setSplit] = useState(true);
      const primary = (
        <section className="chat-workspace">
          <div tabIndex={0}>Earlier transcript</div>
          <textarea aria-label="Primary message" />
        </section>
      );
      return split ? (
        <ConversationSplitView
          layout={pair}
          panes={[
            pane("primary", "Primary chat", "Alpha", primary),
            pane("secondary", "Second chat", "Beta", (
              <section className="chat-workspace"><textarea aria-label="Second draft" /></section>
            )),
          ]}
          onLayoutChange={() => undefined}
          onClosePane={() => setSplit(false)}
        />
      ) : primary;
    }

    render(<Harness />);
    fireEvent.click(screen.getByRole("button", {
      name: "Close split chat Second chat",
    }));

    await waitFor(() => expect(screen.getByRole("textbox", {
      name: "Primary message",
    })).toHaveFocus());
  });

  it("focuses the primary composer of a remaining split after closing one pane", async () => {
    function Harness(): React.JSX.Element {
      const [layout, setLayout] = useState<SplitLayout>({
        ...pair,
        second: {
          axis: "rows",
          ratio: 50,
          first: { owner: "secondary" },
          second: { owner: "tertiary" },
        },
      });
      const panes = [
        pane("primary", "Primary chat", "Alpha", (
          <section className="chat-workspace"><textarea aria-label="Primary message" /></section>
        )),
        pane("secondary", "Second chat", "Beta", (
          <section className="chat-workspace"><textarea aria-label="Second draft" /></section>
        )),
        pane("tertiary", "Third chat", "Gamma", (
          <section className="chat-workspace"><textarea aria-label="Third draft" /></section>
        )),
      ].filter(({ owner }) => splitLeaves(layout).includes(owner));
      return (
        <ConversationSplitView
          layout={layout}
          panes={panes}
          onLayoutChange={setLayout}
          onClosePane={() => setLayout(pair)}
        />
      );
    }

    render(<Harness />);
    fireEvent.click(screen.getByRole("button", {
      name: "Close split chat Third chat",
    }));

    await waitFor(() => expect(screen.getByRole("textbox", {
      name: "Primary message",
    })).toHaveFocus());
    expect(screen.queryByRole("textbox", { name: "Third draft" })).toBeNull();
  });

  it("reorders mounted conversation resources without retargeting them", async () => {
    const primaryUnmounted = vi.fn();
    const secondaryUnmounted = vi.fn();

    function Harness(): React.JSX.Element {
      const [layout, setLayout] = useState(pair);
      return (
        <ConversationSplitView
          layout={layout}
          panes={[
            pane("primary", "Provider routing", "Inertia", (
              <PaneResource name="Primary" onUnmount={primaryUnmounted} />
            ), { toolsOpen: true }),
            pane("secondary", "Windows focus", "Windows app", (
              <PaneResource name="Secondary" onUnmount={secondaryUnmounted} />
            )),
          ]}
          onLayoutChange={setLayout}
          onClosePane={() => undefined}
        />
      );
    }

    render(<Harness />);
    fireEvent.change(screen.getByRole("textbox", {
      name: "Primary pending resource",
    }), { target: { value: "primary terminal and attachment" } });
    fireEvent.change(screen.getByRole("textbox", {
      name: "Secondary pending resource",
    }), { target: { value: "secondary preview and attachment" } });

    fireEvent.click(screen.getByRole("button", {
      name: "Move Windows focus to the primary position",
    }));

    expect(screen.getByRole("region", {
      name: "Primary chat: Windows app · Windows focus",
    })).toContainElement(screen.getByRole("textbox", {
      name: "Secondary pending resource",
    }));
    expect(screen.getByRole("region", {
      name: "Second chat: Inertia · Provider routing",
    })).toContainElement(screen.getByRole("textbox", {
      name: "Primary pending resource",
    }));
    expect(screen.getByRole("textbox", {
      name: "Primary pending resource",
    })).toHaveValue("primary terminal and attachment");
    expect(screen.getByRole("textbox", {
      name: "Secondary pending resource",
    })).toHaveValue("secondary preview and attachment");
    await waitFor(() => {
      expect(screen.getByRole("textbox", {
        name: "Secondary pending resource",
      })).toHaveFocus();
    });
    expect(primaryUnmounted).not.toHaveBeenCalled();
    expect(secondaryUnmounted).not.toHaveBeenCalled();
  });

  it("supports keyboard resizing and commits the ratio to the layout", () => {
    const onLayoutChange = vi.fn();
    render(
      <ConversationSplitView
        layout={pair}
        panes={routingPanes}
        onLayoutChange={onLayoutChange}
        onClosePane={() => undefined}
      />,
    );

    const separator = screen.getByRole("separator", {
      name: "Resize split chats",
    });
    expect(separator).toHaveAttribute("aria-orientation", "vertical");
    expect(separator).toHaveAttribute("aria-valuenow", "50");
    expect(separator).toHaveAttribute("aria-valuetext", "50% for the primary chat");

    fireEvent.keyDown(separator, { key: "ArrowRight" });

    expect(onLayoutChange).toHaveBeenCalledWith({ ...pair, ratio: 52 });
  });

  it("stacks the panes and uses a horizontal separator in narrow layouts", () => {
    vi.stubGlobal("matchMedia", matchMedia(true));

    render(
      <ConversationSplitView
        layout={pair}
        panes={routingPanes}
        onLayoutChange={() => undefined}
        onClosePane={() => undefined}
      />,
    );

    expect(screen.getByRole("separator", {
      name: "Resize split chats",
    })).toHaveAttribute("aria-orientation", "horizontal");
    expect(screen.getByRole("main", {
      name: "Split conversation workspace",
    })).toHaveClass("is-stacked");
    expect(screen.queryByRole("button", { name: "Stack split chats" })).toBeNull();
    expect(screen.queryByRole("button", {
      name: "Place split chats side by side",
    })).toBeNull();
  });

  it("follows the layout orientation and offers a keyboard toggle", () => {
    const onLayoutChange = vi.fn();
    const rows: SplitLayout = { ...pair, axis: "rows" };
    const view = render(
      <ConversationSplitView
        layout={rows}
        panes={routingPanes}
        onLayoutChange={onLayoutChange}
        onClosePane={() => undefined}
      />,
    );

    expect(screen.getByRole("main", {
      name: "Split conversation workspace",
    })).toHaveClass("is-stacked");
    expect(screen.getByRole("separator", {
      name: "Resize split chats",
    })).toHaveAttribute("aria-orientation", "horizontal");
    fireEvent.click(screen.getByRole("button", {
      name: "Place split chats side by side",
    }));
    expect(onLayoutChange).toHaveBeenCalledWith(pair);

    view.rerender(
      <ConversationSplitView
        layout={pair}
        panes={routingPanes}
        onLayoutChange={onLayoutChange}
        onClosePane={() => undefined}
      />,
    );

    expect(screen.getByRole("main", {
      name: "Split conversation workspace",
    })).not.toHaveClass("is-stacked");
    expect(screen.getByRole("button", { name: "Stack split chats" })).toBeVisible();
  });

  it("drags a pane by its header but never from its buttons", async () => {
    render(
      <ConversationSplitView
        layout={pair}
        panes={[
          pane("primary", "Provider routing", "Inertia", undefined, {
            conversationId: "primary-chat",
          }),
          pane("secondary", "Windows focus", "Windows app", undefined, {
            conversationId: "secondary-chat",
          }),
        ]}
        onLayoutChange={() => undefined}
        onClosePane={() => undefined}
      />,
    );
    const pointer = { pointerId: 1, buttons: 1 };

    fireEvent.pointerDown(screen.getByRole("button", {
      name: "Close split chat Windows focus",
    }), { ...pointer, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(document, { ...pointer, clientX: 60, clientY: 10 });
    expect(currentChatDrag()).toBeNull();
    fireEvent.pointerUp(document, { pointerId: 1, buttons: 0 });

    fireEvent.pointerDown(screen.getByTitle("Windows focus"), {
      ...pointer,
      button: 0,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerMove(document, { ...pointer, clientX: 60, clientY: 10 });
    expect(currentChatDrag()).toMatchObject({
      conversationId: "secondary-chat",
      title: "Windows focus",
    });
    fireEvent.pointerUp(document, { pointerId: 1, buttons: 0 });
    expect(currentChatDrag()).toBeNull();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });

  it("lays out four chats as a grid with a handle for every split", () => {
    const onClosePane = vi.fn();
    render(
      <ConversationSplitView
        layout={grid}
        panes={[
          pane("primary", "Provider routing", "Inertia"),
          pane("secondary", "Windows focus", "Windows app"),
          pane("tertiary", "Release notes", "Docs"),
          pane("quaternary", "Usage limits", "Inertia"),
        ]}
        onLayoutChange={() => undefined}
        onClosePane={onClosePane}
      />,
    );

    const first = screen.getByRole("region", { name: "Primary chat: Inertia · Provider routing" });
    const second = screen.getByRole("region", { name: "Second chat: Inertia · Usage limits" });
    const third = screen.getByRole("region", { name: "Third chat: Windows app · Windows focus" });
    const fourth = screen.getByRole("region", { name: "Fourth chat: Docs · Release notes" });
    expect(first.style.left).toBe("calc(0% + 0px)");
    expect(first.style.height).toBe("calc(50% - 3.5px)");
    expect(fourth.style.left).toBe("calc(50% + 3.5px)");
    expect(fourth.style.top).toBe("calc(50% + 3.5px)");
    expect(screen.getAllByRole("separator").map((separator) => [
      separator.getAttribute("aria-label"),
      separator.getAttribute("aria-orientation"),
    ])).toEqual([
      ["Resize split chats", "vertical"],
      ["Resize Provider routing and Usage limits", "horizontal"],
      ["Resize Windows focus and Release notes", "horizontal"],
    ]);
    expect(within(second).getByRole("button", { name: "Stack split chats" })).toBeVisible();
    for (const region of [second, third, fourth]) {
      expect(within(region).getByRole("button", { name: /to the primary position$/u }))
        .toBeVisible();
    }
    fireEvent.click(within(third).getByRole("button", {
      name: "Close split chat Windows focus",
    }));
    expect(onClosePane).toHaveBeenCalledWith("secondary");
  });

  it("resizes a nested split without touching the others", () => {
    const onLayoutChange = vi.fn();
    render(
      <ConversationSplitView
        layout={grid}
        panes={[
          pane("primary", "Provider routing", "Inertia"),
          pane("secondary", "Windows focus", "Windows app"),
          pane("tertiary", "Release notes", "Docs"),
          pane("quaternary", "Usage limits", "Inertia"),
        ]}
        onLayoutChange={onLayoutChange}
        onClosePane={() => undefined}
      />,
    );

    const nested = screen.getByRole("separator", {
      name: "Resize Windows focus and Release notes",
    });
    expect(nested).toHaveAttribute("aria-valuetext", "50% for Windows focus");
    fireEvent.keyDown(nested, { key: "ArrowDown" });

    expect(onLayoutChange).toHaveBeenCalledWith({
      ...grid,
      second: { ...grid.second, ratio: 52 },
    });
  });

  it("keeps every pane mounted while the grid is rearranged", () => {
    const unmounted = vi.fn();
    const panes = (["primary", "secondary", "tertiary", "quaternary"] as const)
      .map((owner) => pane(owner, `${owner} chat`, "Inertia", (
        <PaneResource name={owner} onUnmount={unmounted} />
      )));
    const view = render(
      <ConversationSplitView
        layout={grid}
        panes={panes}
        onLayoutChange={() => undefined}
        onClosePane={() => undefined}
      />,
    );
    fireEvent.change(screen.getByRole("textbox", {
      name: "tertiary pending resource",
    }), { target: { value: "tertiary terminal" } });

    view.rerender(
      <ConversationSplitView
        layout={swapSplitPanes(grid, "tertiary", "primary")}
        panes={panes}
        onLayoutChange={() => undefined}
        onClosePane={() => undefined}
      />,
    );

    expect(screen.getByRole("region", { name: "Primary chat: Inertia · tertiary chat" }))
      .toContainElement(screen.getByRole("textbox", { name: "tertiary pending resource" }));
    expect(screen.getByRole("textbox", { name: "tertiary pending resource" }))
      .toHaveValue("tertiary terminal");
    expect(unmounted).not.toHaveBeenCalled();
  });
});
