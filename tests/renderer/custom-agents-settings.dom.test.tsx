import { readFileSync } from "node:fs";

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CustomAgentsSettings } from "../../src/renderer/src/components/custom-agents/CustomAgentsSettings";
import { settingsEscapeAction } from "../../src/renderer/src/hooks/useSettingsMode";
import { CUSTOM_AGENT_PRESETS } from "../../src/shared/custom-agent-presets";
import { CUSTOM_AGENT_ICON_SIZE, type CustomAgent, type CustomAgentDraft } from "../../src/shared/custom-agents";
import { CustomAgentAvatar } from "../../src/renderer/src/components/custom-agents/CustomAgentAvatar";
import { readCustomAgentIcon } from "../../src/renderer/src/components/custom-agents/customAgentImage";

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

function blurMovedNodes(): () => void {
  const { appendChild, insertBefore } = Node.prototype;
  const blurIfMoved = (node: Node): void => {
    const active = document.activeElement;
    if (node.isConnected && active && node.contains(active)) (active as HTMLElement).blur();
  };
  const append = vi.spyOn(Node.prototype, "appendChild").mockImplementation(function (this: Node, node: Node) {
    blurIfMoved(node);
    return appendChild.call(this, node);
  } as typeof appendChild);
  const insert = vi.spyOn(Node.prototype, "insertBefore").mockImplementation(function (this: Node, node: Node, child: Node | null) {
    blurIfMoved(node);
    return insertBefore.call(this, node, child);
  } as typeof insertBefore);
  return () => {
    append.mockRestore();
    insert.mockRestore();
  };
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
    const { request, rerender, props } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Edit Reviewer" }));
    rerender(<CustomAgentsSettings {...props} agents={[writer, { ...reviewer, revision: 4, description: "Changed elsewhere." }]} />);
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

  it("moves focus to the new agent's Edit button after a create, through the New button meanwhile", async () => {
    const { rerender, props } = setup();
    const newButton = screen.getByRole("button", { name: "New agent" });
    newButton.focus();
    fireEvent.click(newButton);
    const panel = screen.getByRole("form", { name: "New agent" });
    fireEvent.change(within(panel).getByLabelText("Name"), { target: { value: "Triage" } });
    fireEvent.change(within(panel).getByRole("textbox", { name: "Role block 1" }), { target: { value: "You triage." } });
    fireEvent.click(within(panel).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("form", { name: "New agent" })).not.toBeInTheDocument());
    expect(newButton).toHaveFocus();
    const triage = agent({ id: "33333333-3333-4333-8333-333333333333", name: "Triage", handle: "triage", position: 2 });
    rerender(<CustomAgentsSettings {...props} agents={[writer, reviewer, triage]} />);
    expect(screen.getByRole("button", { name: "Edit Triage" })).toHaveFocus();
  });

  it("returns focus to the New button when the preset that opened the editor is gone", () => {
    setup({ agents: [] });
    const chip = within(screen.getByRole("group", { name: "Presets" })).getByRole("button", { name: "Reviewer" });
    chip.focus();
    fireEvent.click(chip);
    expect(chip.isConnected).toBe(false);
    fireEvent.click(within(screen.getByRole("form", { name: "New agent" })).getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "New agent" })).toHaveFocus();
  });

  it("keeps focus on the move button after an agent moves down", async () => {
    const { rerender, props, request } = setup();
    const down = screen.getByRole("button", { name: "Move Reviewer down" });
    down.focus();
    fireEvent.click(down);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    const restore = blurMovedNodes();
    rerender(<CustomAgentsSettings {...props} agents={[{ ...writer, position: 0 }, { ...reviewer, position: 1 }]} />);
    restore();
    expect(screen.getAllByRole("listitem").map((row) => row.querySelector("strong")?.textContent)).toEqual(["Docs writer", "Reviewer"]);
    expect(screen.getByRole("button", { name: "Move Reviewer down" })).toHaveFocus();
  });

  it("keeps focus on a block's move button after it moves down", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Edit Reviewer" }));
    const panel = screen.getByRole("form", { name: "Edit Reviewer" });
    const down = within(panel).getByRole("button", { name: "Move Role block 1 down" });
    down.focus();
    const restore = blurMovedNodes();
    fireEvent.click(down);
    restore();
    expect(within(panel).getByRole("button", { name: "Move Role block 2 down" })).toHaveFocus();
  });

  it("announces why Save is unavailable and keeps toolbar labels in one text run", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "New agent" }));
    const panel = screen.getByRole("form", { name: "New agent" });
    const save = within(panel).getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    expect(save).toHaveAccessibleDescription("Give the agent a name.");
    expect(within(panel).getByText("Give the agent a name.")).toHaveAttribute("aria-live", "polite");
    expect(within(panel).getByLabelText("Agent image")).toHaveAttribute("accept", "image/png");
    const importButton = screen.getByRole("button", { name: /^Import agents\s?…$/u });
    expect(importButton.childNodes).toHaveLength(1);
    expect(importButton.firstElementChild).toHaveTextContent("Import agents…");
  });

  it("draws avatar glyphs at 14 or 16 px and defaults an untinted avatar to the muted text colour", () => {
    const identity = { name: "Scout", icon: { kind: "symbol" as const, name: "search" as const }, accent: null };
    const { container } = render(<div>{[18, 24, 28, 56].map((size) => <CustomAgentAvatar key={size} agent={identity} size={size} />)}</div>);
    const glyphs = [...container.querySelectorAll("svg")].map((svg) => svg.getAttribute("width"));
    expect(glyphs).toEqual(["14", "14", "16", "16"]);
    expect(container.querySelectorAll(".custom-agent-avatar-glyph")).toHaveLength(1);
    expect(container.querySelector(".custom-agent-avatar")).not.toHaveClass("has-agent-tint");
    const css = readFileSync("src/renderer/src/components/custom-agents/CustomAgentAvatar.css", "utf8").replaceAll("\r\n", "\n");
    expect(css).toMatch(/\.custom-agent-avatar \{\n  --agent-tint: var\(--text-muted\);/u);
  });

  it("renders a mark as a CSS figure inset by tile size, never an img, with one file rule per mark and theme", () => {
    const identity = { name: "Scout", icon: { kind: "mark" as const, name: "scout" as const }, accent: "blue" as const };
    const sizes = [18, 20, 24, 32, 36, 40, 48, 64];
    const { container } = render(<div>{sizes.map((size) => <CustomAgentAvatar key={size} agent={identity} size={size} />)}</div>);
    const avatars = [...container.querySelectorAll<HTMLElement>(".custom-agent-avatar")];
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("svg")).toBeNull();
    expect(avatars.map((avatar) => avatar.dataset.mark)).toEqual(sizes.map(() => "scout"));
    expect(avatars.map((avatar) => avatar.dataset.iconKind)).toEqual(sizes.map(() => "mark"));
    expect(avatars.map((avatar) => avatar.style.getPropertyValue("--agent-mark-inset"))).toEqual(["1px", "1px", "1px", "2px", "2px", "2px", "4px", "4px"]);
    expect(avatars.map((avatar) => avatar.querySelector(".custom-agent-avatar-figure")?.getAttribute("data-shadow") ?? null))
      .toEqual([null, null, null, "true", "true", "true", "true", "true"]);
    const symbol = render(<CustomAgentAvatar agent={{ ...identity, icon: { kind: "symbol", name: "search" } }} size={36} />).container.firstElementChild as HTMLElement;
    expect(symbol).not.toHaveAttribute("data-mark");
    expect(symbol.style.getPropertyValue("--agent-mark-inset")).toBe("");
    const css = readFileSync("src/renderer/src/components/custom-agents/CustomAgentAvatar.css", "utf8");
    for (const mark of ["runner", "scout", "guard", "builder", "scribe", "spark"]) {
      expect(css).toContain(`.custom-agent-avatar[data-mark="${mark}"] { --agent-mark: url(../../assets/marks/${mark}-dark.webp); }`);
      expect(css).toContain(`:root[data-theme="light"] .custom-agent-avatar[data-mark="${mark}"] { --agent-mark: url(../../assets/marks/${mark}-light.webp); }`);
    }
    expect(css.match(/url\(/gu)).toHaveLength(12);
    expect(css).not.toContain("pixelated");
  });

  it("offers the marks as a gallery radio group of draft-tinted tiles, before the symbols", async () => {
    const { request } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Edit Reviewer" }));
    const panel = screen.getByRole("form", { name: "Edit Reviewer" });
    const groups = within(panel).getAllByRole("radiogroup").map((group) => group.getAttribute("aria-label"));
    expect(groups.slice(0, 2)).toEqual(["Mark", "Symbol"]);
    const gallery = within(panel).getByRole("radiogroup", { name: "Mark" });
    const marks = within(gallery).getAllByRole("radio");
    expect(marks.map((mark) => mark.getAttribute("aria-label"))).toEqual(["Workflow planner", "Investigator", "Marketing", "Builder", "Writer", "Creative"]);
    expect(marks.every((mark) => mark.getAttribute("aria-checked") === "false")).toBe(true);
    expect(marks.map((mark) => mark.tabIndex)).toEqual([0, -1, -1, -1, -1, -1]);
    const tiles = marks.map((mark) => mark.querySelector<HTMLElement>(".custom-agent-avatar")!);
    expect(tiles.map((tile) => tile.dataset.mark)).toEqual(["runner", "scout", "guard", "builder", "scribe", "spark"]);
    expect(tiles.every((tile) => tile.classList.contains("has-agent-tint") && tile.style.getPropertyValue("--agent-avatar-size") === "40px")).toBe(true);
    const preview = panel.querySelector<HTMLElement>(".custom-agent-identity-preview")!;
    expect(preview.style.getPropertyValue("--agent-avatar-size")).toBe("64px");
    expect(preview).toHaveAttribute("data-icon-kind", "symbol");

    marks[0]!.focus();
    fireEvent.keyDown(marks[0]!, { key: "ArrowRight" });
    expect(marks[1]).toHaveFocus();
    expect(marks[1]).toHaveAttribute("aria-checked", "true");
    expect(preview).toHaveAttribute("data-mark", "scout");
    expect(within(within(panel).getByRole("radiogroup", { name: "Symbol" })).getAllByRole("radio").some((radio) => radio.getAttribute("aria-checked") === "true")).toBe(false);
    fireEvent.click(within(panel).getByRole("radio", { name: "Green" }));
    const tint = preview.style.getPropertyValue("--agent-tint-light");
    expect(tint).not.toBe("");
    expect(tiles.every((tile) => tile.style.getPropertyValue("--agent-tint-light") === tint)).toBe(true);
    fireEvent.click(within(panel).getByRole("radio", { name: "Pen" }));
    expect(marks.some((mark) => mark.getAttribute("aria-checked") === "true")).toBe(false);
    fireEvent.click(within(panel).getByRole("radio", { name: "Marketing" }));
    fireEvent.click(within(panel).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(request.mock.calls[0]![0]).toEqual({
      type: "custom-agent.update",
      payload: { agentId: reviewerId, expectedRevision: 3, icon: { kind: "mark", name: "guard" }, accent: "green" },
    });
  });

  it("greets an empty list with three marks and shows preset chips with their marks", () => {
    const { container } = setup({ agents: [] });
    const hero = [...container.querySelectorAll<HTMLElement>(".custom-agents-empty-avatars > .custom-agent-avatar")];
    expect(hero.map((avatar) => avatar.dataset.mark)).toEqual(["scout", "builder", "scribe"]);
    expect(hero.every((avatar) => avatar.style.getPropertyValue("--agent-avatar-size") === "32px" && avatar.classList.contains("has-agent-tint"))).toBe(true);
    const chips = within(screen.getByRole("group", { name: "Presets" })).getAllByRole("button");
    expect(chips.map((chip) => chip.querySelector<HTMLElement>(".custom-agent-avatar")!.dataset.mark))
      .toEqual(CUSTOM_AGENT_PRESETS.map((preset) => preset.icon.kind === "mark" ? preset.icon.name : null));
    expect(chips.every((chip) => chip.querySelector<HTMLElement>(".custom-agent-avatar")!.style.getPropertyValue("--agent-avatar-size") === "20px")).toBe(true);
  });

  it("centre-crops a wide PNG to a square before resizing it", async () => {
    const close = vi.fn();
    const createImageBitmap = vi.fn(async (..._args: unknown[]) => ({ width: 128, height: 64, close }));
    vi.stubGlobal("createImageBitmap", createImageBitmap);
    const context = { drawImage: vi.fn(), imageSmoothingQuality: "low" };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as never);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,AAAA");
    const file = new File([new Uint8Array(16)], "wide.png", { type: "image/png" });
    await expect(readCustomAgentIcon(file)).resolves.toBe("data:image/png;base64,AAAA");
    expect(createImageBitmap).toHaveBeenLastCalledWith(file, 32, 0, 64, 64, {
      resizeWidth: CUSTOM_AGENT_ICON_SIZE,
      resizeHeight: CUSTOM_AGENT_ICON_SIZE,
      resizeQuality: "high",
    });
    await expect(readCustomAgentIcon(new File([new Uint8Array(16)], "photo.jpg", { type: "image/jpeg" })))
      .rejects.toThrow("Choose a PNG image up to 1 MB.");
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
});
