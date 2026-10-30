import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ClientCommand, ServerEvent } from "../../src/shared/contracts";
import { CursorSdkContext, type CursorSdkTransport } from "../../src/renderer/src/components/cursor-sdk/CursorSdkContext";
import { ModelChooser } from "../../src/renderer/src/components/ModelChooser";
import { cursorSdkModelRoute } from "../../src/renderer/src/components/cursor-sdk/cursorSdkModelRoute";

function setup(available = true, hasCredential = true) {
  const sendCommand = vi.fn(async (command: ClientCommand): Promise<ServerEvent> => {
    if (command.type === "provider.cursor-sdk.status") return {
      type: "request.result", requestId: command.requestId,
      result: { kind: "provider.cursor-sdk.status", available, hasCredential, sdkVersion: "1.0.38" },
    };
    if (command.type === "provider.cursor-sdk.models") return {
      type: "request.result", requestId: command.requestId,
      result: { kind: "provider.cursor-sdk.models", models: [
        { id: "synthetic-concrete", displayName: "Synthetic concrete" },
        { id: "provider-default", displayName: "Synthetic default" },
      ] },
    };
    throw new Error("Unexpected synthetic command");
  });
  const transport: CursorSdkTransport = { status: "online", sendCommand, subscribe: () => () => undefined };
  const onSelect = vi.fn();
  const route = cursorSdkModelRoute({ id: "synthetic-existing", displayName: "Synthetic existing" })!;
  const view = render(<CursorSdkContext.Provider value={transport}>
    <ModelChooser routes={[]} selectedRoute={route} onSelect={onSelect} />
  </CursorSdkContext.Provider>);
  return { sendCommand, onSelect, view };
}

async function loadModels() {
  fireEvent.click(screen.getByRole("button", { expanded: false }));
  fireEvent.click(await screen.findByRole("button", { name: "Load Cursor SDK models" }));
}

describe("Cursor SDK in the actual model chooser", () => {
  it("probes before discovery and selects only an explicit concrete SDK route", async () => {
    const f = setup();
    expect(f.sendCommand).not.toHaveBeenCalled();
    await loadModels();
    const model = await screen.findByRole("button", { name: "Synthetic concrete · Cursor SDK" });
    expect(f.sendCommand.mock.calls.map(([command]) => command.type)).toEqual(["provider.cursor-sdk.status", "provider.cursor-sdk.models"]);
    expect(screen.queryByText("Synthetic default · Cursor SDK")).toBeNull();
    expect(f.onSelect).not.toHaveBeenCalled();
    fireEvent.click(model);
    expect(f.onSelect).toHaveBeenCalledWith(expect.objectContaining({ selection: expect.objectContaining({
      harnessId: "cursor-sdk", backendProfileId: "builtin:cursor", modelId: "synthetic-concrete",
      alias: null, reasoningEffort: null, contextWindowOverride: null, providerOptions: {}, capabilities: [],
    }) }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Choose model" })).toBeNull());
  });

  it.each([[false, true], [true, false]])("never discovers without availability and credential presence (%s, %s)", async (available, hasCredential) => {
    const f = setup(available, hasCredential);
    await loadModels();
    await screen.findByText(available ? "Sign in with Cursor SDK in Accounts and API keys first." : "Cursor SDK is unavailable in this installation.");
    expect(f.sendCommand).toHaveBeenCalledTimes(1);
    expect(f.onSelect).not.toHaveBeenCalled();
  });
});
