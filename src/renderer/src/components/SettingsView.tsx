import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";

import type { SettingsSection, SettingsTarget } from "../lib/settingsTarget";
import { useLoadedSurface } from "../hooks/useLoadedSurface";
import { structurallyEqual } from "../utils/structuralEquality";
import { SettingsPage } from "./settings/SettingsLayout";
import { SettingsSearch } from "./settings/SettingsSearch";
import { SettingsSectionFallback } from "./settings/SettingsSectionFallback";
import { chosenProjectId, type SettingsSectionMemory } from "./settings/sectionMemory";
import type { SettingsSectionContext, SettingsViewProps } from "./settings/settingsTypes";
import {
  prefetchSettingsSection,
  settingsSectionDefinition,
  SETTINGS_SECTIONS,
  type SettingsSectionDefinition,
} from "./settingsSections";
import { isProjectSettingsRow, type SettingsRowMetadata } from "./settingsRows";
import "./SettingsView.css";

type FocusRequest = { anchor?: string };
type LocalTarget = { base: SettingsTarget | null; target: SettingsTarget };
type PropRecord = Record<string, unknown>;

const IDENTITY_PROPS = new Set(["target"]);
const FOCUSABLE = "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], summary, [tabindex]:not([tabindex=\"-1\"])";

function useStableSettingsProps(props: SettingsViewProps): SettingsViewProps {
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  });
  const proxies = useRef(new Map<string, (...args: unknown[]) => unknown>());
  const stable = useRef<PropRecord | null>(null);
  const previous = stable.current;
  const next: PropRecord = {};
  let changed = previous === null || Object.keys(previous).length !== Object.keys(props).length;
  for (const [key, value] of Object.entries(props)) {
    let kept: unknown = value;
    if (typeof value === "function") {
      let proxy = proxies.current.get(key);
      if (!proxy) {
        proxy = (...args: unknown[]) => ((latest.current as unknown as PropRecord)[key] as (...args: unknown[]) => unknown)(...args);
        proxies.current.set(key, proxy);
      }
      kept = proxy;
    } else if (previous && key in previous && !IDENTITY_PROPS.has(key) && structurallyEqual(previous[key], value)) {
      kept = previous[key];
    }
    next[key] = kept;
    if (!previous || previous[key] !== kept) changed = true;
  }
  if (changed) stable.current = next;
  return stable.current as unknown as SettingsViewProps;
}

function focusIfShown(element: HTMLElement): boolean {
  if (!element.checkVisibility()) return false;
  element.focus();
  return document.activeElement === element;
}

function focusRowControl(row: HTMLElement): boolean {
  return [...row.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => element.tabIndex >= 0).some(focusIfShown);
}

function focusSettingRow(row: HTMLElement, heading: HTMLElement | null): MutationObserver | null {
  for (let details = row.closest("details"); details; details = details.parentElement?.closest("details") ?? null) {
    details.open = true;
  }
  row.scrollIntoView?.({ block: "center" });
  if (focusRowControl(row)) return null;
  if (row.checkVisibility()) row.tabIndex = -1;
  if (!focusIfShown(row)) {
    heading?.focus();
    return null;
  }
  const observer = new MutationObserver(() => {
    if (document.activeElement !== row || focusRowControl(row)) observer.disconnect();
  });
  observer.observe(row, { childList: true, subtree: true });
  return observer;
}

function SettingsSectionHost({
  definition,
  context,
  onReady,
}: {
  definition: SettingsSectionDefinition;
  context: SettingsSectionContext;
  onReady: () => void;
}): React.JSX.Element {
  const Section = useLoadedSurface(definition.load, true);
  useEffect(() => {
    if (Section) onReady();
  });
  return Section
    ? <Section key={definition.instanceKey?.(context)} {...definition.select(context)} />
    : <SettingsSectionFallback />;
}

