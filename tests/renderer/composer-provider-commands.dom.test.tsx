import { fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Conversation, ProviderSlashCommand, ServerEvent } from "../../src/shared/contracts";
import { Composer } from "../../src/renderer/src/components/Composer";
import {
  useAgentWorkflows,
  type ProviderCommandsLoader,
  type ProviderCommandsTarget,
} from "../../src/renderer/src/hooks/useAgentWorkflows";
import type { CommandWithoutId } from "../../src/renderer/src/lib/runtimeCommands";
import { composerProps, conversation } from "./composer-fixtures";

const COMMANDS: ProviderSlashCommand[] = [
  { name: "advisor", description: "Set the advisor model", argumentHint: "<fable|opus|sonnet|off>" },
  { name: "code-review", description: "Review the current diff", argumentHint: null },
  { name: "resume", description: "Provider resume", argumentHint: null },
];

let conversationIndex = 0;

function nextConversation(): Conversation {
  conversationIndex += 1;
  return conversation(`e1e1e1e1-e1e1-4e1e-8e1e-${conversationIndex.toString().padStart(12, "0")}`);
}

function setup(
  load = vi.fn<ProviderCommandsLoader>(async () => COMMANDS),
  onSend = vi.fn(async () => undefined),
) {
  const current = nextConversation();
  const view = render(<Composer {...composerProps(current, { onListProviderCommands: load, onSend })} />);
  return { current, load, onSend, view, input: screen.getByRole("textbox", { name: "Message" }) };
}

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

const MENU_TIMEOUT = { timeout: 5_000 };

function target(current: Conversation): ProviderCommandsTarget {
  return { id: current.id, projectId: current.projectId, providerId: current.providerId };
}

describe("composer provider slash commands", () => {
  it("lists the provider's commands under Provider when the slash menu opens", async () => {
    const { current, load, input } = setup();
    expect(load).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "/" } });
    const commands = await screen.findByRole("listbox", { name: "Composer commands" }, MENU_TIMEOUT);
    await waitFor(() => expect(within(commands).getByRole("option", { name: /\/advisor/u })).toBeInTheDocument());
    expect(load).toHaveBeenCalledWith(target(current));
    const provider = within(commands).getByRole("group", { name: "Provider" });
    expect(within(provider).getByRole("option", { name: /\/advisor/u })).toHaveTextContent("<fable|opus|sonnet|off>");
    expect(within(provider).getByRole("option", { name: /\/code-review/u })).toHaveTextContent("Review the current diff");
    expect(within(commands).getAllByRole("option", { name: /\/resume/u })).toHaveLength(1);
    expect(within(commands).queryByText("Provider resume")).toBeNull();
  });

  it("filters hyphenated names and completes the highlighted command with Tab or Enter", async () => {
    const { input, onSend } = setup();
    fireEvent.change(input, { target: { value: "/code-r" } });
    const commands = await screen.findByRole("listbox", { name: "Composer commands" }, MENU_TIMEOUT);
    await waitFor(() => expect(within(commands).getAllByRole("option")).toHaveLength(1));
    fireEvent.keyDown(input, { key: "Tab" });
    expect(input).toHaveValue("/code-review ");
    expect(screen.queryByRole("listbox", { name: "Composer commands" })).toBeNull();

    fireEvent.change(input, { target: { value: "/adv" } });
    await screen.findByRole("option", { name: /\/advisor/u }, MENU_TIMEOUT);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input).toHaveValue("/advisor ");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("sends an exactly typed provider command instead of completing it", async () => {
    const { input, onSend } = setup();
    fireEvent.change(input, { target: { value: "/advisor" } });
    await screen.findByRole("option", { name: /\/advisor/u }, MENU_TIMEOUT);
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect((onSend.mock.calls[0] as unknown[] | undefined)?.[0]).toBe("/advisor");
  });

  it("sends a provider command with arguments as typed, without the menu", async () => {
    const { input, onSend, load } = setup();
    fireEvent.change(input, { target: { value: "/advisor fable" } });
    expect(screen.queryByRole("listbox", { name: "Composer commands" })).toBeNull();
    expect(load).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect((onSend.mock.calls[0] as unknown[] | undefined)?.[0]).toBe("/advisor fable");
  });

  it("keeps Inertia's own commands, asks once and logs nothing when the provider list fails", async () => {
    const consoleError = vi.spyOn(console, "error");
    const consoleWarn = vi.spyOn(console, "warn");
    const load = vi.fn<ProviderCommandsLoader>(async () => { throw new Error("lifecycle corruption"); });
    const { input } = setup(load);
    fireEvent.change(input, { target: { value: "/" } });
    const commands = await screen.findByRole("listbox", { name: "Composer commands" }, MENU_TIMEOUT);
    fireEvent.change(input, { target: { value: "/p" } });
    fireEvent.change(input, { target: { value: "/pl" } });
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(load).toHaveBeenCalledTimes(1);
    expect(within(commands).getByRole("option", { name: /\/plan/u })).toBeInTheDocument();
    expect(within(commands).queryByRole("group", { name: "Provider" })).toBeNull();
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
  });

  it("caches commands per conversation and never shows one chat's list in another", async () => {
    const first = nextConversation();
    const second = nextConversation();
    const load = vi.fn<ProviderCommandsLoader>(async (requested) =>
      requested.id === first.id ? COMMANDS : [{ name: "deploy", description: "Second chat only", argumentHint: null }]);
    const view = render(<Composer {...composerProps(first, { onListProviderCommands: load })} />);
    const input = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(input, { target: { value: "/" } });
    await screen.findByRole("option", { name: /\/advisor/u }, MENU_TIMEOUT);
    view.rerender(<Composer {...composerProps(second, { onListProviderCommands: load })} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "/" } });
    await screen.findByRole("option", { name: /\/deploy/u }, MENU_TIMEOUT);
    expect(screen.queryByRole("option", { name: /\/advisor/u })).toBeNull();
    expect(load).toHaveBeenLastCalledWith(target(second));
  });
});

describe("provider command requests", () => {
  function workflows(respond: (command: CommandWithoutId) => ServerEvent) {
    const request = vi.fn(async (command: CommandWithoutId) => respond(command));
    const { result } = renderHook(() => useAgentWorkflows({
      conversationId: null,
      routeIdentity: null,
      status: "online",
      request,
      subscribe: () => () => undefined,
    }));
    return { result, request };
  }

  const current = conversation("f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2f2");

  function answer(conversationId: string, providerId: Conversation["providerId"]): ServerEvent {
    return {
      type: "request.result",
      requestId: "r",
      result: { kind: "agent.commands", conversationId, providerId, commands: COMMANDS },
    } as ServerEvent;
  }

  it("asks by conversation for a saved chat and by project and provider for a draft", async () => {
    const { result, request } = workflows(() => answer(current.id, current.providerId));
    await expect(result.current.listProviderCommands(target(current))).resolves.toEqual(COMMANDS);
    await expect(result.current.previewProviderCommands(target(current))).resolves.toEqual(COMMANDS);
    expect(request.mock.calls.map(([command]) => command)).toEqual([
      { type: "agent.commands.list", payload: { conversationId: current.id } },
      {
        type: "agent.commands.list",
        payload: { draftConversationId: current.id, projectId: current.projectId, providerId: current.providerId },
      },
    ]);
  });

  it("rejects a response for another conversation or provider", async () => {
    for (const response of [answer("a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3", current.providerId), answer(current.id, "claude")]) {
      const { result } = workflows(() => response);
      await expect(result.current.listProviderCommands(target(current)))
        .rejects.toThrow("The local service returned an unexpected commands response.");
    }
  });
});
