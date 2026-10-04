import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";

import type { SettingsRowMetadata, SettingsSectionRows } from "../settingsRows";
import { searchSettings, type SettingsMatchRange } from "./settingsMatcher";
import "./SettingsSearch.css";

const RESULTS_ID = "settings-search-results";

function optionId(row: SettingsRowMetadata): string {
  return `settings-search-${row.id}`;
}

function MarkedTitle({ title, ranges }: { title: string; ranges: readonly SettingsMatchRange[] }): React.JSX.Element {
  const parts: React.ReactNode[] = [];
  let offset = 0;
  for (const [start, end] of ranges) {
    parts.push(title.slice(offset, start), <mark key={start}>{title.slice(start, end)}</mark>);
    offset = end;
  }
  return <>{parts}{title.slice(offset)}</>;
}

export function SettingsSearch({
  query,
  sections,
  onQueryChange,
  onChoose,
}: {
  query: string;
  sections: readonly SettingsSectionRows[];
  onQueryChange: (query: string) => void;
  onChoose: (row: SettingsRowMetadata) => void;
}): React.JSX.Element {
  const [activeId, setActiveId] = useState<string | null>(null);
  const groups = useMemo(() => searchSettings(query, sections), [query, sections]);
  const rows = useMemo(() => groups.flatMap(({ results }) => results.map(({ row }) => row)), [groups]);
  const searching = query.trim() !== "";
  const listed = searching && rows.length > 0;
  const activeIndex = Math.max(0, rows.findIndex(({ id }) => id === activeId));
  const active = searching ? rows[activeIndex] : undefined;
  useEffect(() => {
    if (active) document.getElementById(optionId(active))?.scrollIntoView?.({ block: "nearest" });
  }, [active]);
  const changeQuery = (next: string): void => {
    setActiveId(null);
    onQueryChange(next);
  };
  const choose = (row: SettingsRowMetadata | undefined): void => {
    if (!row) return;
    setActiveId(null);
    onChoose(row);
  };
  const move = (step: number): void => {
    if (rows.length === 0) return;
    setActiveId(rows[(activeIndex + step + rows.length) % rows.length]!.id);
  };
  return (
    <>
      <div className="settings-search">
        <input
          className="setting-input settings-search-input"
          value={query}
          placeholder="Search settings"
          aria-label="Search settings"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={listed}
          aria-controls={listed ? RESULTS_ID : undefined}
          aria-activedescendant={active ? optionId(active) : undefined}
          autoComplete="off"
          spellCheck={false}
          maxLength={80}
          onChange={(event) => changeQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Escape" && query) {
              event.preventDefault();
              changeQuery("");
            } else if (event.key === "ArrowDown" && searching) {
              event.preventDefault();
              move(1);
            } else if (event.key === "ArrowUp" && searching) {
              event.preventDefault();
              move(-1);
            } else if (event.key === "Enter" && searching) {
              event.preventDefault();
              choose(active);
            }
          }}
        />
      </div>
      {listed && (
        <div className="settings-search-results">
          <div id={RESULTS_ID} role="listbox" aria-label="Matching settings">
            {groups.map(({ sectionId, label, results }) => (
              <div className="settings-search-group" role="group" aria-label={label} key={sectionId}>
                <span>{label}</span>
                {results.map(({ row, ranges }) => {
                  const ambiguous = results.some((other) => other.row !== row && other.row.title === row.title);
                  return (
                    <button
                      type="button"
                      tabIndex={-1}
                      id={optionId(row)}
                      role="option"
                      aria-selected={row === active}
                      className={clsx(row === active && "is-active")}
                      key={row.id}
                      onPointerMove={() => setActiveId(row.id)}
                      onClick={() => choose(row)}
                    >
                      <span><MarkedTitle title={row.title} ranges={ranges} /></span>
                      {ambiguous && <small>{row.group}</small>}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
      <p className={rows.length > 0 || !searching ? "visually-hidden" : "settings-search-empty"} role="status" aria-live="polite">
        {!searching ? "" : rows.length === 0 ? "No settings match" : `${rows.length} ${rows.length === 1 ? "setting" : "settings"}`}
      </p>
    </>
  );
}
