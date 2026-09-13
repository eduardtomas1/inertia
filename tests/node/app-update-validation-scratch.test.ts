// @inertia-test-suite portable

import {
  existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  appUpdateCandidateViabilityRequest,
  parseAppUpdateCandidateViabilityRequest,
} from "../../src/node/app-update-candidate-viability-protocol";
import {
  createAppUpdateCloneFile, createAppUpdateScratch, validateAppUpdateScratch,
} from "../../src/node/app-update-validation-scratch";

const operationId = "11111111-1111-4111-8111-111111111111";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("update validation temporary storage authority", () => {
  it("binds a fresh private directory to one operation and removes its SQLite file family", () => {
    const scratch = createAppUpdateScratch(operationId);
    roots.push(scratch.identity.directory);
    expect(() => validateAppUpdateScratch(scratch.identity, operationId)).not.toThrow();
    expect(() => validateAppUpdateScratch(scratch.identity, "22222222-2222-4222-8222-222222222222"))
      .toThrow("invalid-request");
    const path = createAppUpdateCloneFile(scratch.identity, operationId);
    for (const suffix of ["", "-wal", "-shm", "-journal"]) writeFileSync(`${path}${suffix}`, "private fixture");
    scratch.remove();
    expect(existsSync(scratch.identity.directory)).toBe(false);
    expect(() => scratch.remove()).not.toThrow();
  });

  it("refuses a replacement directory and leaves its files intact", () => {
    const scratch = createAppUpdateScratch(operationId);
    const directory = scratch.identity.directory;
    const moved = `${directory}-moved`;
    roots.push(directory, moved);
    renameSync(directory, moved);
    mkdirSync(directory, { mode: 0o700 });
    const marker = join(directory, "candidate.sqlite");
    writeFileSync(marker, "replacement");
    expect(() => createAppUpdateCloneFile(scratch.identity, operationId)).toThrow("invalid-request");
    expect(() => scratch.remove()).toThrow("invalid-request");
    expect(readFileSync(marker, "utf8")).toBe("replacement");
  });

  it("refuses unexpected entries without recursively deleting them", () => {
    const scratch = createAppUpdateScratch(operationId);
    roots.push(scratch.identity.directory);
    const unexpected = join(scratch.identity.directory, "unrelated");
    writeFileSync(unexpected, "preserve");
    expect(() => createAppUpdateCloneFile(scratch.identity, operationId)).toThrow("invalid-request");
    expect(() => scratch.remove()).toThrow("validation-failed");
    expect(readFileSync(unexpected, "utf8")).toBe("preserve");
  });

  it.skipIf(process.platform === "win32")("never follows a clone symlink when creating or removing temporary files", () => {
    const scratch = createAppUpdateScratch(operationId);
    const outside = createAppUpdateScratch(operationId);
    roots.push(scratch.identity.directory, outside.identity.directory);
    const target = join(outside.identity.directory, "candidate.sqlite");
    writeFileSync(target, "outside");
    symlinkSync(target, join(scratch.identity.directory, "candidate.sqlite"));
    expect(() => createAppUpdateCloneFile(scratch.identity, operationId)).toThrow("invalid-request");
    scratch.remove();
    expect(readFileSync(target, "utf8")).toBe("outside");
  });

  it("requires bounded path and file identity fields at the worker boundary", () => {
    const scratch = createAppUpdateScratch(operationId);
    roots.push(scratch.identity.directory);
    const request = appUpdateCandidateViabilityRequest({
      operationId, dataDirectory: scratch.identity.directory, scratch: scratch.identity,
    });
    expect(parseAppUpdateCandidateViabilityRequest(request)).toEqual(request);
    for (const invalid of [
      { ...scratch.identity, inode: "-1" }, { ...scratch.identity, device: null },
      { ...scratch.identity, directory: "relative/path" }, { ...scratch.identity, extra: true },
    ]) expect(parseAppUpdateCandidateViabilityRequest({ ...request, scratch: invalid })).toBeNull();
  });
});
