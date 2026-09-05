import { describe, expect, it } from "vitest";
import {
  validProjectCloneUrl,
  validProjectDirectoryName,
} from "../../src/shared/project-import";

describe("project source validation", () => {
  it.each([
    "https://github.com/owner/repo.git",
    "https://gitlab.com/group/repo",
    "git@bitbucket.org:owner/repo.git",
    "ssh://git@ssh.dev.azure.com/v3/org/project/repo",
  ])("accepts repository identity %s", (url) =>
    expect(validProjectCloneUrl(url)).toBe(true),
  );
  it.each([
    "--upload-pack=sh",
    "file:///tmp/repo",
    "ext::sh -c command",
    "https://token@github.com/o/r",
    "https://u:secret@github.com/o/r",
    "https://github.com/o/r?token=secret",
    "https://github.com/o/r#secret",
    "git@host:o/r\n--option",
    "http://host/repo",
  ])("rejects credentials, local protocols, and arguments: %s", (url) =>
    expect(validProjectCloneUrl(url)).toBe(false),
  );
  it.each(["repo", "my-project", "example.app", "repository_2"])(
    "accepts portable directory %s",
    (name) => expect(validProjectDirectoryName(name)).toBe(true),
  );
});
