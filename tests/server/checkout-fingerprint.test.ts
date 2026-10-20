import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  captureCheckoutFingerprint,
  diffCheckoutFingerprints,
  MAX_CHECKOUT_FINGERPRINT_PATHS,
  type CapturedCheckoutFingerprint,
  type CheckoutFingerprint,
} from "../../src/server/git/checkout-fingerprint";

const roots: string[] = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "inertia-checkout-fingerprint-")));
  roots.push(root);
  return root;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function repository(): string {
  const root = join(temporaryDirectory(), "repo");
  mkdirSync(root);
  git(root, "init", "-q");
  git(root, "config", "user.email", "fingerprint@example.invalid");
  git(root, "config", "user.name", "Fingerprint");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, "a.txt"), "alpha\n");
  writeFileSync(join(root, "b.txt"), "bravo\n");
  git(root, "add", "a.txt", "b.txt");
  git(root, "commit", "-q", "-m", "initial");
  return root;
}

async function capture(root: string): Promise<CheckoutFingerprint> {
  return await captureCheckoutFingerprint(root, { deadlineAt: Date.now() + 30_000 });
}

function captured(fingerprint: CheckoutFingerprint): CapturedCheckoutFingerprint {
  expect(fingerprint.state).toBe("captured");
  return fingerprint as CapturedCheckoutFingerprint;
}

/** Moves a file's mtime forward so Git must look past its cached stat data. */
function ageForward(path: string): void {
  const later = new Date(Date.now() + 5_000);
  utimesSync(path, later, later);
}

describe("checkout fingerprint", () => {
  it("fingerprints an unchanged checkout the same way twice", async () => {
    const root = repository();
    writeFileSync(join(root, "a.txt"), "alpha changed\n");
    const first = captured(await capture(root));
    const second = captured(await capture(root));
    expect(first.head).toMatch(/^[0-9a-f]{40,64}$/u);
    expect(second.entries).toEqual(first.entries);
    expect(diffCheckoutFingerprints(first, second)).toEqual({ headChanged: false, changedPaths: [] });
  });

  it("detects a modified dirty file, an untracked file, a staged change and a new commit", async () => {
    const root = repository();
    writeFileSync(join(root, "a.txt"), "alpha one\n");
    const before = captured(await capture(root));

    writeFileSync(join(root, "a.txt"), "alpha two\n");
    writeFileSync(join(root, "untracked.txt"), "new\n");
    writeFileSync(join(root, "b.txt"), "bravo staged\n");
    git(root, "add", "b.txt");
    const after = captured(await capture(root));
    expect(diffCheckoutFingerprints(before, after)).toEqual({
      headChanged: false,
      changedPaths: ["a.txt", "b.txt", "untracked.txt"],
    });

    git(root, "commit", "-q", "-m", "second");
    const committed = captured(await capture(root));
    expect(diffCheckoutFingerprints(after, committed)).toMatchObject({ headChanged: true, changedPaths: ["b.txt"] });
  });

  it("never refreshes the index or runs a configured clean filter", async () => {
    const root = repository();
    const marker = join(root, "..", "clean-filter-ran");
    const script = join(root, "..", "clean-filter.cjs");
    writeFileSync(script, [
      "const fs = require(\"node:fs\");",
      `fs.writeFileSync(${JSON.stringify(marker)}, "ran");`,
      "process.stdin.pipe(process.stdout);",
    ].join("\n"));
    const quoted = (value: string) => `"${value.replaceAll("\\", "/")}"`;
    git(root, "config", "filter.marker.clean", `${quoted(process.execPath)} ${quoted(script)}`);
    git(root, "config", "filter.marker.required", "true");
    writeFileSync(join(root, ".git", "info", "attributes"), "*.txt filter=marker\n");
    const index = join(root, ".git", "index");
    const indexBytes = readFileSync(index);
    const indexMtime = statSync(index).mtimeMs;

    // Same size, newer mtime: an ordinary status would hash it through the
    // clean filter and rewrite the index with fresh stat data.
    writeFileSync(join(root, "a.txt"), "ALPHA\n");
    ageForward(join(root, "a.txt"));
    ageForward(join(root, "b.txt"));
    const fingerprint = captured(await capture(root));

    expect(existsSync(marker)).toBe(false);
    expect(statSync(index).mtimeMs).toBe(indexMtime);
    expect(readFileSync(index).equals(indexBytes)).toBe(true);
    expect([...fingerprint.entries.keys()]).toContain("a.txt");
    expect(git(root, "for-each-ref", "refs/inertia")).toBe("");
  });

  it("reports a checkout with too many changed paths as truncated", async () => {
    const root = repository();
    const directory = join(root, "generated");
    mkdirSync(directory);
    for (let index = 0; index <= MAX_CHECKOUT_FINGERPRINT_PATHS; index += 1) {
      writeFileSync(join(directory, `file-${index}.txt`), `${index}\n`);
    }
    await expect(capture(root)).resolves.toMatchObject({ state: "truncated", root });
  });

  it("reports a folder outside Git as unavailable", async () => {
    const folder = temporaryDirectory();
    writeFileSync(join(folder, "notes.txt"), "not a repository\n");
    await expect(capture(folder)).resolves.toMatchObject({ state: "unavailable" });
  });

  it("refuses to compare fingerprints of different checkouts", async () => {
    const first = captured(await capture(repository()));
    const second = captured(await capture(repository()));
    expect(() => diffCheckoutFingerprints(first, second)).toThrow("different repositories");
  });
});
