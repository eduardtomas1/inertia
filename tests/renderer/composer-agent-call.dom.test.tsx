import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CustomAgent } from "../../src/shared/custom-agents";
import { Composer } from "../../src/renderer/src/components/Composer";
import { buildComposerTurnRequest } from "../../src/renderer/src/utils/requestContext";
import {
  parseCallingCommand,
  parseCallingInvocation,
  parseTypedCall,
  rankCustomAgents,
} from "../../src/renderer/src/components/composer/useComposerAgentCall";
import { forgetCalledAgent } from "../../src/renderer/src/components/composer/calledAgentStorage";
import { ComposerAgentCallMenu } from "../../src/renderer/src/components/composer/ComposerAgentCallMenu";
import { ComposerCalledAgentChip } from "../../src/renderer/src/components/composer/ComposerCalledAgentChip";
import { composerProps, conversation } from "./composer-fixtures";

function agent(update: Partial<CustomAgent> & Pick<CustomAgent, "id" | "name" | "handle">): CustomAgent {
  return {
    description: "",
    icon: { kind: "symbol", name: "orbit" },
    accent: null,
    blocks: [],
    skills: [],
    position: 0,
    revision: 1,
    createdAt: "2026-10-29T08:00:00.000Z",
    updatedAt: "2026-10-29T08:00:00.000Z",
    ...update,
  };
}

const reviewer = agent({
  id: "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1",
  name: "Code reviewer",
  handle: "code-reviewer",
  description: "Reviews diffs before merge",
  icon: { kind: "symbol", name: "shield" },
  accent: "blue",
  position: 0,
});
const scout = agent({
  id: "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2",
  name: "Evidence scout",
  handle: "scout",
  description: "Finds the facts",
  icon: { kind: "symbol", name: "search" },
  position: 1,
});

afterEach(() => {
  window.localStorage.clear();
});

