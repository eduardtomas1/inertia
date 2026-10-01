import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ProviderContinuationDialog from "../../src/renderer/src/components/composer/ProviderContinuationDialog";
import { pendingModelRoute } from "../../src/renderer/src/utils/modelRouteTransition";
import { conversation } from "./composer-fixtures";
import type { ServerEvent } from "../../src/shared/contracts";

const source = conversation("source");
const route = pendingModelRoute(source, null, { selection: source.modelSelection, configuration: { accessMode: "supervised", interactionMode: "plan" } }, "Claude", "Different provider");
const result = (): ServerEvent => ({ type: "request.result", requestId: "request", result: { kind: "conversation.context.source", source: {
  conversationId: source.id, conversationTitle: source.title, projectId: source.projectId, projectName: "Project", workspaceLabel: "main", targetConversationId: source.id, targetProjectId: source.projectId, targetWorkspaceLabel: "main", workspaceRelation: "same-workspace",
  messages: ["Keep retries idempotent.", "The cursor is durable."].map((content, index) => ({ sourceMessageId: `message-${index}`, sourceTurnId: null, role: index ? "assistant" : "user", content, truncated: false, createdAt: source.createdAt })),
} } });

describe("provider continuation preview", () => {
  it("previews visible context, carries only selected messages and instruction, and preserves keyboard dismissal", async () => {
    const onContinue = vi.fn();
    const onClose = vi.fn();
    const onCommand = vi.fn(async () => result());
    render(<ProviderContinuationDialog pendingRoute={route} busy={false} disabled={false} error={null} onCommand={onCommand} onClose={onClose} onContinue={onContinue} />);
    await screen.findByText("The cursor is durable.");
    expect(onCommand).toHaveBeenCalledWith("conversation.context.source.load", { type: "conversation.context.source.load", payload: { sourceConversationId: source.id, targetConversationId: source.id, forContinuation: true } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Close provider continuation" })).toHaveFocus());
    fireEvent.click(screen.getByRole("checkbox", { name: /Agent The cursor/u }));
    fireEvent.change(screen.getByRole("textbox", { name: "Next instruction (optional)" }), { target: { value: "Review retry safety." } });
    fireEvent.click(screen.getByRole("button", { name: "Create continuation" }));
    expect(onContinue).toHaveBeenCalledWith({ sourceMessageIds: ["message-0"], instruction: "Review retry safety." });
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("allows retry after load failure, disables empty selection, and displays creation errors", async () => {
    const onCommand = vi.fn().mockRejectedValueOnce(new Error("Connection lost")).mockResolvedValueOnce(result());
    const props = { pendingRoute: route, busy: false, disabled: false, onCommand, onClose: vi.fn(), onContinue: vi.fn() };
    const view = render(<ProviderContinuationDialog {...props} error={null} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Connection lost");
    expect(screen.getByRole("button", { name: "Create continuation" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Retry loading context" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "2 of 2 messages selected" }));
    expect(screen.getByRole("button", { name: "Create continuation" })).toBeDisabled();
    view.rerender(<ProviderContinuationDialog {...props} error="The source checkout changed." />);
    expect(screen.getByRole("alert")).toHaveTextContent("The source checkout changed.");
  });
});