const SettingsShell = memo(function SettingsShell({
  target: externalTarget = null,
  initialSection = "appearance",
  onSectionChange,
  ...view
}: SettingsViewProps): React.JSX.Element {
  const [localTarget, setLocalTarget] = useState<LocalTarget | null>(null);
  const target = localTarget?.base === externalTarget ? localTarget.target : externalTarget;
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const [section, setSection] = useState<SettingsSection>(target?.section ?? initialSection);
  const [memory] = useState<SettingsSectionMemory>(() => new Map());
  const focusRequest = useRef<FocusRequest | null>(target?.anchor ? { anchor: target.anchor } : null);
  const previousTarget = useRef(target);
  const focusRootOnMount = useRef(!target?.anchor);
  const settlingRow = useRef<MutationObserver | null>(null);
  useEffect(() => {
    if (focusRootOnMount.current) rootRef.current?.focus();
    return () => settlingRow.current?.disconnect();
  }, []);
  const resolveFocus = useCallback(() => {
    const request = focusRequest.current;
    if (!request) return;
    focusRequest.current = null;
    settlingRow.current?.disconnect();
    settlingRow.current = null;
    const row = request.anchor
      ? [...rootRef.current?.querySelectorAll<HTMLElement>("[data-setting-id]") ?? []]
        .find((element) => element.dataset.settingId === request.anchor)
      : undefined;
    if (row) settlingRow.current = focusSettingRow(row, headingRef.current);
    else headingRef.current?.focus();
  }, []);
  useEffect(() => {
    if (!target || target === previousTarget.current) return;
    previousTarget.current = target;
    focusRequest.current = { anchor: target.anchor };
    if (target.section === section) resolveFocus();
    else setSection(target.section);
  }, [resolveFocus, section, target]);
  useEffect(() => {
    onSectionChange?.(section);
  }, [onSectionChange, section]);
  const navigationShown = query.trim() === "";
  useLayoutEffect(() => {
    if (!navigationShown) return;
    navRef.current?.querySelector<HTMLElement>("[aria-current='page']")?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [navigationShown, section]);
  const navigate = useCallback((next: SettingsSection) => {
    if (next === section) return;
    setSection(next);
    focusRequest.current = {};
  }, [section]);
  const regularProjects = useMemo(
    () => view.projects.filter(({ workspaceKind }) => workspaceKind !== "scratch"),
    [view.projects],
  );
  const hasProjects = regularProjects.length > 0;
  const searchSections = useMemo(
    () => hasProjects ? SETTINGS_SECTIONS : SETTINGS_SECTIONS.map((item) => ({ ...item, rows: item.rows.filter((row) => !isProjectSettingsRow(row)) })),
    [hasProjects],
  );
  const openRow = useCallback((row: SettingsRowMetadata) => {
    const projectId = isProjectSettingsRow(row)
      ? chosenProjectId(memory, target) ?? regularProjects[0]?.id
      : undefined;
    setQuery("");
    setLocalTarget({ base: externalTarget, target: { section: row.sectionId, anchor: row.id, ...(projectId ? { projectId } : {}) } });
  }, [externalTarget, memory, regularProjects, target]);
  const allConversations = useMemo(
    () => [...view.conversations, ...view.archived],
    [view.archived, view.conversations],
  );
  const definition = settingsSectionDefinition(section);
  const context: SettingsSectionContext = {
    ...view,
    target,
    regularProjects,
    allConversations,
    onNavigate: navigate,
    memory,
  };
  return (
    <main ref={rootRef} className="settings-view" aria-label="Settings" tabIndex={-1}>
      <aside className="settings-navigation">
        <SettingsSearch query={query} sections={searchSections} onQueryChange={setQuery} onChoose={openRow} />
        {navigationShown && <nav ref={navRef} aria-label="Settings sections" onWheel={(event) => {
          const nav = event.currentTarget;
          if (nav.scrollWidth <= nav.clientWidth || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
          nav.scrollLeft += event.deltaY;
        }}>
          {SETTINGS_SECTIONS.map((item) => {
            const Icon = item.icon;
            const prefetch = (): void => prefetchSettingsSection(item);
            return (
              <button
                type="button"
                className={clsx(section === item.id && "is-active")}
                aria-current={section === item.id ? "page" : undefined}
                onFocus={prefetch}
                onPointerDown={prefetch}
                onPointerEnter={prefetch}
                onClick={() => navigate(item.id)}
                key={item.id}
              >
                <Icon size={14} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>}
      </aside>
      <SettingsPage title={definition.label} headingRef={headingRef} className={definition.contentClassName}>
        <SettingsSectionHost key={definition.id} definition={definition} context={context} onReady={resolveFocus} />
      </SettingsPage>
    </main>
  );
});

export function SettingsView(props: SettingsViewProps): React.JSX.Element {
  return <SettingsShell {...useStableSettingsProps(props)} />;
}
