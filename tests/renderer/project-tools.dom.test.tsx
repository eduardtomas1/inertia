import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ServerEvent } from "../../src/shared/contracts";
import { ProjectToolsPanel } from "../../src/renderer/src/components/ProjectToolsPanel";
import type { ProjectToolsView } from "../../src/shared/project-tools";

const projectId = "11111111-1111-4111-8111-111111111111";
const conversationId = "22222222-2222-4222-8222-222222222222";
const saved = { id: "33333333-3333-4333-8333-333333333333", projectId, revision: 1, name: "Documentation", url: "https://docs.example.com/mcp", providers: ["claude", "codex"] as ("claude" | "codex")[], bearerTokenEnv: null, state: "available" as const, reason: "Confirmed by this chat", toolNames: ["search_docs"], checkedAt: "2026-10-01T10:00:00.000Z" };
const result = (connections: ProjectToolsView["connections"] = [saved], chat: string | null = conversationId): ServerEvent => ({ type: "request.result", requestId: "result", result: { kind: "project.tools", tools: { projectId, conversationId: chat, connections } } });
const props = { projectId, conversationId, projectName: "Inertia", connected: true };

describe("project tools panel", () => {
  it("shows exact-chat tool names and removes live evidence when disconnected", async () => {
    const run = vi.fn(async () => result());
    const view = render(<ProjectToolsPanel {...props} run={run} />);
    expect(await screen.findByText("Available in this chat")).toBeVisible();
    expect(screen.getByText("search_docs")).toBeVisible();
    view.rerender(<ProjectToolsPanel {...props} connected={false} run={run} />);
    expect(screen.queryByText("Available in this chat")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add connection" })).toBeDisabled();
  });
  it("defines one connection for both providers and returns keyboard focus after saving", async () => {
    const run = vi.fn(async (_key, command) => command.type === "project.tools.load" ? result([]) : { type: "request.ok", requestId: "save" } as ServerEvent);
    render(<ProjectToolsPanel {...props} run={run} />);
    await screen.findByText("No connections yet");
    fireEvent.click(screen.getByRole("button", { name: "Add connection" }));
    const name = screen.getByRole("textbox", { name: "Name" });
    expect(name).toHaveFocus();
    fireEvent.change(name, { target: { value: "Documentation" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Server URL" }), { target: { value: "https://docs.example.com/mcp" } });
    fireEvent.click(screen.getByRole("button", { name: "Save connection" }));
    await waitFor(() => expect(run).toHaveBeenCalledWith("project-tools-save", { type: "project.tools.save", payload: { projectId, connection: { name: "Documentation", url: "https://docs.example.com/mcp", providers: ["claude", "codex"], bearerTokenEnv: null } } }, { passive: true, reportError: false }));
    await waitFor(() => expect(screen.queryByRole("form")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("button", { name: "Add connection" })).toHaveFocus());
  });
  it("preserves an edit and explains optimistic concurrency rejection", async () => {
    const run = vi.fn(async (_key, command) => command.type === "project.tools.load" ? result() : { type: "request.error", requestId: "save", message: "This connection changed. Refresh Tools before saving again." } as ServerEvent);
    render(<ProjectToolsPanel {...props} run={run} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit Documentation" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Revised docs" } });
    fireEvent.click(screen.getByRole("button", { name: "Save connection" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This connection changed");
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Revised docs");
    expect(run).toHaveBeenCalledWith("project-tools-save", expect.objectContaining({ payload: expect.objectContaining({ id: saved.id, revision: 1 }) }), { passive: true, reportError: false });
  });
  it("ignores a late response for a previous chat", async () => {
    let resolve!: (event: ServerEvent) => void;
    const run = vi.fn(() => new Promise<ServerEvent>((done) => { resolve = done; }));
    const view = render(<ProjectToolsPanel {...props} run={run} />);
    const oldResolve = resolve;
    const nextId = "44444444-4444-4444-8444-444444444444";
    view.rerender(<ProjectToolsPanel {...props} conversationId={nextId} run={run} />);
    await act(async () => { oldResolve(result()); });
    expect(screen.queryByText("Available in this chat")).not.toBeInTheDocument();
    await act(async () => { resolve(result([], nextId)); });
    expect(screen.getByText("No connections yet")).toBeVisible();
  });
});
