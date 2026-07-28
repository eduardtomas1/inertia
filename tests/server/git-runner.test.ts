import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runGit } from "../../src/server/git/runner";
import { gitProcessEnvironment } from "../../src/server/git/environment";
import { GitError } from "../../src/server/git/types";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true })),
  );
});

describe("Git runner locale", () => {
  it("overrides inherited locales for every Git child process", () => {
    expect(gitProcessEnvironment({
      LANG: "es_ES.UTF-8",
      LC_ALL: "es_ES.UTF-8",
      SENTINEL: "preserved",
    })).toMatchObject({
      LANG: "C",
      LC_ALL: "C",
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "",
      SENTINEL: "preserved",
    });
  });

  it("classifies Git failures in a stable C locale", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inertia-git-locale-"));
    temporaryDirectories.push(directory);
    const previousLang = process.env.LANG;
    const previousLocale = process.env.LC_ALL;
    process.env.LANG = "es_ES.UTF-8";
    process.env.LC_ALL = "es_ES.UTF-8";
    try {
      await expect(runGit(directory, ["status"], {
        failureMessage: "Git status failed.",
      })).rejects.toMatchObject({
        code: "not-repository",
      } satisfies Partial<GitError>);
    } finally {
      if (previousLang === undefined) delete process.env.LANG;
      else process.env.LANG = previousLang;
      if (previousLocale === undefined) delete process.env.LC_ALL;
      else process.env.LC_ALL = previousLocale;
    }
  });
});
