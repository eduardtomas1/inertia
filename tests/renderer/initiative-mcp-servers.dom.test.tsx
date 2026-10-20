import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  InitiativeMcpServers,
  type InitiativeMcpSecretBridge,
} from "../../src/renderer/src/components/initiatives/InitiativeMcpServers";
import type { Initiative, InitiativeMcpServer, InitiativePreferencesPatch } from "../../src/shared/contracts";
import { defaultInitiativePreferences } from "../../src/shared/initiatives";

const AT = "2026-10-19T08:00:00.000Z";
const SECRET = "typed-secret-value-81f2";
const SERVER_ID = "22222222-2222-4222-8222-222222222222";

function initiative(mcpServers: InitiativeMcpServer[] = []): Initiative {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    name: "Checkout",
    color: "teal",
    status: "active",
    brief: "",
    preferences: { ...defaultInitiativePreferences(), mcpServers },
    briefRevision: 0,
    briefUpdatedAt: null,
    notesRevision: 0,
    proposedNoteCount: 0,
    revision: 3,
    createdAt: AT,
    updatedAt: AT,
  };
}

const tracker: InitiativeMcpServer = {
  id: SERVER_ID,
  name: "tracker",
  enabled: true,
  transport: {
    kind: "http",
    url: "https://mcp.example.com/mcp",
    headers: [{ name: "Authorization", secret: true }, { name: "X-Team", value: "checkout" }],
  },
};

function bridge(slots: Record<string, boolean> = {}) {
  const calls: string[] = [];
  const secrets = {
    setInitiativeMcpSecret: vi.fn(async (request: Parameters<InitiativeMcpSecretBridge["setInitiativeMcpSecret"]>[0]) => {
      calls.push("set");
      slots[request.slot] = true;
      return { slots: { [request.slot]: true }, storageAvailable: true };
    }),
    getInitiativeMcpSecretState: vi.fn(async (request: Parameters<InitiativeMcpSecretBridge["getInitiativeMcpSecretState"]>[0]) => ({
      slots: Object.fromEntries(request.slots.map((slot) => [slot, slots[slot] === true])),
      storageAvailable: true,
    })),
  } satisfies InitiativeMcpSecretBridge;
  return { secrets, calls, slots };
}

function setup(servers: InitiativeMcpServer[] = [], options: { slots?: Record<string, boolean>; offline?: boolean; applied?: boolean } = {}) {
  const { secrets, calls } = bridge(options.slots);
  const onChange = vi.fn(async (_patch: InitiativePreferencesPatch) => {
    calls.push("change");
    return options.applied ?? true;
  });
  const view = render(
    <InitiativeMcpServers initiative={initiative(servers)} offline={options.offline ?? false} onChange={onChange} secrets={secrets} />,
  );
  const card = () => within(screen.getByRole("region", { name: "MCP servers" }));
  return {
    ...view,
    card,
    onChange,
    secrets,
    calls,
    rerenderWith: (next: InitiativeMcpServer[]) => view.rerender(
      <InitiativeMcpServers initiative={initiative(next)} offline={false} onChange={onChange} secrets={secrets} />,
    ),
  };
}

