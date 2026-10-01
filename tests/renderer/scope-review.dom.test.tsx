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
    const add = screen.getByRole("button", { name: "Add request to prompt" });
    expect(add.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(add);
    expect(handlers.onAddTextToPrompt).not.toHaveBeenCalled();
  });
  it("keeps the request action focused and inert when the review becomes stale", () => {
    const handlers = props(); const view = render(<ScopeReviewPanel {...handlers} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Draft request" })[1]!);
    const add = screen.getByRole("button", { name: "Add request to prompt" });
    add.focus();
    view.rerender(<ScopeReviewPanel {...handlers} review={undefined} fingerprint="b" />);
    expect(document.activeElement).toBe(add);
    expect(add.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByRole("status").textContent).toContain("The brief or diff changed.");
  });
  it("keeps the review action focused while the review runs and ignores repeated clicks", () => {
    const handlers = props(); const view = render(<ScopeReviewPanel {...handlers} review={undefined} />);
    const start = screen.getByRole("button", { name: "Review request" });
    start.focus();
    view.rerender(<ScopeReviewPanel {...handlers} review={undefined} loading />);
    const running = screen.getByRole("button", { name: "Reviewing…" });
    expect(running).toBe(start);
    expect(document.activeElement).toBe(running);
    expect(running.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(running);
    expect(handlers.onReview).not.toHaveBeenCalled();
  });
  it("names the requirements field by its visible label and describes the format", () => {
    const handlers = props(); render(<ScopeReviewPanel {...handlers} brief={null} review={undefined} />);
    const field = screen.getByRole("textbox", { name: "Requirements" });
    const help = document.getElementById(field.getAttribute("aria-describedby") ?? "");
    expect(help?.textContent).toBe("One per line, up to 20.");
    const actions = screen.getAllByRole("button").map((button) => button.textContent);
    expect(actions.slice(-2)).toEqual(["Cancel", "Save brief"]);
  });
  it("offers one primary action at a time, secondary actions first", () => {
    const handlers = props(); const view = render(<ScopeReviewPanel {...handlers} review={undefined} />);
    const primary = () => [...document.querySelectorAll(".primary-button")].map((button) => button.textContent);
    expect(primary()).toEqual(["Review request"]);
    expect(screen.getByRole("button", { name: "Edit brief" }).compareDocumentPosition(screen.getByRole("button", { name: "Review request" })))
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    view.rerender(<ScopeReviewPanel {...handlers} />);
    expect(primary()).toEqual([]);
    fireEvent.click(screen.getAllByRole("button", { name: "Draft request" })[1]!);
    expect(primary()).toEqual(["Add request to prompt"]);
    expect(screen.getByRole("button", { name: "Dismiss request" }).compareDocumentPosition(screen.getByRole("button", { name: "Add request to prompt" })))
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });
  it("states the reason for an unexplained change in words", () => {
    render(<ScopeReviewPanel {...props()} />);
    expect(screen.getByText("Connection unclear · medium confidence")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Needs explanation 1" })).toBeTruthy();
  });
});
