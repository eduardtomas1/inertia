import { useId, useMemo, useState } from "react";

import type { BackendDiscoveredModel } from "@shared/contracts";
import { normalizeModelSearchText } from "../../utils/modelSearch";

const MAX_VISIBLE_MODELS = 200;
export const MAX_ROUTE_MODELS = 128;

export function ModelDiscoveryPicker({
  models,
  existingIds,
  busy,
  maxSelectable = MAX_ROUTE_MODELS,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  models: readonly BackendDiscoveredModel[];
  existingIds: ReadonlySet<string>;
  busy: boolean;
  maxSelectable?: number;
  confirmLabel: (count: number) => string;
  onConfirm: (models: BackendDiscoveredModel[]) => void;
  onCancel?: () => void;
}): React.JSX.Element {
  const searchId = useId();
  const countId = useId();
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set());
  const normalizedQuery = normalizeModelSearchText(query.trim());
  const matches = useMemo(() => models.filter(({ id, displayName }) =>
    !normalizedQuery
    || normalizeModelSearchText(id).includes(normalizedQuery)
    || normalizeModelSearchText(displayName).includes(normalizedQuery)), [models, normalizedQuery]);
  const visible = matches.slice(0, MAX_VISIBLE_MODELS);
  const selected = models.filter(({ id }) => chosen.has(id) && !existingIds.has(id));
  const full = selected.length >= maxSelectable;
  const limitId = useId();
  const addable = models.filter(({ id }) => !existingIds.has(id)).length;
  const toggle = (id: string, checked: boolean): void => {
    setChosen((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };
  return (
    <div className="backend-discovery" role="group" aria-label="Discovered models">
      <label className="backend-discovery-search" htmlFor={searchId}>
        <span>Search discovered models</span>
        <input
          id={searchId}
          className="setting-input"
          type="search"
          value={query}
          spellCheck={false}
          autoComplete="off"
          aria-describedby={countId}
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.preventDefault();
          }}
        />
      </label>
      <p id={countId} className="backend-discovery-count" aria-live="polite">
        {matches.length === models.length
          ? `${models.length} ${models.length === 1 ? "model" : "models"} found`
          : `${matches.length} of ${models.length} models match`}
        {matches.length > MAX_VISIBLE_MODELS ? `. Showing the first ${MAX_VISIBLE_MODELS}; search to narrow the list.` : ""}
      </p>
      {addable > maxSelectable && (
        <p id={limitId} className="backend-discovery-count" role={full ? "status" : undefined}>
          {maxSelectable <= 0
            ? `This route already lists ${MAX_ROUTE_MODELS} models, the most a route can have.`
            : `A route can list at most ${MAX_ROUTE_MODELS} models. You can choose ${maxSelectable} more.`}
        </p>
      )}
      <ul className="backend-discovery-list">
        {visible.map((model) => {
          const added = existingIds.has(model.id);
          return (
            <li key={model.id}>
              <label>
                <input
                  type="checkbox"
                  checked={added || chosen.has(model.id)}
                  disabled={added || busy || (full && !chosen.has(model.id))}
                  aria-describedby={addable > maxSelectable ? limitId : undefined}
                  onChange={(event) => toggle(model.id, event.currentTarget.checked)}
                />
                <span>
                  <strong>{model.displayName}</strong>
                  {model.displayName !== model.id && <code>{model.id}</code>}
                </span>
                {added && <small>Added</small>}
              </label>
            </li>
          );
        })}
      </ul>
      <div className="backend-discovery-actions">
        {onCancel && (
          <button type="button" className="secondary-button" onClick={onCancel}>Cancel</button>
        )}
        <button
          type="button"
          className="primary-button"
          aria-disabled={busy || selected.length === 0 || undefined}
          onClick={() => {
            if (busy || selected.length === 0) return;
            onConfirm(selected);
          }}
        >
          {confirmLabel(selected.length)}
        </button>
      </div>
    </div>
  );
}
