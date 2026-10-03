import { useId, useLayoutEffect, useRef } from "react";
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
import { HELP_TOPICS, type HelpCommand, type HelpJump } from "./helpTopics";
import "./WelcomeGuide.css";
import "./HelpGuide.css";

const TOPIC_PREFIX = "help-topic";

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
  const primary = useRef<HTMLButtonElement>(null);
  const restoreFocus = useGuideModal();
  const { topic, leaving, choose } = useGuideTopic(HELP_TOPICS[0]!.id);
  const index = HELP_TOPICS.findIndex((item) => item.id === topic);
  const current = HELP_TOPICS[index]!;
  const next = HELP_TOPICS[index + 1];
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
    document.getElementById(`${TOPIC_PREFIX}-${HELP_TOPICS[0]!.id}`)?.focus({ preventScroll: true });
  }, []);
  useLayoutEffect(() => {
    const panel = document.getElementById(`${TOPIC_PREFIX}-panel`);
    if (panel) panel.scrollTop = 0;
  }, [topic]);

  const close = (): void => {
    restoreFocus();
    onClose();
  };
  const jump = (target: HelpJump): void => {
    close();
    if ("command" in target) onCommand(target.command);
    else onOpenSettings(target.settings);
  };
  const previous = (): void => {
    choose(HELP_TOPICS[index - 1]!.id);
    if (index === 1) primary.current?.focus();
  };

  return (
    <GuideDialog className="welcome-guide help-guide" labelledBy={titleId} onClose={close}>
      <header className="welcome-guide-header">
        <h2 id={titleId} className="welcome-guide-title">Help</h2>
        <button type="button" className="welcome-guide-skip" onClick={close}>
          Close
        </button>
      </header>
      <div className="welcome-guide-body">
        <div className="welcome-guide-step" data-step="help">
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
                <li key={entry.name} style={order(entryIndex)}>
                  <strong>{entry.name}</strong>
                  {entry.shortcut && <kbd>{shortcutLabel(entry.shortcut)}</kbd>}
                  <p>{entry.detail}</p>
                </li>
              ))}
            </ul>
            {current.jumps.length > 0 && (
              <div className="help-guide-jumps">
                {current.jumps.map((target) => (
                  <button key={target.label} type="button" onClick={() => jump(target)}>
                    {target.label}
                    <ArrowRight size={14} aria-hidden="true" />
                  </button>
                ))}
              </div>
            )}
          </GuideTopicTabs>
        </div>
      </div>
      <footer className="welcome-guide-footer">
        <span className="welcome-guide-count">
          Topic {index + 1} of {HELP_TOPICS.length}
        </span>
        <span className="welcome-guide-actions">
          {index > 0 && (
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
