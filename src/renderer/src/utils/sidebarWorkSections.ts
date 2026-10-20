import type { SidebarWorkSection, SidebarWorkSectionId } from "./sidebarModel";
import { isInitiativeWorkSectionId } from "./sidebarInitiatives";

/**
 * Persisted Work section disclosure state, stored as comma-separated tokens
 * under the existing Work sections key. Fixed sections start collapsed, so a
 * stored id means "expanded". Initiative sections default by status (active
 * expanded, done collapsed), so they record the explicit choice instead:
 * `initiative:<id>` is expanded and `initiative-collapsed:<id>` is collapsed.
 */
export const WORK_SECTIONS_STORAGE_KEY = "inertia:sidebar:work-sections:v1";

/** Fixed collapsible date sections; they start collapsed. */
export const COLLAPSIBLE_WORK_SECTIONS: ReadonlySet<SidebarWorkSectionId> = new Set([
  "earlier",
  "done",
  "snoozed",
  "no-project-done",
  "no-project-snoozed",
]);
const FIXED_COLLAPSIBLE_SECTIONS: ReadonlySet<string> = COLLAPSIBLE_WORK_SECTIONS;

/** Fixed collapsible sections plus every dynamic initiative section. */
export function isCollapsibleWorkSection(id: SidebarWorkSectionId): boolean {
  return COLLAPSIBLE_WORK_SECTIONS.has(id) || isInitiativeWorkSectionId(id);
}
const COLLAPSED_INITIATIVE_PREFIX = "initiative-collapsed:";
const INITIATIVE_TOKEN = /^initiative(?:-collapsed)?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MAX_STORED_TOKENS = 256;

export type WorkSectionPreferences = ReadonlySet<string>;

function validToken(token: string): boolean {
  return FIXED_COLLAPSIBLE_SECTIONS.has(token) || INITIATIVE_TOKEN.test(token);
}

export function parseWorkSectionPreferences(stored: string | null): WorkSectionPreferences {
  return new Set((stored ?? "").split(",").filter(validToken).slice(0, MAX_STORED_TOKENS));
}

export function readWorkSectionPreferences(): WorkSectionPreferences {
  try {
    return parseWorkSectionPreferences(window.localStorage.getItem(WORK_SECTIONS_STORAGE_KEY));
  } catch {
    return new Set();
  }
}

/** Drops initiative tokens for initiatives that no longer exist, when known. */
export function serializeWorkSectionPreferences(
  preferences: WorkSectionPreferences,
  knownInitiativeIds?: ReadonlySet<string>,
): string {
  return [...preferences].filter((token) => {
    if (!knownInitiativeIds || !INITIATIVE_TOKEN.test(token)) return true;
    return knownInitiativeIds.has(token.slice(token.indexOf(":") + 1));
  }).join(",");
}

function collapsedToken(sectionId: string): string {
  return `${COLLAPSED_INITIATIVE_PREFIX}${sectionId.slice("initiative:".length)}`;
}

function initiativeExpanded(
  preferences: WorkSectionPreferences,
  section: Pick<SidebarWorkSection, "id" | "initiative">,
): boolean {
  if (preferences.has(section.id)) return true;
  if (preferences.has(collapsedToken(section.id))) return false;
  return section.initiative?.status === "active";
}

/** The set of currently expanded collapsible sections for the Work index. */
export function expandedWorkSections(
  preferences: WorkSectionPreferences,
  sections: readonly Pick<SidebarWorkSection, "id" | "initiative">[],
): ReadonlySet<SidebarWorkSectionId> {
  const expanded = new Set<SidebarWorkSectionId>();
  for (const token of preferences) {
    if (FIXED_COLLAPSIBLE_SECTIONS.has(token)) expanded.add(token as SidebarWorkSectionId);
  }
  for (const section of sections) {
    if (isInitiativeWorkSectionId(section.id) && initiativeExpanded(preferences, section)) {
      expanded.add(section.id);
    }
  }
  return expanded;
}

export function toggleWorkSectionPreference(
  preferences: WorkSectionPreferences,
  section: Pick<SidebarWorkSection, "id" | "initiative">,
): WorkSectionPreferences {
  const next = new Set(preferences);
  if (!isInitiativeWorkSectionId(section.id)) {
    if (next.has(section.id)) next.delete(section.id);
    else next.add(section.id);
    return next;
  }
  const collapsed = collapsedToken(section.id);
  const wasExpanded = initiativeExpanded(preferences, section);
  next.delete(section.id);
  next.delete(collapsed);
  next.add(wasExpanded ? collapsed : section.id);
  return next;
}
