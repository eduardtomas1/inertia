import { lstatSync, mkdirSync, realpathSync, type Stats } from "node:fs";
import { join } from "node:path";

import type { Conversation } from "../../shared/contracts";
import type { RuntimeStore } from "../database";
import { normalizeIdentityPath } from "../project-identity";
import { RuntimeRequestError } from "../runtime-errors";

/**
 * An initiative's skills live in Inertia's data folder, at
 * `<data>/initiatives/<initiative id>/skills/.claude/skills/<skill>/SKILL.md`.
 * The `skills` folder is the root handed to skill discovery; skills go in its
 * `.claude/skills` folder, the layout Claude uses under a project, which is
 * the folder Inertia opens for the user. The paths stay in the privileged
 * runtime and main process; the renderer never receives them.
 */
const ROOT_SEGMENTS = (initiativeId: string): string[] => ["initiatives", initiativeId, "skills"];
const SKILLS_SEGMENTS = [".claude", "skills"] as const;
const INITIATIVE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export const INITIATIVE_SKILLS_FOLDER_REFUSAL =
  "The initiative's skills folder could not be verified. Remove any link in its place and try again.";

function refused(): never {
  throw new RuntimeRequestError(INITIATIVE_SKILLS_FOLDER_REFUSAL);
}

function entry(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Walks from the real data folder through each segment. Every component must
 * be a real directory, never a link, and the result must resolve to exactly
 * the expected place, so the folder can never lead outside the data folder.
 * Missing components are created (owner-only) when `create` is set; otherwise
 * a missing component yields null.
 */
function containedDirectory(base: string, segments: readonly string[], create: boolean): string | null {
  let current = base;
  for (const segment of segments) {
    current = join(current, segment);
    let status = entry(current);
    if (!status) {
      if (!create) return null;
      try {
        mkdirSync(current, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      status = entry(current);
    }
    if (!status || status.isSymbolicLink() || !status.isDirectory()) refused();
  }
  const resolved = realpathSync.native(current);
  if (normalizeIdentityPath(resolved) !== normalizeIdentityPath(current)) refused();
  return resolved;
}

function realDataDirectory(dataDirectory: string): string {
  return realpathSync.native(dataDirectory);
}

function requireInitiativeId(initiativeId: string): void {
  if (!INITIATIVE_ID.test(initiativeId)) throw new RuntimeRequestError("That initiative no longer exists.");
}

/**
 * Creates the folder on demand and returns the real path of its
 * `.claude/skills` folder, where the user adds skills.
 */
export function ensureInitiativeSkillsFolder(dataDirectory: string, initiativeId: string): string {
  requireInitiativeId(initiativeId);
  try {
    const root = containedDirectory(realDataDirectory(dataDirectory), ROOT_SEGMENTS(initiativeId), true)!;
    return containedDirectory(root, SKILLS_SEGMENTS, true)!;
  } catch (error) {
    // Filesystem errors name paths; only readable refusals leave the runtime.
    if (error instanceof RuntimeRequestError) throw error;
    throw new RuntimeRequestError("The initiative's skills folder could not be created.");
  }
}

/**
 * The real path of an existing, contained skills root, or null when it is
 * missing or refused (a link anywhere along it, or anything but folders).
 * Discovery never creates the folder.
 */
export function resolveInitiativeSkillsRoot(dataDirectory: string, initiativeId: string): string | null {
  if (!INITIATIVE_ID.test(initiativeId)) return null;
  try {
    const root = containedDirectory(realDataDirectory(dataDirectory), ROOT_SEGMENTS(initiativeId), false);
    return root && containedDirectory(root, SKILLS_SEGMENTS, false) ? root : null;
  } catch {
    return null;
  }
}

/**
 * The initiative whose skills folder a chat may use: its initiative is not
 * archived and has the folder turned on. Reads only the database, never the
 * disk, so it is cheap enough for every workflow state read.
 */
export function initiativeOfferingSkillsFolder(
  store: Pick<RuntimeStore, "initiatives">,
  conversation: Pick<Conversation, "initiativeId">,
): string | null {
  if (!conversation.initiativeId) return null;
  const initiative = store.initiatives.get(conversation.initiativeId);
  return initiative && initiative.status !== "archived" && initiative.preferences.skillsFolder
    ? initiative.id
    : null;
}

/**
 * The skills root a chat's provider may read: its initiative offers the
 * folder (see `initiativeOfferingSkillsFolder`) and the folder passes
 * containment, checked on disk at each call.
 */
export function initiativeSkillsRootFor(
  store: Pick<RuntimeStore, "initiatives">,
  dataDirectory: string,
  conversation: Pick<Conversation, "initiativeId">,
): string | null {
  const initiativeId = initiativeOfferingSkillsFolder(store, conversation);
  return initiativeId ? resolveInitiativeSkillsRoot(dataDirectory, initiativeId) : null;
}

/**
 * The folder the file manager opens, created when needed. Only an initiative
 * with its skills folder turned on has one.
 */
export function initiativeSkillsFolderPath(
  store: Pick<RuntimeStore, "initiatives">,
  dataDirectory: string,
  initiativeId: string,
): string {
  const initiative = store.initiatives.get(initiativeId);
  if (!initiative) throw new RuntimeRequestError("That initiative no longer exists.");
  if (!initiative.preferences.skillsFolder) {
    throw new RuntimeRequestError("Turn on the skills folder for this initiative first.");
  }
  return ensureInitiativeSkillsFolder(dataDirectory, initiative.id);
}