describe("composer /calling", () => {
  it("parses and ranks agents by handle and name prefix", () => {
    expect(parseCallingCommand("/calling")).toBe("");
    expect(parseCallingCommand("  /calling Code-R ")).toBe("code-r");
    expect(parseCallingCommand("/calling code reviewer")).toBeNull();
    expect(parseCallingCommand("/call")).toBeNull();
    expect(rankCustomAgents([scout, reviewer], "").map(({ handle }) => handle)).toEqual(["code-reviewer", "scout"]);
    expect(rankCustomAgents([scout, reviewer], "rev").map(({ handle }) => handle)).toEqual(["code-reviewer"]);
    expect(rankCustomAgents([scout, reviewer], "evid").map(({ handle }) => handle)).toEqual(["scout"]);
    expect(rankCustomAgents([scout, reviewer], "acts")).toEqual([]);
  });

  it("adds calledAgent to the turn request context", () => {
    expect(buildComposerTurnRequest("Review it", [], null, [], null, [], reviewer.id)).toEqual({
      visibleContent: "Review it",
      context: { calledAgent: { agentId: reviewer.id } },
    });
    expect(buildComposerTurnRequest("Review it", [], null)).toEqual({ visibleContent: "Review it" });
  });

  it("offers /calling among the slash commands with listbox ids for assistive technology", async () => {
    render(<Composer {...composerProps(conversation("c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1"), { customAgents: [reviewer] })} />);
    const input = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(input, { target: { value: "/cal" } });
    const commands = await screen.findByRole("listbox", { name: "Composer commands" });
    const option = within(commands).getByRole("option", { name: /\/calling/u });
    expect(option).toHaveTextContent("Call a custom agent");
    expect(input).toHaveAttribute("role", "combobox");
    expect(input).toHaveAttribute("aria-controls", commands.id);
    expect(input).toHaveAttribute("aria-activedescendant", option.id);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input).toHaveValue("/calling ");
    expect(await screen.findByRole("listbox", { name: "Custom agents" })).toBeInTheDocument();
  });

  it("filters agents, picks one with Tab, shows the chip and sends calledAgent with Enter", async () => {
    const onSend = vi.fn(async () => undefined);
    render(<Composer {...composerProps(conversation("d1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1"), { customAgents: [reviewer, scout], onSend })} />);
    const input = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(input, { target: { value: "/calling" } });
    const listbox = await screen.findByRole("listbox", { name: "Custom agents" });
    expect(screen.queryByRole("listbox", { name: "Composer commands" })).toBeNull();
    expect(within(listbox).getAllByRole("option")).toHaveLength(2);
    expect(listbox).toHaveTextContent("Custom agents");
    expect(within(listbox).queryByRole("group", { name: "Custom agents" })).toBeNull();
    expect(listbox).toHaveTextContent("/calling code-reviewer");
    expect(input).toHaveAttribute("aria-controls", listbox.id);
    expect(input).toHaveAttribute("aria-activedescendant", `${listbox.id}-${reviewer.id}`);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute("aria-activedescendant", `${listbox.id}-${scout.id}`);
    fireEvent.keyDown(input, { key: "Home" });
    expect(within(listbox).getByRole("option", { name: /Code reviewer/u })).toHaveAttribute("aria-selected", "true");

    fireEvent.change(input, { target: { value: "/calling sc" } });
    await waitFor(() => expect(within(screen.getByRole("listbox", { name: "Custom agents" })).getAllByRole("option")).toHaveLength(1));
    expect(screen.getByRole("option", { name: /Finds the facts/u }).querySelector("mark")).toHaveTextContent("sc");

    fireEvent.keyDown(input, { key: "Tab" });
    expect(input).toHaveValue("");
    expect(screen.queryByRole("listbox", { name: "Custom agents" })).toBeNull();
    const chip = await screen.findByRole("group", { name: "Calling Evidence scout" });
    expect(chip).toHaveTextContent("Calling as a subagent");
    expect(input).toHaveAttribute("placeholder", "What should Evidence scout do?");

    fireEvent.change(input, { target: { value: "Collect the failing cases" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith(
      "Collect the failing cases",
      [],
      { calledAgent: { agentId: scout.id } },
    ));
    await waitFor(() => expect(screen.queryByLabelText("Calling Evidence scout")).toBeNull());
    expect(window.localStorage.length).toBe(0);
  });

  it("accepts a fully typed handle with Enter and removes the chip with its X button", async () => {
    render(<Composer {...composerProps(conversation("e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1"), { customAgents: [reviewer, scout] })} />);
    const input = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(input, { target: { value: "/calling scout" } });
    await screen.findByRole("listbox", { name: "Custom agents" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input).toHaveValue("");
    await screen.findByLabelText("Calling Evidence scout");

    fireEvent.change(input, { target: { value: "/calling code" } });
    await screen.findByRole("listbox", { name: "Custom agents" });
    fireEvent.keyDown(input, { key: "Tab" });
    expect(await screen.findByLabelText("Calling Code reviewer")).toBeInTheDocument();
    expect(screen.queryByLabelText("Calling Evidence scout")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Stop calling Code reviewer" }));
    await waitFor(() => expect(screen.queryByLabelText("Calling Code reviewer")).toBeNull());
    expect(input).not.toHaveAttribute("placeholder", "What should Code reviewer do?");
  });

  it("dismisses the agent list with Escape and does not send an unmatched /calling with Enter", async () => {
    const onSend = vi.fn(async () => undefined);
    render(<Composer {...composerProps(conversation("f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1"), { customAgents: [reviewer], onSend })} />);
    const input = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(input, { target: { value: "/calling nobody" } });
    const listbox = await screen.findByRole("listbox", { name: "Custom agents" });
    expect(within(listbox).getByRole("status")).toHaveTextContent("No matching agent.");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox", { name: "Custom agents" })).toBeNull();
    expect(input).not.toHaveAttribute("role");
  });

  it("offers Settings when no custom agents exist", async () => {
    const onOpenCustomAgentSettings = vi.fn();
    render(<Composer {...composerProps(conversation("a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2"), { customAgents: [], onOpenCustomAgentSettings })} />);
    const input = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(input, { target: { value: "/calling" } });
    const listbox = await screen.findByRole("listbox", { name: "Custom agents" });
    expect(within(listbox).getByRole("status")).toHaveTextContent("No custom agents yet");
    const create = within(listbox).getByRole("option", { name: "Create one in Settings" });
    expect(input).toHaveAttribute("aria-activedescendant", create.id);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onOpenCustomAgentSettings).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("listbox", { name: "Custom agents" })).toBeNull();
    fireEvent.change(input, { target: { value: "/calling " } });
    fireEvent.click(await screen.findByRole("option", { name: "Create one in Settings" }));
    expect(onOpenCustomAgentSettings).toHaveBeenCalledTimes(2);
  });

  it("keeps the chip per conversation and after a failed send", async () => {
    const first = conversation("a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3");
    const second = conversation("b3b3b3b3-b3b3-4b3b-8b3b-b3b3b3b3b3b3");
    const onSend = vi.fn(async () => {
      throw new Error("The custom agent you called no longer exists.");
    });
    const { rerender } = render(<Composer {...composerProps(first, { customAgents: [reviewer], onSend })} />);
    const input = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(input, { target: { value: "/calling" } });
    await screen.findByRole("listbox", { name: "Custom agents" });
    fireEvent.keyDown(input, { key: "Tab" });
    await screen.findByLabelText("Calling Code reviewer");

    rerender(<Composer {...composerProps(second, { customAgents: [reviewer], onSend })} />);
    expect(screen.queryByLabelText("Calling Code reviewer")).toBeNull();
    rerender(<Composer {...composerProps(first, { customAgents: [reviewer], onSend })} />);
    expect(await screen.findByLabelText("Calling Code reviewer")).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "Review the diff" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("Review the diff", [], { calledAgent: { agentId: reviewer.id } }));
    await waitFor(() => expect(input).toHaveValue("Review the diff"));
    expect(screen.getByLabelText("Calling Code reviewer")).toBeInTheDocument();
  });

  it("holds a called agent until the running turn ends instead of queueing it", async () => {
    const onSend = vi.fn(async () => undefined);
    const current = conversation("c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3");
    window.localStorage.setItem(`inertia:called-agent:${current.id}`, reviewer.id);
    render(<Composer {...composerProps(current, { customAgents: [reviewer], onSend, running: true })} />);
    const input = screen.getByRole("textbox", { name: "Message" });
    expect(await screen.findByLabelText("Calling Code reviewer")).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "Review after this turn" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Tab" });
    expect(onSend).not.toHaveBeenCalled();
    expect(input).toHaveValue("Review after this turn");
  });

  it("parses a /calling handle followed by the task", () => {
    expect(parseCallingInvocation("/calling reviewer fix the login bug")).toEqual({ handle: "reviewer", rest: "fix the login bug" });
    expect(parseCallingInvocation(" /calling Reviewer ")).toEqual({ handle: "reviewer", rest: "" });
    expect(parseCallingInvocation("/calling")).toEqual({ handle: null, rest: "" });
    expect(parseCallingInvocation("/callingreviewer")).toBeNull();
    expect(parseTypedCall("/calling reviewer")).toBeNull();
    expect(parseTypedCall("/calling reviewer ")).toEqual({ handle: "reviewer", rest: "" });
    expect(parseTypedCall("/calling reviewer fix it")).toEqual({ handle: "reviewer", rest: "fix it" });
  });

  it("moves a typed handle and its task into the chip and keeps the task text", async () => {
    const onSend = vi.fn(async () => undefined);
    render(<Composer {...composerProps(conversation("a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a4a4"), { customAgents: [reviewer, scout], onSend })} />);
    const input = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(input, { target: { value: "/calling scout collect the failing cases" } });
    expect(await screen.findByRole("group", { name: "Calling Evidence scout" })).toBeInTheDocument();
    await waitFor(() => expect(input).toHaveValue("collect the failing cases"));
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("collect the failing cases", [], { calledAgent: { agentId: scout.id } }));
  });

  it("never sends a dismissed /calling command as plain text", async () => {
    const onSend = vi.fn(async () => undefined);
    render(<Composer {...composerProps(conversation("b4b4b4b4-b4b4-4b4b-8b4b-b4b4b4b4b4b4"), { customAgents: [reviewer, scout], onSend })} />);
    const input = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(input, { target: { value: "/calling scout" } });
    await screen.findByRole("listbox", { name: "Custom agents" });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox", { name: "Custom agents" })).toBeNull();
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(onSend).not.toHaveBeenCalled();
    expect(await screen.findByRole("group", { name: "Calling Evidence scout" })).toBeInTheDocument();
    expect(input).toHaveValue("");

    fireEvent.change(input, { target: { value: "/calling nobody look into it" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("No custom agent answers to /calling nobody.");
  });

  it("resets the highlight when the query changes so a finished exact handle wins", async () => {
    const plainReviewer = agent({ id: "c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c4c4", name: "Reviewer", handle: "reviewer", position: 2 });
    render(<Composer {...composerProps(conversation("d4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4d4"), { customAgents: [reviewer, plainReviewer] })} />);
    const input = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(input, { target: { value: "/calling rev" } });
    const listbox = await screen.findByRole("listbox", { name: "Custom agents" });
    expect(input).toHaveAttribute("aria-activedescendant", `${listbox.id}-${plainReviewer.id}`);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute("aria-activedescendant", `${listbox.id}-${reviewer.id}`);
    fireEvent.change(input, { target: { value: "/calling reviewer" } });
    await waitFor(() => expect(input).toHaveAttribute("aria-activedescendant", `${listbox.id}-${plainReviewer.id}`));
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByRole("group", { name: "Calling Reviewer" })).toBeInTheDocument();
  });

  it("marks a deleted called agent, blocks sending and clears the stored chip on remove", async () => {
    const onSend = vi.fn(async () => undefined);
    const current = conversation("e4e4e4e4-e4e4-4e4e-8e4e-e4e4e4e4e4e4");
    const key = `inertia:called-agent:${current.id}`;
    window.localStorage.setItem(key, "f4f4f4f4-f4f4-4f4f-8f4f-f4f4f4f4f4f4");
    const { rerender } = render(<Composer {...composerProps(current, { onSend })} />);
    expect(screen.queryByRole("group", { name: "Agent deleted" })).toBeNull();
    rerender(<Composer {...composerProps(current, { customAgents: [scout], onSend })} />);
    const chip = await screen.findByRole("group", { name: "Agent deleted" });
    expect(chip).toHaveClass("is-deleted");
    const input = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(input, { target: { value: "Review this" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("The agent you called was deleted. Remove it to send.");
    fireEvent.click(within(chip).getByRole("button", { name: "Remove deleted agent" }));
    await waitFor(() => expect(screen.queryByRole("group", { name: "Agent deleted" })).toBeNull());
    expect(window.localStorage.getItem(key)).toBeNull();
  });

  it("forgets the stored chip of a deleted conversation", () => {
    window.localStorage.setItem("inertia:called-agent:gone", scout.id);
    forgetCalledAgent("gone");
    expect(window.localStorage.getItem("inertia:called-agent:gone")).toBeNull();
  });

  it("draws larger called marks in the chip and menu rows, never live", () => {
    const marked = { ...scout, icon: { kind: "mark" as const, name: "scout" as const } };
    const chip = render(<ComposerCalledAgentChip agent={marked} onRemove={() => undefined} />);
    const chipAvatar = chip.container.querySelector<HTMLElement>(".custom-agent-avatar")!;
    expect(chipAvatar).toHaveAttribute("data-mark", "scout");
    expect(chipAvatar).not.toHaveAttribute("data-live");
    expect(chipAvatar.style.getPropertyValue("--agent-avatar-size")).toBe("28px");
    chip.unmount();
    const menu = render(
      <ComposerAgentCallMenu
        listboxId="agents"
        agents={[marked]}
        query=""
        hasAgents
        activeAgentId={marked.id}
        canOpenSettings={false}
        onActiveAgentChange={() => undefined}
        onPick={() => undefined}
        onOpenSettings={() => undefined}
      />,
    );
    const row = within(menu.container).getByRole("option");
    expect(row).toHaveAttribute("data-active", "true");
    expect(row.querySelector(".custom-agent-avatar")).toHaveAttribute("data-mark", "scout");
    expect(row.querySelector<HTMLElement>(".custom-agent-avatar")!.style.getPropertyValue("--agent-avatar-size")).toBe("36px");
  });
});
