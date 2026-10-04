import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppView } from "../../src/renderer/src/appView";
import { SettingsView } from "../../src/renderer/src/components/SettingsView";
import { useSettingsMode } from "../../src/renderer/src/hooks/useSettingsMode";
import { settingsViewProps } from "./settings-view-fixtures";

type SettingsOverrides = Parameters<typeof settingsViewProps>[0];

function Harness({ overrides }: { overrides?: SettingsOverrides }): React.JSX.Element {
  const [view, setView] = useState<AppView>("workspace");
  const mode = useSettingsMode({ view, navigateToView: setView });
  return (
    <>
      <section id="main-workspace" tabIndex={-1} aria-label="Main workspace">
        {view === "settings" ? (
          <SettingsView {...settingsViewProps(overrides)} target={mode.settingsTarget}
            initialSection={mode.lastSection} onSectionChange={mode.rememberSection} />
        ) : <section aria-label="Message composer"><textarea aria-label="Message" /></section>}
      </section>
      <button type="button" onClick={() => mode.openSettings()}>Open settings</button>
      <button type="button" onClick={() => mode.toggleSettings()}>Toggle settings</button>
      <output aria-label="Current view">{view}</output>
    </>
  );
}

function pressEscape(target: Element = document.activeElement ?? document.body): void {
  act(() => { target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
}

beforeEach(() => {
  Object.defineProperty(window, "inertia", {
    configurable: true,
    value: new Proxy({ getPlatform: () => "darwin" } as Record<string, unknown>, {
      get: (target, key: string) => key in target ? target[key] : key === "then" ? undefined
        : key.startsWith("on") ? vi.fn(() => () => undefined) : vi.fn(async () => null),
    }),
  });
});

afterEach(() => {
  Reflect.deleteProperty(window, "inertia");
  window.sessionStorage.clear();
});

const onReportCommand = vi.fn(async () => ({
  type: "request.result" as const, requestId: "request", result: { kind: "support.report" as const, report: null },
}));

async function typeReport(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
  fireEvent.click(screen.getByRole("button", { name: "Help" }));
  const description = await screen.findByRole("textbox", { name: "What happened" });
  await waitFor(() => expect(description).toBeEnabled());
  fireEvent.change(description, { target: { value: "Typed for five minutes" } });
  description.focus();
  return description;
}

describe("unsent issue report text across Settings mode", () => {
  it("comes back after Escape, Escape and reopening Settings", async () => {
    render(<Harness overrides={{ onReportCommand: onReportCommand as never }} />);
    const description = await typeReport();
    pressEscape(description);
    pressEscape();
    expect(screen.getByLabelText("Current view")).toHaveTextContent("workspace");
    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
    expect(await screen.findByRole("textbox", { name: "What happened" })).toHaveValue("Typed for five minutes");
  });

  it("comes back after the Settings shortcut and reopening Settings", async () => {
    render(<Harness overrides={{ onReportCommand: onReportCommand as never }} />);
    await typeReport();
    fireEvent.click(screen.getByRole("button", { name: "Toggle settings" }));
    expect(screen.getByLabelText("Current view")).toHaveTextContent("workspace");
    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
    expect(await screen.findByRole("textbox", { name: "What happened" })).toHaveValue("Typed for five minutes");
  });
});
