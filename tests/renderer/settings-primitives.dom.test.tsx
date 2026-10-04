import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SettingRadioGroup,
  SettingSelect,
  SettingSwitch,
  SettingTextField,
} from "../../src/renderer/src/components/settings/SettingControls";
import { SettingActionRow, SettingRow } from "../../src/renderer/src/components/settings/SettingsLayout";
import {
  SETTING_SAVED_VISIBLE_MS,
  useSettingAction,
} from "../../src/renderer/src/components/settings/useSettingAction";

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("setting rows", () => {
  it("marks each row with its setting id and keeps an empty status slot before saving", () => {
    const { container, rerender } = render(<SettingRow id="theme" title="Theme" description="Pick one." notice={null} />);
    const row = container.querySelector<HTMLElement>('[data-setting-id="theme"]')!;
    expect(row).toHaveClass("setting-row");
    expect(within(row).getByRole("status")).toBeEmptyDOMElement();
    expect(within(row).queryByRole("alert")).not.toBeInTheDocument();
    rerender(<SettingRow id="theme" title="Theme" description="Pick one." />);
    expect(within(row).queryByRole("status")).not.toBeInTheDocument();
  });

  it("shows action notices under the description", () => {
    render(<SettingActionRow id="cache" title="Cache" notice={{ tone: "info", text: "Cleared." }} actions={<button type="button">Clear</button>} />);
    expect(screen.getByRole("status")).toHaveTextContent("Cleared.");
  });
});

