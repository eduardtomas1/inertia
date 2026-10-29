import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CustomAgentsSettings } from "../../src/renderer/src/components/custom-agents/CustomAgentsSettings";
import { settingsEscapeAction } from "../../src/renderer/src/hooks/useSettingsMode";
import { CUSTOM_AGENT_PRESETS } from "../../src/shared/custom-agent-presets";
import type { CustomAgent, CustomAgentDraft } from "../../src/shared/custom-agents";

const reviewerId = "11111111-1111-4111-8111-111111111111";
const writerId = "22222222-2222-4222-8222-222222222222";

function agent(overrides: Partial<CustomAgent>): CustomAgent {
  return {
    id: reviewerId,
    name: "Reviewer",
    handle: "reviewer",
    description: "Reads diffs before they merge.",
    icon: { kind: "symbol", name: "shield" },
    accent: "blue",
    blocks: [
      { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", kind: "role", body: "You review code." },
      { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", kind: "must", body: "Quote the code." },
    ],
    skills: ["review-checklist"],
    position: 0,
    revision: 3,
    createdAt: "2026-10-29T09:00:00.000Z",
    updatedAt: "2026-10-29T09:00:00.000Z",
    ...overrides,
  };
}

const reviewer = agent({});
const writer = agent({
  id: writerId,
  name: "Docs writer",
  handle: "docs",
  description: "",
  icon: { kind: "symbol", name: "pen" },
  accent: null,
  blocks: [{ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", kind: "role", body: "You write docs." }],
  skills: [],
  position: 1,
  revision: 1,
});

function installBridge(bridge: Record<string, unknown>): void {
  Object.defineProperty(window, "inertia", { configurable: true, value: bridge });
}

afterEach(() => {
  Reflect.deleteProperty(window, "inertia");
});

function setup(extra: Partial<React.ComponentProps<typeof CustomAgentsSettings>> = {}) {
  const request = vi.fn(async (_command: unknown) => ({ type: "request.ok", requestId: "test" }));
  const props = {
    agents: [writer, reviewer],
    skills: [],
    confirmDestructiveActions: true,
    disabled: false,
    request,
    ...extra,
  };
  const view = render(<CustomAgentsSettings {...props} />);
  return { ...view, request, props };
}

describe("custom agents settings", () => {
  it("lists agents in their saved order with handle, description and a quiet summary", () => {
    setup();
    const list = screen.getByRole("list", { name: "Custom agents" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((row) => row.querySelector("strong")?.textContent)).toEqual(["Reviewer", "Docs writer"]);
    expect(within(rows[0]!).getByText("/calling reviewer")).toBeVisible();
    expect(within(rows[0]!).getByText("Reads diffs before they merge.")).toBeVisible();
    expect(within(rows[0]!).getByText("2 blocks · 1 skill")).toBeVisible();
    expect(within(rows[1]!).getByText("1 block")).toBeVisible();
    expect(screen.queryByText(/of 40/u)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Move Reviewer up" })).toHaveAttribute("aria-disabled", "true");
  });

  it("shows the empty state and opens a prefilled editor from a preset, saving the exact create command", async () => {
    const { request } = setup({ agents: [] });
    expect(screen.getByText("No agents yet")).toBeVisible();
    const presets = screen.getByRole("group", { name: "Presets" });
    expect(within(presets).getAllByRole("button").map((button) => button.textContent)).toEqual(CUSTOM_AGENT_PRESETS.map(({ name }) => name));
    fireEvent.click(within(presets).getByRole("button", { name: "Reviewer" }));
    const panel = screen.getByRole("form", { name: "New agent" });
    expect(within(panel).getByLabelText("Name")).toHaveValue("Reviewer");
    expect(within(panel).getByLabelText("Handle")).toHaveValue("reviewer");
    expect(within(panel).getByText("Call it with /calling reviewer")).toBeVisible();
    const preset = CUSTOM_AGENT_PRESETS[0]!;
    expect(within(panel).getAllByRole("textbox", { name: /block \d+$/u })).toHaveLength(preset.blocks.length);
    fireEvent.click(within(panel).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(request.mock.calls[0]![0]).toEqual({
      type: "custom-agent.create",
      payload: {
        agent: {
          name: "Reviewer",
          handle: "reviewer",
          description: preset.summary,
          icon: preset.icon,
          accent: preset.accent,
          blocks: preset.blocks.map((block) => ({ id: expect.stringMatching(/^[0-9a-f-]{36}$/u), kind: block.kind, body: block.body })),
          skills: [],
        },
        onHandleConflict: "reject",
      },
    });
    await waitFor(() => expect(screen.queryByRole("form", { name: "New agent" })).not.toBeInTheDocument());
  });

  it("slugs the handle from the name, keeps it unique, and validates an edited handle live", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "New agent" }));
    const panel = screen.getByRole("form", { name: "New agent" });
    const save = within(panel).getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    expect(within(panel).getByText("Give the agent a name.")).toBeVisible();
    fireEvent.change(within(panel).getByLabelText("Name"), { target: { value: "Reviewer" } });
    expect(within(panel).getByLabelText("Handle")).toHaveValue("reviewer-2");
    fireEvent.change(within(panel).getByRole("textbox", { name: "Role block 1" }), { target: { value: "You review." } });
    expect(save).toBeEnabled();
    const handle = within(panel).getByLabelText("Handle");
    fireEvent.change(handle, { target: { value: "reviewer" } });
    expect(handle).toHaveAttribute("aria-invalid", "true");
    expect(handle).toHaveAccessibleDescription("Another agent already answers to /calling reviewer.");
    expect(save).toBeDisabled();
    fireEvent.change(handle, { target: { value: "code--review" } });
    expect(handle).toHaveAccessibleDescription("Use single dashes.");
    fireEvent.change(within(panel).getByLabelText("Name"), { target: { value: "Something else" } });
    expect(handle).toHaveValue("code--review");
    fireEvent.change(handle, { target: { value: "Code Review" } });
    expect(handle).toHaveValue("code-review");
    expect(save).toBeEnabled();
    const symbol = within(panel).getByRole("radio", { name: "Target" });
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true });
    Object.defineProperty(escape, "target", { value: symbol });
    expect(settingsEscapeAction(escape)).toBe("release");
  });

  it("updates only the changed fields against the revision the editor opened with", async () => {
    const { request } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Edit Reviewer" }));
    const panel = screen.getByRole("form", { name: "Edit Reviewer" });
    fireEvent.change(within(panel).getByLabelText("Description"), { target: { value: "Reads every diff." } });
    fireEvent.click(within(panel).getByRole("radio", { name: "Green" }));
    fireEvent.click(within(panel).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(request.mock.calls[0]![0]).toEqual({
      type: "custom-agent.update",
      payload: { agentId: reviewerId, expectedRevision: 3, description: "Reads every diff.", accent: "green" },
    });
    await waitFor(() => expect(screen.queryByRole("form", { name: "Edit Reviewer" })).not.toBeInTheDocument());
  });

  it("adds, reorders and removes blocks, and turns the budget danger when over", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Edit Docs writer" }));
    const panel = screen.getByRole("form", { name: "Edit Docs writer" });
    fireEvent.click(within(panel).getByRole("button", { name: "Add block" }));
    fireEvent.click(within(screen.getByRole("menu", { name: "Add block" })).getByRole("menuitem", { name: /^Must not/u }));
    const added = within(panel).getByRole("textbox", { name: "Must not block 2" });
    expect(added).toHaveFocus();
    fireEvent.click(within(panel).getByRole("button", { name: "Move Must not block 2 up" }));
    expect(within(panel).getAllByRole("textbox", { name: /block \d+$/u }).map((field) => field.getAttribute("aria-label")))
      .toEqual(["Must not block 1", "Role block 2"]);
    fireEvent.click(within(panel).getByRole("button", { name: "Remove Must not block 1" }));
    expect(within(panel).getByRole("textbox", { name: "Role block 1" })).toHaveFocus();
    const budget = panel.querySelector(".custom-agent-budget")!;
    expect(budget).not.toHaveClass("is-over");
    fireEvent.change(within(panel).getByRole("textbox", { name: "Role block 1" }), { target: { value: "x".repeat(4_000) } });
    for (let index = 0; index < 3; index += 1) {
      fireEvent.click(within(panel).getByRole("button", { name: "Add block" }));
      fireEvent.click(within(screen.getByRole("menu", { name: "Add block" })).getByRole("menuitem", { name: /^Directions/u }));
      fireEvent.change(within(panel).getByRole("textbox", { name: `Directions block ${index + 2}` }), { target: { value: "y".repeat(4_000) } });
    }
    expect(budget).toHaveClass("is-over");
    expect(within(panel).getByText("The instructions are over 12,000 characters.")).toBeVisible();
    expect(within(panel).getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("toggles discovered skills and accepts a typed skill name", async () => {
    const { request } = setup({
      skills: [
        { id: "s1", conversationId: "c", name: "review-checklist", description: "", shortDescription: null, scope: "user", enabled: true, source: "claude-native" },
        { id: "s2", conversationId: "c", name: "release-notes", description: "", shortDescription: null, scope: "user", enabled: true, source: "claude-native" },
      ] as never,
    });
    fireEvent.click(screen.getByRole("button", { name: "Edit Reviewer" }));
    const panel = screen.getByRole("form", { name: "Edit Reviewer" });
    expect(within(panel).getByRole("button", { name: "review-checklist" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(panel).getByRole("button", { name: "release-notes" }));
    fireEvent.click(within(panel).getByRole("button", { name: "review-checklist" }));
    fireEvent.change(within(panel).getByRole("textbox", { name: "Add a skill by name" }), { target: { value: "security-audit" } });
    fireEvent.keyDown(within(panel).getByRole("textbox", { name: "Add a skill by name" }), { key: "Enter" });
    expect(within(panel).getByText("Skills are attached natively for Claude and listed in the instructions for other providers.")).toBeVisible();
    fireEvent.click(within(panel).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(request.mock.calls[0]![0]).toEqual({
      type: "custom-agent.update",
      payload: { agentId: reviewerId, expectedRevision: 3, skills: ["release-notes", "security-audit"] },
    });
  });

  it("asks inline before deleting, with Cancel focused first, and deletes at once when confirmation is off", async () => {
    const { request, unmount } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Delete Reviewer" }));
    const confirm = screen.getByRole("group", { name: "Confirm deleting Reviewer" });
    expect(within(confirm).getByRole("button", { name: "Cancel" })).toHaveFocus();
    fireEvent.keyDown(confirm, { key: "Escape" });
    expect(screen.queryByRole("group", { name: "Confirm deleting Reviewer" })).not.toBeInTheDocument();
    expect(request).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete Reviewer" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete agent" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith({
      type: "custom-agent.delete",
      payload: { agentId: reviewerId, expectedRevision: 3 },
    }));
    await screen.findByText("Deleted Reviewer");
    unmount();
    const immediate = setup({ confirmDestructiveActions: false });
    fireEvent.click(screen.getByRole("button", { name: "Delete Docs writer" }));
    await waitFor(() => expect(immediate.request).toHaveBeenCalledWith({
      type: "custom-agent.delete",
      payload: { agentId: writerId, expectedRevision: 1 },
    }));
  });

  it("reorders with the move buttons against the current order", async () => {
    const { request } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Move Reviewer down" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith({
      type: "custom-agent.reorder",
      payload: { expectedAgentIds: [reviewerId, writerId], agentIds: [writerId, reviewerId] },
    }));
  });

  it("imports through the desktop bridge, one create per agent, renaming handles that are taken", async () => {
    const imported: CustomAgentDraft[] = [
      { ...writer, handle: "reviewer", name: "Second reviewer" },
      { ...writer, handle: "triage", name: "Triage" },
    ].map(({ name, handle, description, icon, accent, blocks, skills }) => ({ name, handle, description, icon, accent, blocks, skills }));
    const importCustomAgents = vi.fn(async () => ({ status: "imported" as const, agents: imported }));
    installBridge({ importCustomAgents, exportCustomAgents: vi.fn() });
    const { request } = setup();
    fireEvent.click(screen.getByRole("button", { name: /^Import agents\s?…$/u }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request.mock.calls.map(([command]) => command)).toEqual([
      { type: "custom-agent.create", payload: { agent: { ...imported[0], handle: "reviewer-2" }, onHandleConflict: "rename" } },
      { type: "custom-agent.create", payload: { agent: imported[1], onHandleConflict: "rename" } },
    ]);
    expect(await screen.findByText("Imported 2 agents; renamed /calling reviewer → reviewer-2")).toBeVisible();
  });

  it("reports a rejected import file without sending commands", async () => {
    installBridge({
      importCustomAgents: vi.fn(async () => ({ status: "rejected" as const, message: "That file is not an Inertia custom agents export." })),
      exportCustomAgents: vi.fn(),
    });
    const { request } = setup();
    fireEvent.click(screen.getByRole("button", { name: /^Import agents\s?…$/u }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That file is not an Inertia custom agents export.");
    expect(request).not.toHaveBeenCalled();
  });

  it("exports all agents or one row as a versioned envelope of drafts", async () => {
    const exportCustomAgents = vi.fn(async (_payload: unknown) => ({ status: "exported" as const }));
    installBridge({ exportCustomAgents, importCustomAgents: vi.fn() });
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Export all agents" }));
    await waitFor(() => expect(exportCustomAgents).toHaveBeenCalledTimes(1));
    const envelope = exportCustomAgents.mock.calls[0]![0] as { format: string; version: number; exportedAt: string; agents: Record<string, unknown>[] };
    expect(envelope).toEqual({
      format: "inertia-custom-agents",
      version: 1,
      exportedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
      agents: [reviewer, writer].map(({ name, handle, description, icon, accent, blocks, skills }) => ({ name, handle, description, icon, accent, blocks, skills })),
    });
    expect(await screen.findByText("Exported 2 agents")).toBeVisible();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Export Docs writer" }));
    });
    await waitFor(() => expect(exportCustomAgents).toHaveBeenCalledTimes(2));
    expect((exportCustomAgents.mock.calls[1]![0] as { agents: { handle: string }[] }).agents.map(({ handle }) => handle)).toEqual(["docs"]);
  });

  it("disables the file actions without a desktop bridge and shows the agent count near the limit", () => {
    const many = Array.from({ length: 30 }, (_, index) => agent({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      name: `Agent ${index}`,
      handle: `agent-${index}`,
      position: index,
    }));
    setup({ agents: many });
    expect(screen.getByText("30 of 40")).toBeVisible();
    expect(screen.getByRole("button", { name: /^Import agents\s?…$/u })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Export all agents" })).toBeDisabled();
  });
});
