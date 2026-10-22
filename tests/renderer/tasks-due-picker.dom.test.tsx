import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { TaskDuePicker } from "../../src/renderer/src/components/tasks/TaskDuePicker";
import { addDaysToDateKey, formatTodoDayLong, formatTodoTime, todoWeekStart } from "../../src/renderer/src/utils/todoDates";

const NOW = new Date(2026, 9, 21, 12);

function renderPicker(value: { dueDate?: string | null; dueTime?: string | null } = {}) {
  const onCommit = vi.fn();
  const onClose = vi.fn();
  const view = render(
    <TaskDuePicker dueDate={value.dueDate ?? null} dueTime={value.dueTime ?? null} now={NOW} onCommit={onCommit} onClose={onClose} />,
  );
  return { ...view, onCommit, onClose, user: userEvent.setup() };
}

const day = (key: string) => screen.getByRole("button", { name: formatTodoDayLong(key) });
const grid = () => screen.getByRole("grid");
const timeInput = () => screen.getByRole("textbox", { name: "Time" });
const done = () => screen.getByRole("button", { name: "Done" });

describe("TaskDuePicker", () => {
  it("opens as a labelled modal dialog focused on today when no day is set", () => {
    renderPicker();
    const dialog = screen.getByRole("dialog", { name: "Due" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(day("2026-10-21")).toHaveFocus();
    expect(day("2026-10-21")).toHaveAttribute("aria-current", "date");
    expect(day("2026-10-21")).toHaveAttribute("tabindex", "0");
    expect(grid()).toHaveAccessibleName("October 2026");
    expect(screen.getAllByRole("gridcell")).toHaveLength(42);
    expect(screen.getAllByRole("gridcell").filter((cell) => cell.getAttribute("aria-selected") === "true")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "No date" })).toBeNull();
    expect(timeInput()).toBeDisabled();
    expect(timeInput()).toHaveAttribute("placeholder", "Add time");
  });

  it("opens on the selected day and its month", () => {
    renderPicker({ dueDate: "2026-11-05", dueTime: "15:00" });
    expect(day("2026-11-05")).toHaveFocus();
    expect(day("2026-11-05").closest("[role=gridcell]")).toHaveAttribute("aria-selected", "true");
    expect(day("2026-11-05")).toHaveClass("is-selected");
    expect(grid()).toHaveAccessibleName("November 2026");
    expect(timeInput()).toHaveValue(formatTodoTime("15:00"));
  });

  it("shows the resolved day beside each preset", () => {
    renderPicker();
    expect(screen.getByRole("button", { name: "Today, Wed 21 Oct" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tomorrow, Thu 22 Oct" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next week, Mon 26 Oct" })).toBeInTheDocument();
  });

  it("moves the focused day with the arrow keys across month edges", () => {
    renderPicker({ dueDate: "2026-10-31" });
    fireEvent.keyDown(day("2026-10-31"), { key: "ArrowRight" });
    expect(day("2026-11-01")).toHaveFocus();
    expect(grid()).toHaveAccessibleName("November 2026");
    expect(day("2026-11-01")).toHaveAttribute("tabindex", "0");
    expect(grid().querySelectorAll('[tabindex="0"]')).toHaveLength(1);

    fireEvent.keyDown(day("2026-11-01"), { key: "ArrowLeft" });
    expect(day("2026-10-31")).toHaveFocus();
    expect(grid()).toHaveAccessibleName("October 2026");

    fireEvent.keyDown(day("2026-10-31"), { key: "ArrowDown" });
    expect(day("2026-11-07")).toHaveFocus();
    fireEvent.keyDown(day("2026-11-07"), { key: "ArrowUp" });
    fireEvent.keyDown(day("2026-10-31"), { key: "ArrowUp" });
    expect(day("2026-10-24")).toHaveFocus();
    expect(day("2026-10-31").closest("[role=gridcell]")).toHaveAttribute("aria-selected", "true");
  });

  it("changes the month with Page Up and Page Down and clamps short months", () => {
    renderPicker({ dueDate: "2027-01-31" });
    fireEvent.keyDown(day("2027-01-31"), { key: "PageDown" });
    expect(grid()).toHaveAccessibleName("February 2027");
    expect(screen.getByText("February 2027")).toBeInTheDocument();
    expect(day("2027-02-28")).toHaveFocus();
    fireEvent.keyDown(day("2027-02-28"), { key: "PageUp" });
    fireEvent.keyDown(day("2027-01-28"), { key: "PageUp" });
    expect(grid()).toHaveAccessibleName("December 2026");
    expect(day("2026-12-28")).toHaveFocus();
  });

  it("jumps to the edges of the week with Home and End", () => {
    renderPicker();
    const offset = (NOW.getDay() - todoWeekStart() + 7) % 7;
    fireEvent.keyDown(day("2026-10-21"), { key: "Home" });
    const first = addDaysToDateKey("2026-10-21", -offset);
    expect(day(first)).toHaveFocus();
    fireEvent.keyDown(day(first), { key: "End" });
    expect(day(addDaysToDateKey(first, 6))).toHaveFocus();
  });

  it("follows the month buttons without moving focus off them", async () => {
    const { user } = renderPicker();
    await user.click(screen.getByRole("button", { name: "Next month" }));
    expect(grid()).toHaveAccessibleName("November 2026");
    expect(screen.getByRole("button", { name: "Next month" })).toHaveFocus();
    expect(day("2026-11-21")).toHaveAttribute("tabindex", "0");
    await user.click(screen.getByRole("button", { name: "Previous month" }));
    await user.click(screen.getByRole("button", { name: "Previous month" }));
    expect(grid()).toHaveAccessibleName("September 2026");
  });

  it("commits a preset at once and keeps the current time", async () => {
    const { user, onCommit, onClose } = renderPicker({ dueDate: "2026-11-05", dueTime: "15:00" });
    await user.click(screen.getByRole("button", { name: "Tomorrow, Thu 22 Oct" }));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith({ dueDate: "2026-10-22", dueTime: "15:00" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("commits a preset with the typed time and refuses one that does not parse", async () => {
    const { user, onCommit } = renderPicker({ dueDate: "2026-11-05", dueTime: "09:30" });
    await user.clear(timeInput());
    await user.type(timeInput(), "25");
    await user.click(screen.getByRole("button", { name: "Tomorrow, Thu 22 Oct" }));
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Use a time like 15:00");

    fireEvent.change(timeInput(), { target: { value: "3pm" } });
    fireEvent.click(screen.getByRole("button", { name: "Next week, Mon 26 Oct" }));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith({ dueDate: "2026-10-26", dueTime: "15:00" });
  });

  it("clears both fields with No date", async () => {
    const { user, onCommit } = renderPicker({ dueDate: "2026-11-05", dueTime: "15:00" });
    await user.click(screen.getByRole("button", { name: "No date" }));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith({ dueDate: null, dueTime: null });
  });

  it("commits the focused day with Enter", () => {
    const { onCommit } = renderPicker();
    fireEvent.keyDown(day("2026-10-21"), { key: "ArrowRight" });
    fireEvent.keyDown(day("2026-10-22"), { key: "Enter" });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith({ dueDate: "2026-10-22", dueTime: null });
  });

  it("selects a clicked day without closing", async () => {
    const { user, onCommit, onClose } = renderPicker();
    await user.click(day("2026-11-01"));
    expect(onCommit).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(grid()).toHaveAccessibleName("November 2026");
    expect(day("2026-11-01").closest("[role=gridcell]")).toHaveAttribute("aria-selected", "true");
    expect(day("2026-11-01")).toHaveFocus();
    expect(timeInput()).toBeEnabled();
    expect(timeInput()).toHaveAttribute("placeholder", "Add time");
  });

  it("blocks Done while the time does not parse", async () => {
    const { user, onCommit } = renderPicker();
    await user.click(day("2026-10-23"));
    await user.type(timeInput(), "abc");
    await user.keyboard("{Enter}");
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Use a time like 15:00");
    expect(timeInput()).toHaveAttribute("aria-invalid", "true");
    expect(done()).toBeDisabled();
    fireEvent.click(done());
    expect(onCommit).not.toHaveBeenCalled();

    fireEvent.keyDown(day("2026-10-23"), { key: "Enter" });
    expect(onCommit).not.toHaveBeenCalled();

    await user.clear(timeInput());
    await user.type(timeInput(), "7:60");
    await user.click(done());
    expect(onCommit).not.toHaveBeenCalled();
    expect(done()).toBeDisabled();

    await user.clear(timeInput());
    expect(done()).toBeEnabled();
    await user.type(timeInput(), "15{Enter}");
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith({ dueDate: "2026-10-23", dueTime: "15:00" });
  });

  it("sends one commit with the day and the time from Done", async () => {
    const { user, onCommit, onClose } = renderPicker();
    await user.click(day("2026-10-23"));
    await user.type(timeInput(), "3:30 pm");
    await user.tab();
    expect(timeInput()).toHaveValue(formatTodoTime("15:30"));
    await user.click(done());
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith({ dueDate: "2026-10-23", dueTime: "15:30" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("clears the time with its button", async () => {
    const { user, onCommit } = renderPicker({ dueDate: "2026-11-05", dueTime: "15:00" });
    await user.click(screen.getByRole("button", { name: "Clear time" }));
    expect(timeInput()).toHaveValue("");
    expect(timeInput()).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Clear time" })).toBeNull();
    await user.click(done());
    expect(onCommit).toHaveBeenCalledWith({ dueDate: "2026-11-05", dueTime: null });
  });

  it("closes without a commit when Done changes nothing", async () => {
    const { user, onCommit, onClose } = renderPicker({ dueDate: "2026-11-05", dueTime: "15:00" });
    await user.click(done());
    expect(onCommit).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes with Escape or the backdrop and commits nothing", async () => {
    const { user, onCommit, onClose } = renderPicker({ dueDate: "2026-11-05" });
    await user.click(day("2026-11-09"));
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(timeInput(), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.mouseDown(screen.getByRole("dialog").parentElement!);
    expect(onClose).toHaveBeenCalledTimes(3);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("keeps its keys and clicks away from the surface behind it", () => {
    const parentKeyDown = vi.fn();
    const parentClick = vi.fn();
    render(
      <div onKeyDown={parentKeyDown} onClick={parentClick}>
        <TaskDuePicker dueDate={null} dueTime={null} now={NOW} onCommit={vi.fn()} onClose={vi.fn()} />
      </div>,
    );
    fireEvent.keyDown(day("2026-10-21"), { key: "Escape" });
    fireEvent.keyDown(day("2026-10-21"), { key: "ArrowDown" });
    fireEvent.click(day("2026-10-28"));
    expect(parentKeyDown).not.toHaveBeenCalled();
    expect(parentClick).not.toHaveBeenCalled();
  });

  it("returns focus to the control that opened it", () => {
    render(<button type="button">Due</button>);
    const trigger = screen.getByRole("button", { name: "Due" });
    trigger.focus();
    const { unmount } = render(<TaskDuePicker dueDate={null} dueTime={null} now={NOW} onCommit={vi.fn()} onClose={vi.fn()} />);
    expect(day("2026-10-21")).toHaveFocus();
    unmount();
    expect(trigger).toHaveFocus();
  });

  it("styles reduced motion and forced colours", () => {
    const css = readFileSync("src/renderer/src/components/tasks/TaskDuePicker.css", "utf8");
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toMatch(/\.task-due-picker\s*\{\s*animation: none;/u);
    const forced = css.slice(css.indexOf("@media (forced-colors: active)"));
    expect(forced).toMatch(/\.task-due-day\.is-selected \{[^}]*background: Highlight;/u);
    expect(forced).toMatch(/\.task-due-day\.is-today \{[^}]*outline: 1px solid CanvasText;/u);
  });
});
