import { ChevronLeft, ChevronRight, Clock, X } from "lucide-react";
import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";

import { INTERFACE_LOCALE } from "../../lib/locale";
import { useNativePreviewSuspension } from "../../hooks/useNativePreviewSuspension";
import { navigateMenuItems } from "../../utils/menuKeyboard";
import { captureModalFocus, trapModalFocus } from "../../utils/modalFocus";
import {
  TODO_DUE_PRESETS,
  TODO_DUE_PRESET_LABELS,
  addDaysToDateKey,
  addMonthsToDateKey,
  formatTodoDay,
  formatTodoDayLong,
  formatTodoTime,
  localDateKey,
  parseLocalDateKey,
  parseTodoTime,
  todoDuePresetDate,
  todoWeekStart,
} from "../../utils/todoDates";
import { IconButton } from "../ui";
import "./TaskDuePicker.css";

export interface TaskDuePickerProps {
  dueDate: string | null;
  dueTime: string | null;
  now: Date;
  onCommit: (value: { dueDate: string | null; dueTime: string | null }) => void;
  onClose: () => void;
}

const GRID_DAYS = 42;

function weekdayNames(weekStart: number): { short: string; long: string }[] {
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(2026, 0, 4 + ((weekStart + index) % 7));
    return {
      short: date.toLocaleDateString(INTERFACE_LOCALE, { weekday: "short" }),
      long: date.toLocaleDateString(INTERFACE_LOCALE, { weekday: "long" }),
    };
  });
}

function monthGrid(focused: string, weekStart: number): string[] {
  const date = parseLocalDateKey(focused);
  const first = new Date(date.getFullYear(), date.getMonth(), 1);
  const offset = (first.getDay() - weekStart + 7) % 7;
  const start = localDateKey(new Date(first.getFullYear(), first.getMonth(), 1 - offset));
  return Array.from({ length: GRID_DAYS }, (_, index) => addDaysToDateKey(start, index));
}

function keyTarget(key: string, focused: string, weekStart: number): string | null {
  const weekday = (parseLocalDateKey(focused).getDay() - weekStart + 7) % 7;
  switch (key) {
    case "ArrowLeft": return addDaysToDateKey(focused, -1);
    case "ArrowRight": return addDaysToDateKey(focused, 1);
    case "ArrowUp": return addDaysToDateKey(focused, -7);
    case "ArrowDown": return addDaysToDateKey(focused, 7);
    case "PageUp": return addMonthsToDateKey(focused, -1);
    case "PageDown": return addMonthsToDateKey(focused, 1);
    case "Home": return addDaysToDateKey(focused, -weekday);
    case "End": return addDaysToDateKey(focused, 6 - weekday);
    default: return null;
  }
}

