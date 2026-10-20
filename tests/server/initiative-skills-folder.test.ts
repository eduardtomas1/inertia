import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { RuntimeRequestError } from "../../src/server/runtime-errors";
import {
  ensureInitiativeSkillsFolder,
  INITIATIVE_SKILLS_FOLDER_REFUSAL,
  initiativeSkillsRootFor,
  resolveInitiativeSkillsRoot,
} from "../../src/server/runtime/initiative-skills-folder";

const roots: string[] = [];
const stores: RuntimeStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function dataDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), "inertia-initiative-skills-"));
  roots.push(root);
  const data = join(root, "data");
  mkdirSync(data);
  return data;
}

describe("initiative skills folder", () => {
  it("creates the contained layout on demand and resolves only an existing one", () => {
    const data = dataDirectory();
    const id = randomUUID();
    expect(resolveInitiativeSkillsRoot(data, id)).toBeNull();

    const skills = ensureInitiativeSkillsFolder(data, id);
    const root = join(realpathSync.native(data), "initiatives", id, "skills");
    expect(skills).toBe(join(root, ".claude", "skills"));
    if (process.platform !== "win32") expect(statSync(skills).mode & 0o777).toBe(0o700);
    expect(resolveInitiativeSkillsRoot(data, id)).toBe(root);
    // Ensuring again is harmless and keeps what the user added.
    writeFileSync(join(skills, "notes.txt"), "kept");
    expect(ensureInitiativeSkillsFolder(data, id)).toBe(skills);
    expect(statSync(join(skills, "notes.txt")).isFile()).toBe(true);
  });

  it("rejects identities that are not initiative ids", () => {
    const data = dataDirectory();
    for (const id of ["../escape", "", "not-a-uuid"]) {
      expect(resolveInitiativeSkillsRoot(data, id)).toBeNull();
      expect(() => ensureInitiativeSkillsFolder(data, id)).toThrow(RuntimeRequestError);
    }
  });

  it.skipIf(process.platform === "win32")("refuses a folder that a link leads outside the data folder", () => {
    const data = dataDirectory();
    const outside = join(data, "..", "outside");
    mkdirSync(join(outside, ".claude", "skills"), { recursive: true });

    // The initiative's own folder is a link.
    const linked = randomUUID();
    mkdirSync(join(data, "initiatives", linked), { recursive: true });
    symlinkSync(outside, join(data, "initiatives", linked, "skills"), "dir");
    expect(resolveInitiativeSkillsRoot(data, linked)).toBeNull();
    expect(() => ensureInitiativeSkillsFolder(data, linked)).toThrow(INITIATIVE_SKILLS_FOLDER_REFUSAL);

    // A link further in, at `.claude`, is refused as well.
    const inner = randomUUID();
    mkdirSync(join(data, "initiatives", inner, "skills"), { recursive: true });
    symlinkSync(join(outside, ".claude"), join(data, "initiatives", inner, "skills", ".claude"), "dir");
    expect(resolveInitiativeSkillsRoot(data, inner)).toBeNull();
    expect(() => ensureInitiativeSkillsFolder(data, inner)).toThrow(INITIATIVE_SKILLS_FOLDER_REFUSAL);

    // So is a link in place of the shared `initiatives` folder.
    const other = dataDirectory();
    symlinkSync(join(data, "initiatives"), join(other, "initiatives"), "dir");
    expect(resolveInitiativeSkillsRoot(other, linked)).toBeNull();
    expect(() => ensureInitiativeSkillsFolder(other, randomUUID())).toThrow(INITIATIVE_SKILLS_FOLDER_REFUSAL);
  });

  it("refuses a file in place of a folder", () => {
    const data = dataDirectory();
    const id = randomUUID();
    mkdirSync(join(data, "initiatives", id), { recursive: true });
    writeFileSync(join(data, "initiatives", id, "skills"), "not a folder");
    expect(resolveInitiativeSkillsRoot(data, id)).toBeNull();
    expect(() => ensureInitiativeSkillsFolder(data, id)).toThrow(INITIATIVE_SKILLS_FOLDER_REFUSAL);
  });

  it("offers the folder to a chat only while its initiative is not archived and the folder is on", () => {
    const data = dataDirectory();
    const store = new RuntimeStore(join(data, "inertia.sqlite"), data, { recoverInterruptedRuns: false });
    stores.push(store);
    const project = store.createProject("Skills", data);
    let initiative = store.initiatives.create({ id: randomUUID(), name: "Shared skills" });
    const chat = store.createConversation(project.id, "Member", { initiativeId: initiative.id });
    const root = join(realpathSync.native(data), "initiatives", initiative.id, "skills");

    expect(initiativeSkillsRootFor(store, data, chat)).toBeNull();
    ensureInitiativeSkillsFolder(data, initiative.id);
    expect(initiativeSkillsRootFor(store, data, chat)).toBeNull();
    initiative = store.initiatives.update(initiative.id, initiative.revision, { preferences: { skillsFolder: true } });
    expect(initiativeSkillsRootFor(store, data, chat)).toBe(root);
    expect(initiativeSkillsRootFor(store, data, { initiativeId: null })).toBeNull();
    initiative = store.initiatives.update(initiative.id, initiative.revision, { status: "done" });
    expect(initiativeSkillsRootFor(store, data, chat)).toBe(root);
    initiative = store.initiatives.update(initiative.id, initiative.revision, { status: "archived" });
    expect(initiativeSkillsRootFor(store, data, chat)).toBeNull();
    // A folder removed by the user is not recreated by discovery.
    initiative = store.initiatives.update(initiative.id, initiative.revision, { status: "active" });
    rmSync(root, { recursive: true });
    expect(initiativeSkillsRootFor(store, data, chat)).toBeNull();
  });
});
