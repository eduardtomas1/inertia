import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ScopeReviewPanel, { type ScopeReviewPanelProps } from "../../src/renderer/src/components/ScopeReviewPanel";

const props = (): ScopeReviewPanelProps => {
  const brief = { conversationId: "chat", revision: 1, requirements: ["Retry three times"], sources: [{ messageId: "message", excerpt: "Please add retries." }] };
  return { brief, sources: [], fingerprint: "a", loading: false, locked: false,
    onSave: vi.fn(async () => undefined), onReview: vi.fn(async () => undefined), onSelectFile: vi.fn(), onAddTextToPrompt: vi.fn(),
    review: { brief, requirements: [{ requirementIndex: 0, evidence: [] }], unexplained: [
      { path: "auth.ts", hunkId: "h1", reason: "Authentication changes are unrelated to retries.", confidence: "medium" },
    ] } };
};

describe("request-aware Changes review", () => {
  it("accepts visible test evidence without claiming execution or requiring an implementation change", () => {
    const handlers = props();
    handlers.brief!.requirements = ["Add a test for the retry limit"];
    handlers.review!.requirements[0]!.evidence = [{ path: "retry.test.ts", hunkId: "test-hunk", kind: "test", reason: "Adds an assertion for the retry limit; execution is unknown.", confidence: "medium" }];
    render(<ScopeReviewPanel {...handlers} />);
    expect(screen.queryByText("No visible implementation or test evidence")).toBeNull();
    expect(screen.getByText("Test change · medium confidence")).toBeTruthy();
    expect(screen.getByText(/Test changes do not mean tests ran or passed/)).toBeTruthy();
  });
  it("shows missing evidence, uncertainty and linked source; findings become editable requests without sending", async () => {
    const handlers = props(); render(<ScopeReviewPanel {...handlers} />);
    expect(screen.getByText("No visible implementation or test evidence")).toBeTruthy();
    expect(screen.getByText(/Test changes do not mean tests ran or passed/)).toBeTruthy();
    fireEvent.click(screen.getByText("Linked user message 1"));
    expect(screen.getByText("Please add retries.")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Draft request" })[1]!);
    const request = screen.getByRole("textbox", { name: "Edit request to agent" });
    await waitFor(() => expect(document.activeElement).toBe(request));
    expect((request as HTMLTextAreaElement).value).toContain("auth.ts");
    expect(handlers.onAddTextToPrompt).not.toHaveBeenCalled();
    fireEvent.change(request, { target: { value: "Keep authentication as it was. Explain why it changed." } });
    fireEvent.click(screen.getByRole("button", { name: "Add request to prompt" }));
    expect(handlers.onAddTextToPrompt).toHaveBeenCalledWith("Keep authentication as it was. Explain why it changed.");
  });
  it("preserves an edited brief when updates arrive and uses its original revision to save", async () => {
    const handlers = props(); const view = render(<ScopeReviewPanel {...handlers} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit brief" }));
    fireEvent.change(screen.getByRole("textbox", { name: /Requirements/ }), { target: { value: "Retry three times\nAdd failure tests" } });
    view.rerender(<ScopeReviewPanel {...handlers} brief={{ ...handlers.brief!, revision: 2, requirements: ["Different window"] }} />);
    expect((screen.getByRole("textbox", { name: /Requirements/ }) as HTMLTextAreaElement).value).toContain("Add failure tests");
    fireEvent.click(screen.getByRole("button", { name: "Save brief" }));
    await waitFor(() => expect(handlers.onSave).toHaveBeenCalledWith(1, { requirements: ["Retry three times", "Add failure tests"], sourceMessageIds: ["message"] }));
  });
  it("retains a finding draft but prevents adding it after diff or brief changes", () => {
    const handlers = props(); const view = render(<ScopeReviewPanel {...handlers} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Draft request" })[0]!);
    fireEvent.change(screen.getByRole("textbox", { name: "Edit request to agent" }), { target: { value: "My edited request" } });
    view.rerender(<ScopeReviewPanel {...handlers} review={undefined} fingerprint="b" />);
    expect((screen.getByRole("textbox", { name: "Edit request to agent" }) as HTMLTextAreaElement).value).toBe("My edited request");
    expect((screen.getByRole("button", { name: "Add request to prompt" }) as HTMLButtonElement).disabled).toBe(true);
    expect(handlers.onAddTextToPrompt).not.toHaveBeenCalled();
  });
});
