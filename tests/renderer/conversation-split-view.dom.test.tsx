import { fireEvent, render, screen } from "@testing-library/react";
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
        onTogglePrimaryTools={() => undefined}
        onToggleSecondaryTools={() => undefined}
        onMakeSecondaryPrimary={makePrimary}
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
      name: "Make Windows focus the primary chat",
    }));
    fireEvent.click(screen.getByRole("button", {
      name: "Close split chat Windows focus",
    }));

    expect(makePrimary).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
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
        onTogglePrimaryTools={() => undefined}
        onToggleSecondaryTools={() => undefined}
        onMakeSecondaryPrimary={() => undefined}
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
        onTogglePrimaryTools={() => undefined}
        onToggleSecondaryTools={() => undefined}
        onMakeSecondaryPrimary={() => undefined}
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
