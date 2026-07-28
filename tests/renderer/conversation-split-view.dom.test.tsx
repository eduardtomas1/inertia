import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ConversationSplitView,
} from "../../src/renderer/src/components/ConversationSplitView";

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
  let stored: Map<string, string>;

  beforeEach(() => {
    stored = new Map();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => stored.set(key, value),
        removeItem: (key: string) => stored.delete(key),
      },
    });
    vi.stubGlobal("matchMedia", matchMedia(false));
  });

  it("keeps both chats independently labelled and exposes explicit actions", () => {
    const makePrimary = vi.fn();
    const close = vi.fn();

    render(
      <ConversationSplitView
        primary={<button type="button">Send from primary</button>}
        secondary={<button type="button">Send from secondary</button>}
        primaryTitle="Provider routing"
        secondaryTitle="Windows focus"
        primaryProjectName="Inertia"
        secondaryProjectName="Windows app"
        primaryToolsOpen={false}
        secondaryToolsOpen={false}
        secondaryFirst={false}
        onTogglePrimaryTools={() => undefined}
        onToggleSecondaryTools={() => undefined}
        onSwapPanes={makePrimary}
        onCloseSecondary={close}
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

    expect(makePrimary).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("reorders mounted conversation resources without retargeting them", async () => {
    const primaryUnmounted = vi.fn();
    const secondaryUnmounted = vi.fn();

    function Harness(): React.JSX.Element {
      const [secondaryFirst, setSecondaryFirst] = useState(false);
      return (
        <ConversationSplitView
          primary={(
            <PaneResource name="Primary" onUnmount={primaryUnmounted} />
          )}
          secondary={(
            <PaneResource name="Secondary" onUnmount={secondaryUnmounted} />
          )}
          primaryTitle="Provider routing"
          secondaryTitle="Windows focus"
          primaryProjectName="Inertia"
          secondaryProjectName="Windows app"
          primaryToolsOpen
          secondaryToolsOpen={false}
          secondaryFirst={secondaryFirst}
          onTogglePrimaryTools={() => undefined}
          onToggleSecondaryTools={() => undefined}
          onSwapPanes={() => setSecondaryFirst((current) => !current)}
          onCloseSecondary={() => undefined}
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

  it("supports keyboard resizing and persists the committed percentage", () => {
    render(
      <ConversationSplitView
        primary={<span>One</span>}
        secondary={<span>Two</span>}
        primaryTitle="One"
        secondaryTitle="Two"
        primaryProjectName="Alpha"
        secondaryProjectName="Beta"
        primaryToolsOpen={false}
        secondaryToolsOpen={false}
        secondaryFirst={false}
        onTogglePrimaryTools={() => undefined}
        onToggleSecondaryTools={() => undefined}
        onSwapPanes={() => undefined}
        onCloseSecondary={() => undefined}
      />,
    );

    const separator = screen.getByRole("separator", {
      name: "Resize split chats",
    });
    expect(separator).toHaveAttribute("aria-orientation", "vertical");
    expect(separator).toHaveAttribute("aria-valuenow", "50");

    fireEvent.keyDown(separator, { key: "ArrowRight" });

    expect(separator).toHaveAttribute("aria-valuenow", "52");
    expect(stored.get("inertia:layout:conversation-split-percent:v1"))
      .toBe("52");
  });

  it("stacks the panes and uses a horizontal separator in narrow layouts", () => {
    vi.stubGlobal("matchMedia", matchMedia(true));

    render(
      <ConversationSplitView
        primary={<span>One</span>}
        secondary={<span>Two</span>}
        primaryTitle="One"
        secondaryTitle="Two"
        primaryProjectName="Alpha"
        secondaryProjectName="Beta"
        primaryToolsOpen={false}
        secondaryToolsOpen={false}
        secondaryFirst={false}
        onTogglePrimaryTools={() => undefined}
        onToggleSecondaryTools={() => undefined}
        onSwapPanes={() => undefined}
        onCloseSecondary={() => undefined}
      />,
    );

    expect(screen.getByRole("separator", {
      name: "Resize split chats",
    })).toHaveAttribute("aria-orientation", "horizontal");
    expect(screen.getByRole("main", {
      name: "Split conversation workspace",
    })).toHaveClass("is-stacked");
  });
});