export function TaskDuePicker({ dueDate, dueTime, now, onCommit, onClose }: TaskDuePickerProps): React.JSX.Element {
  const id = useId();
  const todayKey = localDateKey(now);
  const weekStart = useMemo(() => todoWeekStart(), []);
  const weekdays = useMemo(() => weekdayNames(weekStart), [weekStart]);
  const [selected, setSelected] = useState<string | null>(dueDate);
  const [focused, setFocused] = useState<string>(dueDate ?? todayKey);
  const [timeText, setTimeText] = useState(dueDate && dueTime ? formatTodoTime(dueTime) : "");
  const [timeInvalid, setTimeInvalid] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef<HTMLInputElement>(null);
  const focusCell = useRef(false);
  useNativePreviewSuspension(true);

  const focusedDate = parseLocalDateKey(focused);
  const viewMonth = focusedDate.getMonth();
  const monthLabel = focusedDate.toLocaleDateString(INTERFACE_LOCALE, { month: "long", year: "numeric" });
  const days = monthGrid(focused, weekStart);

  useLayoutEffect(() => {
    const restoreFocus = captureModalFocus();
    gridRef.current?.querySelector<HTMLButtonElement>('[tabindex="0"]')?.focus({ preventScroll: true });
    return restoreFocus;
  }, []);

  useLayoutEffect(() => {
    if (!focusCell.current) return;
    focusCell.current = false;
    gridRef.current?.querySelector<HTMLButtonElement>(`[data-date="${focused}"]`)?.focus({ preventScroll: true });
  }, [focused]);

  const commit = (nextDate: string | null, nextTime: string | null): void => {
    onCommit({ dueDate: nextDate, dueTime: nextDate ? nextTime : null });
  };

  const settleTime = (): string | null | undefined => {
    const text = timeText.trim();
    if (!text) {
      setTimeInvalid(false);
      return null;
    }
    const parsed = parseTodoTime(text);
    if (!parsed) {
      setTimeInvalid(true);
      return undefined;
    }
    setTimeText(formatTodoTime(parsed));
    setTimeInvalid(false);
    return parsed;
  };

  const finish = (day: string | null): void => {
    if (!day) {
      onClose();
      return;
    }
    const nextTime = settleTime();
    if (nextTime === undefined) return;
    if (day === dueDate && nextTime === dueTime) onClose();
    else commit(day, nextTime);
  };

  const moveFocus = (next: string, focusDay: boolean): void => {
    focusCell.current = focusDay;
    setFocused(next);
  };

  const onGridKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      setSelected(focused);
      if (!timeInvalid) finish(focused);
      return;
    }
    const next = keyTarget(event.key, focused, weekStart);
    if (!next) return;
    event.preventDefault();
    event.stopPropagation();
    moveFocus(next, true);
  };

  return createPortal(
    <div
      className="dialog-backdrop task-due-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) onClose();
      }}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <section
        className="task-due-picker"
        role="dialog"
        aria-modal="true"
        aria-label="Due"
        onKeyDown={(event) => {
          trapModalFocus(event, event.currentTarget);
          if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }}
      >
        <div className="task-due-presets" role="group" aria-label="Quick dates" onKeyDown={(event) => navigateMenuItems(event)}>
          {TODO_DUE_PRESETS.map((preset) => {
            const day = todoDuePresetDate(preset, now);
            return (
              <button
                type="button"
                key={preset}
                className="task-due-preset"
                aria-label={`${TODO_DUE_PRESET_LABELS[preset]}, ${formatTodoDay(day)}`}
                onClick={() => {
                  const nextTime = settleTime();
                  if (nextTime !== undefined) commit(day, nextTime);
                }}
              >
                <span aria-hidden="true">{TODO_DUE_PRESET_LABELS[preset]}</span>
                <span className="task-due-preset-day" aria-hidden="true">{formatTodoDay(day)}</span>
              </button>
            );
          })}
          {dueDate && (
            <button type="button" className="task-due-preset" onClick={() => commit(null, null)}>
              <span>No date</span>
            </button>
          )}
        </div>
        <div className="task-due-separator" role="separator" />
        <div className="task-due-calendar">
          <div className="task-due-calendar-header">
            <span className="task-due-month" id={`${id}-month`} aria-live="polite">{monthLabel}</span>
            <IconButton label="Previous month" className="task-due-nav" onClick={() => moveFocus(addMonthsToDateKey(focused, -1), false)}>
              <ChevronLeft size={14} aria-hidden="true" />
            </IconButton>
            <IconButton label="Next month" className="task-due-nav" onClick={() => moveFocus(addMonthsToDateKey(focused, 1), false)}>
              <ChevronRight size={14} aria-hidden="true" />
            </IconButton>
          </div>
          <div ref={gridRef} className="task-due-grid" role="grid" aria-label={monthLabel} onKeyDown={onGridKeyDown}>
            <div className="task-due-row" role="row">
              {weekdays.map((weekday) => (
                <span key={weekday.long} className="task-due-weekday" role="columnheader" aria-label={weekday.long}>
                  {weekday.short}
                </span>
              ))}
            </div>
            {Array.from({ length: GRID_DAYS / 7 }, (_, week) => (
              <div className="task-due-row" role="row" key={week}>
                {days.slice(week * 7, week * 7 + 7).map((day) => {
                  const date = parseLocalDateKey(day);
                  const isSelected = day === selected;
                  return (
                    <div className="task-due-cell" role="gridcell" aria-selected={isSelected} key={day}>
                      <button
                        type="button"
                        data-date={day}
                        tabIndex={day === focused ? 0 : -1}
                        aria-label={formatTodoDayLong(day)}
                        aria-current={day === todayKey ? "date" : undefined}
                        className={clsx(
                          "task-due-day",
                          date.getMonth() !== viewMonth && "is-outside",
                          day < todayKey && "is-past",
                          day === todayKey && "is-today",
                          isSelected && "is-selected",
                        )}
                        onClick={() => {
                          setSelected(day);
                          moveFocus(day, true);
                        }}
                      >
                        {date.getDate()}
                      </button>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
        <div className={clsx("task-due-time", timeInvalid && "is-invalid")}>
          <Clock size={14} aria-hidden="true" />
          <input
            ref={timeRef}
            aria-label="Time"
            inputMode="numeric"
            autoComplete="off"
            spellCheck={false}
            placeholder={selected ? "Add time" : "Pick a day first"}
            disabled={!selected}
            value={selected ? timeText : ""}
            aria-invalid={timeInvalid || undefined}
            aria-describedby={timeInvalid ? `${id}-time-hint` : undefined}
            onChange={(event) => {
              setTimeText(event.target.value);
              setTimeInvalid(false);
            }}
            onBlur={() => { settleTime(); }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
              event.preventDefault();
              finish(selected);
            }}
          />
          {selected && timeText && (
            <IconButton
              label="Clear time"
              className="task-due-clear"
              onClick={() => {
                setTimeText("");
                setTimeInvalid(false);
                timeRef.current?.focus({ preventScroll: true });
              }}
            >
              <X size={14} aria-hidden="true" />
            </IconButton>
          )}
        </div>
        {timeInvalid && (
          <p className="task-due-hint" id={`${id}-time-hint`} role="alert">Use a time like 15:00</p>
        )}
        <footer className="task-due-footer">
          <button type="button" className="primary-button" disabled={timeInvalid} onClick={() => finish(selected)}>
            Done
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