const sentServers = (onChange: ReturnType<typeof vi.fn>) =>
  (onChange.mock.calls.at(-1)![0] as InitiativePreferencesPatch).mcpServers!;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Initiative MCP servers", () => {
  it("says where the servers apply and which providers take them", () => {
    const { card } = setup();
    expect(card().getByText(/No MCP servers\./u)).toBeVisible();
    expect(card().getByText("Works with Codex, Claude, Cursor, Kimi Code, OpenCode. Not available on Antigravity.")).toBeVisible();
    expect(card().getByText(/Changes reach each chat with its next message\./u)).toBeVisible();
    expect(card().getByText("0 of 8")).toBeVisible();
  });

  it("adds an HTTP server, saving it before its secret, which is typed once and never echoed", async () => {
    const { card, onChange, secrets, calls, container } = setup();
    fireEvent.click(card().getByRole("button", { name: "Add MCP server" }));
    const form = within(screen.getByRole("form", { name: "Add MCP server" }));
    expect(form.getByRole("textbox", { name: "Server name" })).toHaveFocus();
    fireEvent.change(form.getByRole("textbox", { name: "Server name" }), { target: { value: "tracker" } });
    fireEvent.change(form.getByRole("textbox", { name: "Server URL" }), { target: { value: "https://mcp.example.com/mcp" } });
    fireEvent.click(form.getByRole("button", { name: "Add header" }));
    fireEvent.change(form.getByRole("textbox", { name: "Header name" }), { target: { value: "Authorization" } });
    // Authorization is always secret: ticked, and it cannot be unticked.
    expect(form.getByRole("checkbox", { name: "Keep Authorization secret" })).toBeChecked();
    expect(form.getByRole("checkbox", { name: "Keep Authorization secret" })).toBeDisabled();
    const secretInput = form.getByLabelText("Value of Authorization");
    expect(secretInput).toHaveAttribute("type", "password");
    expect(secretInput).toHaveAttribute("autocomplete", "new-password");
    fireEvent.change(secretInput, { target: { value: SECRET } });
    await act(async () => { fireEvent.click(form.getByRole("button", { name: "Add server" })); });

    await waitFor(() => expect(secrets.setInitiativeMcpSecret).toHaveBeenCalledTimes(1));
    const [server] = sentServers(onChange);
    expect(server).toMatchObject({
      name: "tracker",
      enabled: true,
      transport: { kind: "http", url: "https://mcp.example.com/mcp", headers: [{ name: "Authorization", secret: true }] },
    });
    // The runtime only ever receives "secret"; the value goes to secure storage after.
    expect(JSON.stringify(onChange.mock.calls)).not.toContain(SECRET);
    expect(calls).toEqual(["change", "set"]);
    expect(secrets.setInitiativeMcpSecret).toHaveBeenCalledWith({
      initiativeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      serverId: server!.id,
      transport: server!.transport,
      slot: "header:authorization",
      value: SECRET,
    });
    await waitFor(() => expect(screen.queryByRole("form")).toBeNull());
    expect(container.innerHTML).not.toContain(SECRET);
    await waitFor(() => expect(card().getByRole("button", { name: "Add MCP server" })).toHaveFocus());
  });

  it("shows a stored secret only as Set and replaces it without reading it back", async () => {
    const { card, onChange, secrets, container } = setup([tracker], { slots: { "header:authorization": true } });
    await waitFor(() => expect(secrets.getInitiativeMcpSecretState).toHaveBeenCalledWith({
      initiativeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      serverId: SERVER_ID,
      transport: tracker.transport,
      slots: ["header:authorization"],
    }));
    const list = within(card().getByRole("list", { name: "MCP servers for this initiative" }));
    expect(list.getByText("tracker")).toBeVisible();
    expect(list.getByText("https://mcp.example.com/mcp")).toBeVisible();
    fireEvent.click(list.getByRole("button", { name: "Edit tracker" }));
    const form = within(screen.getByRole("form", { name: "Edit tracker" }));
    await waitFor(() => expect(form.getByText("Set")).toBeVisible());
    expect(form.queryByLabelText("Value of Authorization")).toBeNull();
    expect(form.getByRole("textbox", { name: "Value of X-Team" })).toHaveValue("checkout");
    fireEvent.click(form.getByRole("button", { name: "Replace the secret Authorization" }));
    // The value field takes the button's place and keeps the focus.
    await waitFor(() => expect(form.getByLabelText("Value of Authorization")).toHaveFocus());
    fireEvent.change(form.getByLabelText("Value of Authorization"), { target: { value: SECRET } });
    await act(async () => { fireEvent.click(form.getByRole("button", { name: "Save server" })); });
    await waitFor(() => expect(secrets.setInitiativeMcpSecret).toHaveBeenCalledWith(expect.objectContaining({
      serverId: SERVER_ID, slot: "header:authorization", value: SECRET,
    })));
    // Same address, same identity: the server keeps its id.
    expect(sentServers(onChange)).toEqual([tracker]);
    expect(container.innerHTML).not.toContain(SECRET);
  });

  it("keeps a moved server's identity and asks for its secrets again for the new address", async () => {
    const { card, onChange, secrets } = setup([tracker], { slots: { "header:authorization": true } });
    fireEvent.click(card().getByRole("button", { name: "Edit tracker" }));
    const form = within(screen.getByRole("form", { name: "Edit tracker" }));
    fireEvent.change(form.getByRole("textbox", { name: "Server URL" }), { target: { value: "https://other.example.com/mcp" } });
    expect(form.getByText("Secrets stay with the address they were entered for: enter them again for this one.")).toBeVisible();
    await act(async () => { fireEvent.click(form.getByRole("button", { name: "Save server" })); });
    expect(form.getByRole("alert")).toHaveTextContent("Enter the secret value for Authorization.");
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(form.getByLabelText("Value of Authorization"), { target: { value: SECRET } });
    await act(async () => { fireEvent.click(form.getByRole("button", { name: "Save server" })); });
    await waitFor(() => expect(secrets.setInitiativeMcpSecret).toHaveBeenCalled());
    const [moved] = sentServers(onChange);
    expect(moved!.id).toBe(SERVER_ID);
    expect(moved!.transport).toMatchObject({ url: "https://other.example.com/mcp" });
    // The secret is stored for the new address only.
    expect(secrets.setInitiativeMcpSecret).toHaveBeenCalledWith(expect.objectContaining({
      serverId: SERVER_ID, transport: moved!.transport, value: SECRET,
    }));
  });

  it("refuses a secret too short to hide reliably, before anything is sent", async () => {
    const { card, onChange, secrets } = setup();
    fireEvent.click(card().getByRole("button", { name: "Add MCP server" }));
    const form = within(screen.getByRole("form", { name: "Add MCP server" }));
    fireEvent.change(form.getByRole("textbox", { name: "Server name" }), { target: { value: "tracker" } });
    fireEvent.change(form.getByRole("textbox", { name: "Server URL" }), { target: { value: "https://mcp.example.com/mcp" } });
    fireEvent.click(form.getByRole("button", { name: "Add header" }));
    fireEvent.change(form.getByRole("textbox", { name: "Header name" }), { target: { value: "X-Api-Key" } });
    for (const value of ["x", "1234567"]) {
      fireEvent.change(form.getByLabelText("Value of X-Api-Key"), { target: { value } });
      await act(async () => { fireEvent.click(form.getByRole("button", { name: "Add server" })); });
      expect(form.getByRole("alert")).toHaveTextContent("X-Api-Key: Use a secret of at least 8 characters.");
    }
    expect(onChange).not.toHaveBeenCalled();
    expect(secrets.setInitiativeMcpSecret).not.toHaveBeenCalled();
  });

  it("marks credential-shaped names secret, unless the user unticks them", () => {
    const { card } = setup();
    fireEvent.click(card().getByRole("button", { name: "Add MCP server" }));
    const form = within(screen.getByRole("form", { name: "Add MCP server" }));
    fireEvent.click(form.getByRole("button", { name: "Add header" }));
    fireEvent.click(form.getByRole("button", { name: "Add header" }));
    const [first, second] = form.getAllByRole("textbox", { name: "Header name" });
    fireEvent.change(first!, { target: { value: "X-Team" } });
    expect(form.getByRole("checkbox", { name: "Keep X-Team secret" })).not.toBeChecked();
    fireEvent.change(second!, { target: { value: "X-Access-Token" } });
    const token = form.getByRole("checkbox", { name: "Keep X-Access-Token secret" });
    expect(token).toBeChecked();
    expect(token).toBeEnabled();
    expect(form.getByLabelText("Value of X-Access-Token")).toHaveAttribute("type", "password");
    // Unticked by the user, it stays plain while the name changes.
    fireEvent.click(token);
    fireEvent.change(form.getAllByRole("textbox", { name: "Header name" })[1]!, { target: { value: "X-Access-Tokens" } });
    expect(form.getByRole("checkbox", { name: "Keep X-Access-Tokens secret" })).not.toBeChecked();
    // Cookie and Proxy-Authorization are always secret.
    for (const name of ["Cookie", "Proxy-Authorization"]) {
      fireEvent.change(form.getAllByRole("textbox", { name: "Header name" })[1]!, { target: { value: name } });
      expect(form.getByRole("checkbox", { name: `Keep ${name} secret` })).toBeChecked();
      expect(form.getByRole("checkbox", { name: `Keep ${name} secret` })).toBeDisabled();
    }
  });

  it("adds a command server with arguments and plain and secret variables", async () => {
    const { card, onChange, secrets } = setup();
    fireEvent.click(card().getByRole("button", { name: "Add MCP server" }));
    const form = within(screen.getByRole("form", { name: "Add MCP server" }));
    fireEvent.change(form.getByRole("textbox", { name: "Server name" }), { target: { value: "docs" } });
    fireEvent.change(form.getByRole("combobox", { name: "Connection" }), { target: { value: "stdio" } });
    expect(form.getByText("The provider starts the command itself, without a shell.")).toBeVisible();
    fireEvent.change(form.getByRole("textbox", { name: "Command" }), { target: { value: "npx" } });
    fireEvent.change(form.getByRole("textbox", { name: "Arguments, one per line" }), { target: { value: "-y\n@example/docs-mcp\n" } });
    fireEvent.click(form.getByRole("button", { name: "Add variable" }));
    fireEvent.click(form.getByRole("button", { name: "Add variable" }));
    const names = form.getAllByRole("textbox", { name: "Variable name" });
    fireEvent.change(names[0]!, { target: { value: "DOCS_REGION" } });
    fireEvent.change(form.getByRole("textbox", { name: "Value of DOCS_REGION" }), { target: { value: "eu" } });
    fireEvent.change(names[1]!, { target: { value: "DOCS_TOKEN" } });
    // A *_TOKEN variable starts out secret.
    expect(form.getByRole("checkbox", { name: "Keep DOCS_TOKEN secret" })).toBeChecked();
    fireEvent.change(form.getByLabelText("Value of DOCS_TOKEN"), { target: { value: SECRET } });
    await act(async () => { fireEvent.click(form.getByRole("button", { name: "Add server" })); });
    await waitFor(() => expect(secrets.setInitiativeMcpSecret).toHaveBeenCalledWith(expect.objectContaining({ slot: "env:DOCS_TOKEN" })));
    expect(sentServers(onChange)[0]!.transport).toEqual({
      kind: "stdio",
      command: "npx",
      args: ["-y", "@example/docs-mcp"],
      env: [{ name: "DOCS_REGION", value: "eu" }, { name: "DOCS_TOKEN", secret: true }],
    });
  });

  it("explains a refused configuration before anything is sent", async () => {
    const { card, onChange, secrets } = setup();
    fireEvent.click(card().getByRole("button", { name: "Add MCP server" }));
    const form = within(screen.getByRole("form", { name: "Add MCP server" }));
    fireEvent.change(form.getByRole("textbox", { name: "Server name" }), { target: { value: "inertia-tools" } });
    fireEvent.change(form.getByRole("textbox", { name: "Server URL" }), { target: { value: "https://mcp.example.com/mcp" } });
    await act(async () => { fireEvent.click(form.getByRole("button", { name: "Add server" })); });
    expect(form.getByRole("alert")).toHaveTextContent("Names starting with “inertia” are reserved");
    fireEvent.change(form.getByRole("textbox", { name: "Server name" }), { target: { value: "tracker" } });
    fireEvent.change(form.getByRole("textbox", { name: "Server URL" }), { target: { value: "http://mcp.example.com/mcp" } });
    await act(async () => { fireEvent.click(form.getByRole("button", { name: "Add server" })); });
    expect(form.getByRole("alert")).toHaveTextContent("Plain http:// is allowed only for this computer");
    expect(form.getByRole("button", { name: "Add server" })).toHaveAccessibleDescription(/Plain http:\/\//u);
    expect(onChange).not.toHaveBeenCalled();
    expect(secrets.setInitiativeMcpSecret).not.toHaveBeenCalled();
  });

  it("turns a server off and removes it after a confirmation", async () => {
    const { card, onChange, rerenderWith } = setup([tracker], { slots: { "header:authorization": true } });
    await act(async () => { fireEvent.click(card().getByRole("switch", { name: "Use tracker" })); });
    await waitFor(() => expect(sentServers(onChange)).toEqual([{ ...tracker, enabled: false }]));
    rerenderWith([{ ...tracker, enabled: false }]);
    fireEvent.click(card().getByRole("button", { name: "Remove tracker" }));
    expect(card().getByText("Remove tracker and its secrets?")).toBeVisible();
    // The confirmation takes the button's place; focus moves to its safe choice.
    await waitFor(() => expect(card().getByRole("button", { name: "Keep" })).toHaveFocus());
    fireEvent.click(card().getByRole("button", { name: "Keep" }));
    await waitFor(() => expect(card().getByRole("button", { name: "Remove tracker" })).toHaveFocus());
    expect(onChange).toHaveBeenCalledTimes(1);
    fireEvent.click(card().getByRole("button", { name: "Remove tracker" }));
    await act(async () => { fireEvent.click(card().getByRole("button", { name: "Remove" })); });
    await waitFor(() => expect(sentServers(onChange)).toEqual([]));
    await waitFor(() => expect(card().getByRole("button", { name: "Add MCP server" })).toHaveFocus());
  });

  it("builds a quick second change on the first, even before the snapshot shows it", async () => {
    const docs: InitiativeMcpServer = { ...tracker, id: "33333333-3333-4333-8333-333333333333", name: "docs", transport: { kind: "http", url: "https://docs.example.com/mcp", headers: [] } };
    const { card, onChange } = setup([tracker, docs]);
    await act(async () => { fireEvent.click(card().getByRole("switch", { name: "Use tracker" })); });
    await waitFor(() => expect(card().getByRole("switch", { name: "Use docs" })).toBeEnabled());
    await act(async () => { fireEvent.click(card().getByRole("switch", { name: "Use docs" })); });
    await waitFor(() => expect(sentServers(onChange)).toEqual([{ ...tracker, enabled: false }, { ...docs, enabled: false }]));
  });

  it("shows a newer snapshot over the list it last saved", async () => {
    const view = setup([tracker]);
    const { card, onChange } = view;
    await act(async () => { fireEvent.click(card().getByRole("switch", { name: "Use tracker" })); });
    await waitFor(() => expect(sentServers(onChange)).toEqual([{ ...tracker, enabled: false }]));
    expect(card().getByRole("switch", { name: "Use tracker" })).not.toBeChecked();
    // Another window saved a different list first: the newer revision wins.
    const other: InitiativeMcpServer = { ...tracker, id: "44444444-4444-4444-8444-444444444444", name: "wiki" };
    view.rerender(
      <InitiativeMcpServers
        initiative={{ ...initiative([tracker, other]), revision: 5 }}
        offline={false}
        onChange={onChange}
        secrets={view.secrets}
      />,
    );
    expect(card().getByRole("switch", { name: "Use tracker" })).toBeChecked();
    expect(card().getByRole("switch", { name: "Use wiki" })).toBeVisible();
  });

  it("warns about a secret that is not set and keeps keyboard and offline behaviour", async () => {
    const confirm = vi.fn().mockReturnValue(false);
    vi.stubGlobal("confirm", confirm);
    const { card } = setup([tracker], { slots: {} });
    await waitFor(() => expect(card().getByText(/Secret not set: Authorization\./u)).toBeVisible());
    fireEvent.click(card().getByRole("button", { name: "Add MCP server" }));
    const form = screen.getByRole("form", { name: "Add MCP server" });
    // Escape without changes closes at once; with changes it asks first.
    fireEvent.keyDown(within(form).getByRole("textbox", { name: "Server name" }), { key: "Escape" });
    expect(screen.queryByRole("form")).toBeNull();
    fireEvent.click(card().getByRole("button", { name: "Add MCP server" }));
    const reopened = within(screen.getByRole("form", { name: "Add MCP server" }));
    fireEvent.change(reopened.getByRole("textbox", { name: "Server name" }), { target: { value: "draft" } });
    fireEvent.keyDown(reopened.getByRole("textbox", { name: "Server name" }), { key: "Escape" });
    expect(confirm).toHaveBeenCalledWith("Discard this server's changes?");
    expect(screen.getByRole("form", { name: "Add MCP server" })).toBeVisible();
    // Cancel asks the same question for a changed form.
    fireEvent.click(reopened.getByRole("button", { name: "Cancel" }));
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("form", { name: "Add MCP server" })).toBeVisible();
    confirm.mockReturnValue(true);
    fireEvent.click(reopened.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("form")).toBeNull();
    await waitFor(() => expect(card().getByRole("button", { name: "Add MCP server" })).toHaveFocus());

    const offline = setup([], { offline: true });
    expect(within(offline.container).getByRole("button", { name: "Add MCP server" })).toBeDisabled();
  });
});
