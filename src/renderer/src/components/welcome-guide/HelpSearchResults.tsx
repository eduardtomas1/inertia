import { useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ArrowRight } from "lucide-react";
import type { AppShortcutAction } from "@shared/keybindings";

import {
  groupHelpHits,
  highlightHelpText,
  type HelpSearchHit,
  type HelpSearchResult,
} from "./helpSearch";
import type { HelpJump } from "./helpTopics";

export function HelpJumpButtons({
  jumps,
  onJump,
}: {
  jumps: readonly HelpJump[];
  onJump: (target: HelpJump) => void;
}): React.JSX.Element | null {
  if (jumps.length === 0) return null;
  return (
    <div className="help-guide-jumps">
      {jumps.map((target) => (
        <button key={target.label} type="button" onClick={() => onJump(target)}>
          {target.label}
          <ArrowRight size={14} aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}

function Marked({ text, words }: { text: string; words: readonly string[] }): React.JSX.Element {
  return (
    <>
      {highlightHelpText(text, words).map((part, index) => (
        part.match ? <mark key={index}>{part.text}</mark> : part.text
      ))}
    </>
  );
}

export function helpResultId(resultsId: string, index: number): string {
  return `${resultsId}-${index}`;
}

export function HelpSearchResults({
  id,
  result,
  shortcutLabel,
  onOpen,
  onJump,
  onExit,
}: {
  id: string;
  result: HelpSearchResult;
  shortcutLabel: (action: AppShortcutAction) => string;
  onOpen: (hit: HelpSearchHit) => void;
  onJump: (target: HelpJump) => void;
  onExit: () => void;
}): React.JSX.Element {
  const query = result.words.join(" ");
  const [cursor, setCursor] = useState({ query, index: 0 });
  const active = cursor.query === query ? cursor.index : 0;
  const groups = groupHelpHits(result.hits);
  const starts: number[] = [];
  let count = 0;
  for (const group of groups) {
    starts.push(count);
    count += group.hits.length;
  }
  const move = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const index = Number((event.target as HTMLElement).dataset.result);
    if (!Number.isInteger(index)) return;
    event.preventDefault();
    if (event.key === "ArrowUp" && index === 0) {
      onExit();
      return;
    }
    const next = Math.min(count - 1, index + (event.key === "ArrowDown" ? 1 : -1));
    document.getElementById(helpResultId(id, next))?.focus();
  };
  return (
    <section id={id} className="help-guide-results" aria-label="Search results" onKeyDown={move}>
      {groups.length === 0 && <p className="help-guide-empty">No matches.</p>}
      {groups.map((group, groupIndex) => (
        <div
          key={group.topic.id}
          className="help-guide-group"
          role="group"
          aria-labelledby={`${id}-topic-${group.topic.id}`}
        >
          <h3 id={`${id}-topic-${group.topic.id}`}>
            <Marked text={group.topic.title} words={result.words} />
          </h3>
          <ul className="help-guide-hits">
            {group.hits.map((hit, hitIndex) => {
              const index = starts[groupIndex]! + hitIndex;
              const resultId = helpResultId(id, index);
              return (
                <li key={hit.entry.name}>
                  <button
                    type="button"
                    id={resultId}
                    className="help-guide-result"
                    data-result={index}
                    tabIndex={index === active ? 0 : -1}
                    aria-labelledby={`${resultId}-name`}
                    aria-describedby={`${resultId}-detail`}
                    onFocus={() => setCursor({ query, index })}
                    onClick={() => onOpen(hit)}
                  >
                    <strong id={`${resultId}-name`}>
                      <Marked text={hit.entry.name} words={result.words} />
                    </strong>
                    {hit.entry.shortcut && <kbd>{shortcutLabel(hit.entry.shortcut)}</kbd>}
                    <span id={`${resultId}-detail`} className="help-guide-result-detail">
                      <Marked text={hit.entry.detail} words={result.words} />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <HelpJumpButtons jumps={group.topic.jumps} onJump={onJump} />
        </div>
      ))}
    </section>
  );
}
