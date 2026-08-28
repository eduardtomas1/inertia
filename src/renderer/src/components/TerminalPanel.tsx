import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Columns2, Plus, TerminalSquare, X } from "lucide-react";
import { usePersistedSize } from "../hooks/usePersistedSize";
import { PaneResizeHandle } from "./PaneResizeHandle";
import {
  command,
  claimTerminalPanelOwner,
  isCurrentTerminalPanelOwner,
  MAX_PERSISTED_TERMINAL_TABS,
  newTerminalTab,
  nextTerminalTabIndex,
  persistTerminalTabs,
  readPersistedTerminalTabs,
  replaceTerminalTabWithoutHiding,
  terminalStorageKey,
  type TerminalPanelProps,
  type TerminalReplacement,
  type TerminalTab,
  useTerminalTabsLifecycle,
} from "./TerminalPanelSupport";
import { TerminalSession } from "./TerminalPanelSession";
import { IconButton } from "./ui";
function ScopedTerminalPanel(props: TerminalPanelProps): React.JSX.Element {
  const subscribe = props.subscribe;
  const sendCommand = props.sendCommand;
  const resumeRequestConversationId = props.resumeRequestConversationId;
  const onResumeRequestHandled = props.onResumeRequestHandled;
  const actionRequestId = props.actionId;
  const onActionRequestHandled = props.onActionStarted;
  const actionScopeIdentity = `${props.projectId}:${props.conversationId ?? ""}`;
  const storageKey = terminalStorageKey(props.projectId, props.conversationId);
  const [panelOwner] = useState(() => claimTerminalPanelOwner(storageKey));
  const [initialTabs] = useState(() => readPersistedTerminalTabs(storageKey));
  const [tabs, setTabs] = useState<TerminalTab[]>(initialTabs);
  const [activeId, setActiveId] = useState(initialTabs[0].id);
  const [split, setSplit] = useState(false);
  const [persistedSplitPercent, setPersistedSplitPercent] = usePersistedSize("inertia:layout:terminal-split-percent:v1", 50, { min: 25, max: 75 });
  const [splitPercent, setSplitPercent] = useState(persistedSplitPercent);
  const [splitOrientation, setSplitOrientation] = useState<"horizontal" | "vertical">("vertical");
  const [resumedTerminals, setResumedTerminals] = useState<ReadonlyMap<string, {
    tabId: string;
    terminalId: string;
  }>>(() => new Map());
  const [closingTabIds, setClosingTabIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [actionRoutingError, setActionRoutingError] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const tabsRef = useTerminalTabsLifecycle(storageKey, tabs, sendCommand);
  const handledPanelResumeRequestRef = useRef<string | null>(null);
  const handledBlockedActionRef = useRef<string | null>(null);

  useEffect(() => setSplitPercent(persistedSplitPercent), [persistedSplitPercent]);

  useEffect(() => setResumedTerminals(new Map()), [
    props.conversationId,
    props.projectId,
  ]);

  useEffect(() => {
    if (props.status !== "online") setResumedTerminals(new Map());
  }, [props.status]);

  useEffect(() => subscribe((event) => {
    if (event.type !== "terminal.exit") return;
    setResumedTerminals((current) => {
      const next = new Map(current);
      for (const [conversationId, resumed] of next) {
        if (resumed.terminalId === event.terminalId) {
          next.delete(conversationId);
        }
      }
      return next.size === current.size ? current : next;
    });
  }), [subscribe]);

  const resumedTabIds = useMemo(() => new Set(
    [...resumedTerminals.values()].map(({ tabId }) => tabId),
  ), [resumedTerminals]);
  const actionTargetId = useMemo<string | null>(() => {
    if (!props.actionId) return activeId;
    if (!resumedTabIds.has(activeId)) return activeId;
    return tabs.find(({ id }) => !resumedTabIds.has(id))?.id ?? null;
  }, [activeId, props.actionId, resumedTabIds, tabs]);

  useEffect(() => {
    const actionId = actionRequestId;
    if (!actionId) {
      handledBlockedActionRef.current = null;
      return;
    }
    if (actionTargetId) {
      setActionRoutingError(null);
      if (actionTargetId !== activeId) setActiveId(actionTargetId);
      return;
    }
    if (tabs.length < MAX_PERSISTED_TERMINAL_TABS) {
      setTabs((current) => {
        if (current.length >= MAX_PERSISTED_TERMINAL_TABS) return current;
        const tab = newTerminalTab(nextTerminalTabIndex(current));
        window.queueMicrotask(() => setActiveId(tab.id));
        return [...current, tab];
      });
      return;
    }
    const identity = `${actionScopeIdentity}:${actionId}`;
    setActionRoutingError(
      "End a resumed provider terminal before starting this project action.",
    );
    if (handledBlockedActionRef.current !== identity) {
      handledBlockedActionRef.current = identity;
      onActionRequestHandled?.();
    }
  }, [
    actionTargetId,
    activeId,
    actionRequestId,
    actionScopeIdentity,
    onActionRequestHandled,
    tabs.length,
  ]);

  useEffect(() => {
    if (!props.visible || tabs.length > 0) return;
    const tab = newTerminalTab();
    setTabs([tab]);
    setActiveId(tab.id);
  }, [props.visible, tabs.length]);

  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSplitOrientation(width < 430 && height >= 280 ? "horizontal" : "vertical");
    });
    observer.observe(grid);
    return () => observer.disconnect();
  }, []);

  const addTerminal = (): void => {
    setTabs((current) => {
      if (current.length >= MAX_PERSISTED_TERMINAL_TABS) return current;
      const tab = newTerminalTab(nextTerminalTabIndex(current));
      window.queueMicrotask(() => setActiveId(tab.id));
      return [...current, tab];
    });
  };

  const replaceTerminalTab = (
    tabId: string,
    replacement: TerminalReplacement,
  ): boolean => {
    const next = replaceTerminalTabWithoutHiding(
      tabsRef.current,
      tabId,
      replacement.previousTerminalId,
      replacement.terminalId,
      replacement.preservePrevious,
    );
    if (!next) return false;
    tabsRef.current = next;
    setTabs(next);
    return true;
  };

  useEffect(() => {
    const requestedConversationId = resumeRequestConversationId;
    if (!requestedConversationId) {
      handledPanelResumeRequestRef.current = null;
      return;
    }
    if (handledPanelResumeRequestRef.current === requestedConversationId) return;
    const existing = resumedTerminals.get(requestedConversationId);
    if (existing && tabs.some(({ id }) => id === existing.tabId)) {
      handledPanelResumeRequestRef.current = requestedConversationId;
      setActiveId(existing.tabId);
      onResumeRequestHandled?.();
      return;
    }
    const activeTabAlreadyResumed = [...resumedTerminals.values()].some(
      ({ tabId }) => tabId === activeId,
    );
    if (!activeTabAlreadyResumed) return;
    const idleTab = tabs.find(({ id }) => ![...resumedTerminals.values()].some(
      ({ tabId }) => tabId === id,
    ));
    if (idleTab) {
      setActiveId(idleTab.id);
      return;
    }
    if (tabs.length >= MAX_PERSISTED_TERMINAL_TABS) return;

    // A resumed provider owns its terminal until that process exits. Preserve
    // it and give the explicit composer request a fresh terminal to start in.
    setTabs((current) => {
      if (current.length >= MAX_PERSISTED_TERMINAL_TABS) return current;
      const tab = newTerminalTab(nextTerminalTabIndex(current));
      window.queueMicrotask(() => setActiveId(tab.id));
      return [...current, tab];
    });
  }, [
    activeId,
    onResumeRequestHandled,
    resumeRequestConversationId,
    resumedTerminals,
    tabs,
  ]);

  const closeTerminal = (id: string): void => {
    if (closingTabIds.has(id)) return;
    const closing = tabsRef.current.find((tab) => tab.id === id);
    if (!closing) return;
    const finish = (): void => {
      const current = tabsRef.current;
      const next = current.filter((tab) => tab.id !== id);
      if (next.length === current.length) return;
      setClosingTabIds((closingIds) => {
        const updated = new Set(closingIds);
        updated.delete(id);
        return updated;
      });
      tabsRef.current = next;
      persistTerminalTabs(storageKey, next);
      setTabs(next);
      setActiveId((selected) => selected === id
        ? (next.at(-1)?.id ?? "")
        : selected);
      if (next.length === 0) {
        setSplit(false);
        props.onClose();
      } else if (next.length < 2) {
        setSplit(false);
      }
    };
    if (!closing.terminalId) {
      finish();
      return;
    }
    setClosingTabIds((closingIds) => new Set(closingIds).add(id));
    void sendCommand(command({
      type: "terminal.close",
      payload: { terminalId: closing.terminalId },
    })).then(finish, () => {
      setClosingTabIds((closingIds) => {
        const updated = new Set(closingIds);
        updated.delete(id);
        return updated;
      });
    });
  };

  const updateRestorableTerminal = (
    tabId: string,
    terminalId: string | null,
  ): boolean => {
    if (!isCurrentTerminalPanelOwner(storageKey, panelOwner)) return false;
    let found = false;
    let changed = false;
    const next = tabsRef.current.map((candidate) => {
      if (candidate.id !== tabId) {
        return candidate;
      }
      found = true;
      if (candidate.terminalId === terminalId) return candidate;
      changed = true;
      return { ...candidate, terminalId };
    });
    if (!found) return false;
    if (!changed) return true;
    // A terminal.create response may arrive after this scoped panel unmounts.
    // Persist the exact returned capability synchronously so a later visit can
    // reattach it instead of cancelling a possibly fork-tainted macOS shell.
    tabsRef.current = next;
    persistTerminalTabs(storageKey, next);
    setTabs(next);
    return true;
  };

  const splitTerminal = () => {
    if (tabs.length < 2) addTerminal();
    setSplit((current) => !current);
  };

  const secondaryId = tabs.find((tab) => tab.id !== activeId)?.id ?? null;
  const sessionIds = useMemo(() => new Map(tabs.map((tab) => [tab.id, `terminal-session-${tab.id}`])), [tabs]);
  const gridStyle = { "--terminal-split-percent": `${splitPercent}%` } as CSSProperties;

  return (
    <aside className="terminal-tabs-panel" aria-label="Terminal panel" hidden={!props.visible}>
      <header className="terminal-tabbar">
        <div className="terminal-tablist" role="tablist" aria-label="Terminals">
          {tabs.map((tab) => <div className={tab.id === activeId ? "terminal-tab is-active" : "terminal-tab"} key={tab.id}><button type="button" id={`terminal-tab-${tab.id}`} role="tab" aria-selected={tab.id === activeId} aria-controls={sessionIds.get(tab.id)} onClick={() => setActiveId(tab.id)}><TerminalSquare size={13} /><span>{tab.label}</span></button><button type="button" aria-label={`Close ${tab.label}`} disabled={closingTabIds.has(tab.id)} onClick={() => closeTerminal(tab.id)}><X size={11} /></button></div>)}
        </div>
        <div className="terminal-tab-actions"><IconButton label={tabs.length >= MAX_PERSISTED_TERMINAL_TABS ? "Maximum of 4 terminals open" : "New terminal"} disabled={tabs.length >= MAX_PERSISTED_TERMINAL_TABS} onClick={() => addTerminal()}><Plus size={14} /></IconButton><IconButton label="Split terminals" aria-pressed={split} onClick={splitTerminal}><Columns2 size={14} /></IconButton></div>
      </header>
      {actionRoutingError && (
        <div className="terminal-resume-status is-unavailable" role="alert">
          {actionRoutingError}
        </div>
      )}
      <div
        ref={gridRef}
        className={split ? `terminal-session-grid is-split is-${splitOrientation}` : "terminal-session-grid"}
        style={gridStyle}
      >
        {tabs.map((tab) => {
          const visible = tab.id === activeId || (split && tab.id === secondaryId);
          const placement = tab.id === activeId ? "is-primary" : tab.id === secondaryId ? "is-secondary" : "";
          const siblingResumedConversationIds = new Set(
            [...resumedTerminals]
              .filter(([, resumed]) => resumed.tabId !== tab.id)
              .map(([conversationId]) => conversationId),
          );
          return <div id={sessionIds.get(tab.id)} role="tabpanel" aria-labelledby={`terminal-tab-${tab.id}`} className={`terminal-session-slot ${placement}`} hidden={!visible} key={tab.id}><TerminalSession {...props} initialTerminalId={tab.terminalId} visible={Boolean(props.visible && visible)} actionId={tab.id === actionTargetId ? props.actionId : null} onActionStarted={tab.id === actionTargetId ? props.onActionStarted : undefined} resumeRequestConversationId={tab.id === activeId ? props.resumeRequestConversationId : null} onResumeRequestHandled={tab.id === activeId ? props.onResumeRequestHandled : undefined} siblingResumedConversationIds={siblingResumedConversationIds} onRestorableTerminalChange={(terminalId) => updateRestorableTerminal(tab.id, terminalId)} onTerminalReplaced={(replacement) => replaceTerminalTab(tab.id, replacement)} onProviderResumeStarted={(terminalId, resumedConversationId) => setResumedTerminals((current) => new Map(current).set(resumedConversationId, { tabId: tab.id, terminalId }))} onClose={() => closeTerminal(tab.id)} /></div>;
        })}
        {split && secondaryId && (
          <PaneResizeHandle
            label="Resize split terminals"
            controls={`${sessionIds.get(activeId)} ${sessionIds.get(secondaryId)}`}
            containerRef={gridRef}
            orientation={splitOrientation}
            unit="percent"
            value={splitPercent}
            min={25}
            max={75}
            defaultValue={50}
            onChange={setSplitPercent}
            onCommit={setPersistedSplitPercent}
            valueText={(value) => `${value}% for the active terminal`}
            className="terminal-split-handle"
          />
        )}
      </div>
    </aside>
  );
}

export function TerminalPanel(props: TerminalPanelProps): React.JSX.Element {
  const scope = `${props.projectId}:${props.conversationId ?? "project"}`;
  return <ScopedTerminalPanel key={scope} {...props} />;
}
