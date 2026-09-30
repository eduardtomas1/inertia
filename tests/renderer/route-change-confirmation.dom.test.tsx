import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { RouteChangeConfirmation } from "../../src/renderer/src/components/composer/RouteChangeConfirmation";
import type { PendingModelRoute } from "../../src/renderer/src/components/composer/types";

const pendingRoute = {
  label: "Routed Agent",
  reason: "This route needs a new chat.",
  configuration: { accessMode: "supervised", interactionMode: "build" },
} as PendingModelRoute;

describe("route change confirmation", () => {
  it("keeps the focused New chat button focusable and inert while the chat is created", () => {
    const onCreate = vi.fn();
    const props = {
      pendingRoute,
      cancelRef: createRef<HTMLButtonElement>(),
      canCreate: true,
      onDismiss: vi.fn(),
      onCreate,
    };
    const view = render(<RouteChangeConfirmation {...props} creating={false} />);
    const create = screen.getByRole("button", { name: "New chat" });
    create.focus();
    fireEvent.click(create);
    expect(onCreate).toHaveBeenCalledOnce();

    view.rerender(<RouteChangeConfirmation {...props} creating />);

    expect(create).toHaveTextContent("Creating…");
    expect(create).toBeEnabled();
    expect(create).toHaveAttribute("aria-disabled", "true");
    expect(create).toHaveFocus();
    fireEvent.click(create);
    expect(onCreate).toHaveBeenCalledOnce();

    view.rerender(<RouteChangeConfirmation {...props} creating={false} />);
    expect(create).not.toHaveAttribute("aria-disabled");
  });

  it("disables New chat when the route cannot create a chat", () => {
    render(<RouteChangeConfirmation
      pendingRoute={pendingRoute}
      cancelRef={createRef<HTMLButtonElement>()}
      canCreate={false}
      creating={false}
      onDismiss={vi.fn()}
      onCreate={vi.fn()}
    />);
    expect(screen.getByRole("button", { name: "New chat" })).toBeDisabled();
  });
});
