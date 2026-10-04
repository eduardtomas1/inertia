import { useId, useLayoutEffect, useRef, useState } from "react";
import { ArrowRight } from "lucide-react";
import type { AppShortcutAction } from "@shared/keybindings";

import type { SettingsSection } from "../../lib/settingsTarget";
import {
  GuideDemo,
  GuideDialog,
  GuideTopicTabs,
  order,
  useGuideModal,
  useGuideTopic,
} from "./GuideParts";
import { searchHelp, type HelpSearchHit, type HelpSearchResult } from "./helpSearch";
import { HelpJumpButtons, HelpSearchResults, helpResultId } from "./HelpSearchResults";
import { HELP_TOPICS, type HelpCommand, type HelpJump } from "./helpTopics";
import "./WelcomeGuide.css";
import "./HelpGuide.css";

const TOPIC_PREFIX = "help-topic";

function resultStatus({ hits, total }: HelpSearchResult): string {
  if (total === 0) return "No matches";
  if (total === 1) return "1 result";
  return hits.length < total ? `${hits.length} of ${total} results` : `${total} results`;
}

export function HelpGuide({
  shortcutLabel,
  onClose,
  onCommand,
  onOpenSettings,
}: {
  shortcutLabel: (action: AppShortcutAction) => string;
  onClose: () => void;
  onCommand: (command: HelpCommand) => void;
  onOpenSettings: (section: SettingsSection) => void;
}): React.JSX.Element {
  const titleId = useId();
  const resultsId = useId();
  const primary = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const restoreFocus = useGuideModal();
  const { topic, leaving, choose } = useGuideTopic(HELP_TOPICS[0]!.id);
  const [query, setQuery] = useState("");
  const [reveal, setReveal] = useState<{ topic: string; entry: number } | null>(null);
  const result = searchHelp(query, shortcutLabel);
  const searching = result.words.length > 0;
  const index = HELP_TOPICS.findIndex((item) => item.id === topic);
  const current = HELP_TOPICS[index]!;
  const next = searching ? undefined : HELP_TOPICS[index + 1];
  const stageIds = current.demo === undefined ? [] : leaving === null ? [topic] : [leaving, topic];
  const stages = stageIds.flatMap((id) => {
    const demo = HELP_TOPICS.find((item) => item.id === id)?.demo;
    return demo ? [{ key: id, demo, leaving: id !== topic }] : [];
  });
  const demoShortcuts = [
    { keys: shortcutLabel("search"), label: "Search" },
    { keys: shortcutLabel("new-chat"), label: "New chat" },
    { keys: shortcutLabel("toggle-sidebar"), label: "Sidebar" },
    { keys: shortcutLabel("toggle-terminal"), label: "Terminal" },
  ];
  useLayoutEffect(() => {
    search.current?.focus({ preventScroll: true });
  }, []);
  useLayoutEffect(() => {
    const panel = document.getElementById(`${TOPIC_PREFIX}-panel`);
    if (panel) panel.scrollTop = 0;
  }, [topic]);
  useLayoutEffect(() => {
    if (!reveal) return;
    document.getElementById(`${TOPIC_PREFIX}-${reveal.topic}`)?.focus();
    document.getElementById(`${TOPIC_PREFIX}-${reveal.topic}-entry-${reveal.entry}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [reveal]);

  const close = (): void => {
    restoreFocus();
    onClose();
  };
  const escape = (): void => {
    if (query.length === 0) {
      close();
      return;
    }
    setQuery("");
    search.current?.focus();
  };
  const jump = (target: HelpJump): void => {
    close();
    if ("command" in target) onCommand(target.command);
    else onOpenSettings(target.settings);
  };
  const open = ({ topic: owner, entry }: HelpSearchHit): void => {
    const target = owner.jumps.find(({ label }) => label === entry.jump);
    if (target) {
      jump(target);
      return;
    }
    setQuery("");
    choose(owner.id);
    setReveal({ topic: owner.id, entry: owner.entries.indexOf(entry) });
  };
  const previous = (): void => {
    choose(HELP_TOPICS[index - 1]!.id);
    if (index === 1) primary.current?.focus();
  };

  return (
    <GuideDialog className="welcome-guide help-guide" labelledBy={titleId} onClose={escape}>
      <header className="welcome-guide-header">
        <h2 id={titleId} className="welcome-guide-title">Help</h2>
        <button type="button" className="welcome-guide-skip" onClick={close}>
          Close
        </button>
      </header>
      <div className="welcome-guide-body">
        <div className="welcome-guide-step" data-step="help">
          <input
            ref={search}
            type="search"
            className="help-guide-search"
            placeholder="Search help"
            aria-label="Search help"
            aria-controls={searching ? resultsId : undefined}
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "ArrowDown" || result.hits.length === 0) return;
              event.preventDefault();
              document.getElementById(helpResultId(resultsId, 0))?.focus();
            }}
          />
          <p className="visually-hidden" role="status">{searching ? resultStatus(result) : ""}</p>
          {searching ? (
            <HelpSearchResults
              id={resultsId}
              result={result}
              shortcutLabel={shortcutLabel}
              onOpen={open}
              onJump={jump}
              onExit={() => search.current?.focus()}
            />
          ) : (
            <GuideTopicTabs
              idPrefix={TOPIC_PREFIX}
              topics={HELP_TOPICS}
              topic={topic}
              onChoose={choose}
              panelFocusable
            >
              {stages.length > 0 && <GuideDemo stages={stages} shortcuts={demoShortcuts} />}
              <div className="welcome-guide-topic-copy">
                <h3>{current.title}</h3>
                <p>{current.summary}</p>
              </div>
              <ul key={topic} className="help-guide-entries">
                {current.entries.map((entry, entryIndex) => (
                  <li
                    key={entry.name}
                    id={`${TOPIC_PREFIX}-${topic}-entry-${entryIndex}`}
                    style={order(entryIndex)}
                  >
                    <strong>{entry.name}</strong>
                    {entry.shortcut && <kbd>{shortcutLabel(entry.shortcut)}</kbd>}
                    <p>{entry.detail}</p>
                  </li>
                ))}
              </ul>
              <HelpJumpButtons jumps={current.jumps} onJump={jump} />
            </GuideTopicTabs>
          )}
        </div>
      </div>
      <footer className="welcome-guide-footer">
        {!searching && (
          <span className="welcome-guide-count">
            Topic {index + 1} of {HELP_TOPICS.length}
          </span>
        )}
        <span className="welcome-guide-actions">
          {!searching && index > 0 && (
            <button type="button" className="welcome-guide-back" onClick={previous}>
              Previous
            </button>
          )}
          <button
            ref={primary}
            type="button"
            className="welcome-guide-primary"
            onClick={next ? () => choose(next.id) : close}
          >
            {next ? `Next: ${next.title}` : "Done"}
            {next && <ArrowRight size={15} aria-hidden="true" />}
          </button>
        </span>
      </footer>
    </GuideDialog>
  );
}