describe("SettingSwitch", () => {
  it("flips at once, announces Saved and clears it after a moment", async () => {
    vi.useFakeTimers();
    const save = deferred();
    const onChange = vi.fn(() => save.promise);
    render(<SettingSwitch id="timestamps" title="Message timestamps" checked={false} onChange={onChange} />);
    const control = screen.getByRole("switch", { name: "Message timestamps" });

    fireEvent.click(control);
    expect(control).toBeChecked();
    expect(onChange).toHaveBeenCalledWith(true);
    expect(screen.getByRole("status")).toBeEmptyDOMElement();

    await act(async () => save.resolve());
    expect(screen.getByRole("status")).toHaveTextContent("Saved");
    expect(control).toBeChecked();

    act(() => { vi.advanceTimersByTime(SETTING_SAVED_VISIBLE_MS); });
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("returns to the saved value and shows an error when the save fails", async () => {
    const save = deferred();
    render(<SettingSwitch id="timestamps" title="Message timestamps" checked={false} onChange={() => save.promise} />);
    const control = screen.getByRole("switch", { name: "Message timestamps" });

    fireEvent.click(control);
    await act(async () => save.reject(new Error("offline")));

    expect(control).not.toBeChecked();
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't save. Try again.");
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });
});

describe("SettingSelect and SettingRadioGroup", () => {
  it("saves a select choice on change with one select style", async () => {
    const onChange = vi.fn(async () => undefined);
    render(<SettingSelect id="budget" title="Budget" value="a" options={[{ value: "a", label: "A" }, { value: "b", label: "B" }]} onChange={onChange} />);
    const select = screen.getByRole("combobox", { name: "Budget" });
    expect(select).toHaveClass("setting-select");

    fireEvent.change(select, { target: { value: "b" } });
    expect(select).toHaveValue("b");
    expect(onChange).toHaveBeenCalledWith("b");
    expect(await screen.findByText("Saved")).toHaveAttribute("role", "status");
  });

  it("moves and saves a radio choice with arrow keys and one tab stop", () => {
    const onChange = vi.fn(async () => undefined);
    render(<SettingRadioGroup id="scale" title="Interface scale" value="default" options={[
      { value: "compact", label: "Compact" },
      { value: "default", label: "Default" },
      { value: "large", label: "Large" },
    ]} onChange={onChange} />);
    const group = within(screen.getByRole("radiogroup", { name: "Interface scale" }));
    const current = group.getByRole("radio", { name: "Default" });
    expect(group.getAllByRole("radio").filter((radio) => radio.tabIndex === 0)).toEqual([current]);

    fireEvent.keyDown(current, { key: "ArrowRight" });
    const next = group.getByRole("radio", { name: "Large" });
    expect(next).toHaveFocus();
    expect(next).toHaveAttribute("aria-checked", "true");
    expect(onChange).toHaveBeenLastCalledWith("large");
  });
});

describe("inactive controls", () => {
  it("keeps an inactive switch focusable, marks it aria-disabled and ignores activation", () => {
    const onChange = vi.fn();
    const { rerender } = render(<SettingSwitch id="background" title="Only in the background" checked={false} inactive onChange={onChange} />);
    const control = screen.getByRole("switch", { name: "Only in the background" });
    expect(control).toHaveAttribute("aria-disabled", "true");
    expect(control).not.toBeDisabled();
    control.focus();
    expect(control).toHaveFocus();

    fireEvent.click(control);
    expect(onChange).not.toHaveBeenCalled();
    expect(control).not.toBeChecked();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();

    rerender(<SettingSwitch id="background" title="Only in the background" checked={false} onChange={onChange} />);
    expect(control).not.toHaveAttribute("aria-disabled");
    expect(control).toHaveFocus();
    fireEvent.click(control);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("keeps an inactive select focusable, marks it aria-disabled and snaps back to the stored value", () => {
    const onChange = vi.fn();
    const options = [{ value: "25", label: "25 %" }, { value: "15", label: "15 %" }] as const;
    const { rerender } = render(<SettingSelect id="threshold" title="Warn when below" value="25" options={options} inactive onChange={onChange} />);
    const control = screen.getByRole("combobox", { name: "Warn when below" });
    expect(control).toHaveAttribute("aria-disabled", "true");
    expect(control).not.toBeDisabled();
    control.focus();
    expect(control).toHaveFocus();

    fireEvent.change(control, { target: { value: "15" } });
    expect(onChange).not.toHaveBeenCalled();
    expect(control).toHaveValue("25");
    expect(screen.getByRole("status")).toBeEmptyDOMElement();

    rerender(<SettingSelect id="threshold" title="Warn when below" value="25" options={options} onChange={onChange} />);
    expect(control).not.toHaveAttribute("aria-disabled");
    fireEvent.change(control, { target: { value: "15" } });
    expect(onChange).toHaveBeenCalledWith("15");
    expect(control).toHaveValue("15");
  });
});

describe("SettingTextField", () => {
  it("saves once on blur without dropping keystrokes or snapping back while the save is pending", async () => {
    const save = deferred();
    const onSave = vi.fn(() => save.promise);
    const view = render(<SettingTextField id="repository" title="Repository URL" value="" onSave={onSave} />);
    const input = screen.getByRole("textbox", { name: "Repository URL" });

    for (const value of ["h", "ht", "https://github.com/a/b"]) {
      fireEvent.change(input, { target: { value } });
    }
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(onSave).toHaveBeenCalledExactlyOnceWith("https://github.com/a/b");

    view.rerender(<SettingTextField id="repository" title="Repository URL" value="" onSave={onSave} />);
    expect(input).toHaveValue("https://github.com/a/b");
    fireEvent.change(input, { target: { value: "https://github.com/a/bc" } });
    await act(async () => save.resolve());
    expect(input).toHaveValue("https://github.com/a/bc");

    view.rerender(<SettingTextField id="repository" title="Repository URL" value="https://github.com/a/b" onSave={onSave} />);
    expect(input).toHaveValue("https://github.com/a/bc");
  });

  it("saves on Enter and keeps the text with an error when the save fails", async () => {
    const save = deferred();
    render(<SettingTextField id="name" title="Name" value="Old" onSave={() => save.promise} />);
    const input = screen.getByRole("textbox", { name: "Name" });

    fireEvent.change(input, { target: { value: "New" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await act(async () => save.reject(new Error("offline")));

    expect(input).toHaveValue("New");
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't save. Try again.");
  });

  it("validates on blur only and lets Escape revert the draft and clear the error", () => {
    const onSave = vi.fn(async () => undefined);
    render(<SettingTextField id="url" title="URL" value="https://github.com/a/b" validate={(value) => value.startsWith("https://") ? null : "Use an HTTPS URL."} onSave={onSave} />);
    const input = screen.getByRole("textbox", { name: "URL" });

    fireEvent.change(input, { target: { value: "ftp://x" } });
    expect(screen.queryByText("Use an HTTPS URL.")).not.toBeInTheDocument();
    fireEvent.blur(input);
    const message = screen.getByText("Use an HTTPS URL.");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAttribute("aria-describedby", message.id);
    expect(message).not.toHaveAttribute("role");
    expect(onSave).not.toHaveBeenCalled();

    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    act(() => { input.dispatchEvent(escape); });
    expect(escape.defaultPrevented).toBe(true);
    expect(input).toHaveValue("https://github.com/a/b");
    expect(screen.queryByText("Use an HTTPS URL.")).not.toBeInTheDocument();
    expect(input).not.toHaveAttribute("aria-invalid");
  });

  it("keeps a newer saved value when an older save fails afterwards", async () => {
    const older = deferred();
    const newer = deferred();
    const onSave = vi.fn().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const view = render(<SettingTextField id="name" title="Name" value="Old" onSave={onSave} />);
    const input = screen.getByRole("textbox", { name: "Name" });

    fireEvent.change(input, { target: { value: "First" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.change(input, { target: { value: "Second" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await act(async () => newer.resolve());
    view.rerender(<SettingTextField id="name" title="Name" value="Second" onSave={onSave} />);
    await act(async () => older.reject(new Error("offline")));

    expect(input).toHaveValue("Second");
    fireEvent.blur(input);
    expect(onSave).toHaveBeenCalledTimes(2);
  });

  it("ignores Enter and Escape while an input method is composing", () => {
    const onSave = vi.fn(async () => undefined);
    render(<SettingTextField id="name" title="Name" value="Old" onSave={onSave} />);
    const input = screen.getByRole("textbox", { name: "Name" });
    fireEvent.change(input, { target: { value: "かな" } });

    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Escape", isComposing: true });

    expect(onSave).not.toHaveBeenCalled();
    expect(input).toHaveValue("かな");
  });

  it("treats a draft equal to the saved value as clean so Escape is left to Settings", () => {
    render(<SettingTextField id="url" title="URL" value="saved" onSave={vi.fn()} />);
    const input = screen.getByRole("textbox", { name: "URL" });
    fireEvent.change(input, { target: { value: "saved " } });
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    act(() => { input.dispatchEvent(escape); });
    expect(escape.defaultPrevented).toBe(false);
  });
});

describe("useSettingAction", () => {
  function Probe({ operation }: { operation: () => Promise<void> }): React.JSX.Element {
    const action = useSettingAction();
    return (
      <button type="button" aria-busy={action.busy} onClick={() => { void action.run(operation, { exclusive: true, success: "Done.", failure: "It failed." }); }}>
        {action.notice?.text ?? "Run"}
      </button>
    );
  }

  it("ignores an exclusive run while one is pending and reports custom messages", async () => {
    const first = deferred();
    const operation = vi.fn(() => first.promise);
    render(<Probe operation={operation} />);
    const button = screen.getByRole("button");

    fireEvent.click(button);
    fireEvent.click(button);
    expect(operation).toHaveBeenCalledOnce();
    expect(button).toHaveAttribute("aria-busy", "true");
    await act(async () => first.resolve());
    expect(button).toHaveTextContent("Done.");
    expect(button).toHaveAttribute("aria-busy", "false");
  });
});
