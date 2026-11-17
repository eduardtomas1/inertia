import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProviderSlashCommand } from "../../src/shared/contracts";
import { Composer } from "../../src/renderer/src/components/Composer";
import { composerProps, conversation } from "./composer-fixtures";

const COMMANDS: ProviderSlashCommand[] = [
  { name: "advisor", description: "Set the advisor model", argumentHint: "<fable|opus|sonnet|off>" },
  { name: "code-review", description: "Review the current diff", argumentHint: null },
  // A provider command that shares a name with Inertia's own stays Inertia's.
  { name: "resume", description: "Provider resume", argumentHint: null },
];

let conversationIndex = 0;

function setup(load = vi.fn(async () => COMMANDS), onSend = vi.fn(async () => undefined)) {
  conversationIndex += 1;
  const current = conversation(`e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e${conversationIndex}`);
  render(<Composer {...composerProps(current, { onListProviderCommands: load, onSend })} />);
  return { current, load, onSend, input: screen.getByRole("textbox", { name: "Message" }) };
}

afterEach(() => {
  window.localStorage.clear();
});

const MENU_TIMEOUT = { timeout: 5_000 };

describe("composer provider slash commands", () => {
  it("lists the provider's commands under Provider when the slash menu opens", async () => {
    const { current, load, input } = setup();
    expect(load).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "/" } });
    const commands = await screen.findByRole("listbox", { name: "Composer commands" }, MENU_TIMEOUT);
    await waitFor(() => expect(within(commands).getByRole("option", { name: /\/advisor/u })).toBeInTheDocument());
    expect(load).toHaveBeenCalledWith(current.projectId, current.providerId);
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

  it("keeps Inertia's own commands when the provider list cannot be loaded", async () => {
    const { input } = setup(vi.fn(async () => { throw new Error("offline"); }));
    fireEvent.change(input, { target: { value: "/" } });
    const commands = await screen.findByRole("listbox", { name: "Composer commands" }, MENU_TIMEOUT);
    expect(within(commands).getByRole("option", { name: /\/plan/u })).toBeInTheDocument();
    expect(within(commands).queryByRole("option", { name: /\/advisor/u })).toBeNull();
  });
});
