import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { cleanupGeminiSessionArtifacts } from
  "../../src/server/provider/gemini-session-cleanup";
import { removePortableFixture } from "../helpers/portable-provider-fixture";

const roots: string[] = [];

function fixture(): {
  root: string;
  home: string;
  cwd: string;
  project: string;
} {
  const root = mkdtempSync(join(tmpdir(), "inertia-gemini-cleanup-"));
  roots.push(root);
  const home = join(root, "home");
  const cwd = join(root, "workspace");
  const project = join(home, ".gemini", "tmp", "workspace-project");
  mkdirSync(join(project, "chats"), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(project, ".project_root"), `${cwd}\n`);
  return { root, home, cwd, project };
}

function sessionFile(
  directory: string,
  sessionId: string,
  suffix = sessionId.slice(0, 8),
): string {
  const path = join(directory, `session-2026-09-04T10-30-${suffix}.jsonl`);
  writeFileSync(path, [
    JSON.stringify({
      sessionId,
      projectHash: "fixture",
      startTime: "2026-09-04T10:30:00.000Z",
    }),
    JSON.stringify({ id: "message", type: "user", content: "private prompt" }),
    "",
  ].join("\n"));
  return path;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removePortableFixture));
});

describe("Gemini ACP provider-owned session cleanup", () => {
  it("removes only exact run and descendant identities from the attested project", async () => {
    const { home, cwd, project } = fixture();
    const parentId = "inertia-11111111-1111-4111-8111-111111111111";
    const acpId = "22222222-2222-4222-8222-222222222222";
    const childId = "33333333-3333-4333-8333-333333333333";
    const unrelatedId = "44444444-4444-4444-8444-444444444444";
    const chats = join(project, "chats");
    const parentFile = sessionFile(chats, parentId);
    const acpFile = sessionFile(chats, acpId);
    const unrelatedFile = sessionFile(chats, unrelatedId);

    const descendants = join(chats, acpId);
    mkdirSync(descendants, { recursive: true });
    sessionFile(descendants, childId, childId);
    for (const id of [parentId, acpId, childId]) {
      mkdirSync(join(project, "tool-outputs", `session-${id}`), {
        recursive: true,
      });
      writeFileSync(join(project, "tool-outputs", `session-${id}`, "tool.txt"), "private");
      mkdirSync(join(project, "logs"), { recursive: true });
      writeFileSync(join(project, "logs", `session-${id}.jsonl`), "private\n");
      mkdirSync(join(project, id), { recursive: true });
      writeFileSync(join(project, id, "plan.md"), "private\n");
    }
    mkdirSync(join(project, "tool-outputs", `session-${unrelatedId}`), {
      recursive: true,
    });

    await cleanupGeminiSessionArtifacts({
      cwd,
      environment: { GEMINI_CLI_HOME: home },
      sessionIds: [parentId, acpId],
      requiredSessionIds: [parentId, acpId],
    });

    expect(existsSync(parentFile)).toBe(false);
    expect(existsSync(acpFile)).toBe(false);
    expect(existsSync(descendants)).toBe(false);
    for (const id of [parentId, acpId, childId]) {
      expect(existsSync(join(project, "logs", `session-${id}.jsonl`))).toBe(false);
      expect(existsSync(join(project, "tool-outputs", `session-${id}`))).toBe(false);
      expect(existsSync(join(project, id))).toBe(false);
    }
    expect(readFileSync(unrelatedFile, "utf8")).toContain(unrelatedId);
    expect(existsSync(join(project, "tool-outputs", `session-${unrelatedId}`)))
      .toBe(true);
  });

  it("refuses an unattested or ambiguous workspace without removing records", async () => {
    const { home, cwd, project } = fixture();
    const sessionId = "55555555-5555-4555-8555-555555555555";
    const path = sessionFile(join(project, "chats"), sessionId);
    writeFileSync(join(project, ".project_root"), join(cwd, "other"));

    await expect(cleanupGeminiSessionArtifacts({
      cwd,
      environment: { GEMINI_CLI_HOME: home },
      sessionIds: [sessionId],
    })).rejects.toThrow(/attest the workspace/iu);
    expect(existsSync(path)).toBe(true);

    writeFileSync(join(project, ".project_root"), cwd);
    const duplicate = join(home, ".gemini", "tmp", "workspace-project-2");
    mkdirSync(duplicate, { recursive: true });
    writeFileSync(join(duplicate, ".project_root"), cwd);
    await expect(cleanupGeminiSessionArtifacts({
      cwd,
      environment: { GEMINI_CLI_HOME: home },
      sessionIds: [sessionId],
    })).rejects.toThrow(/ambiguous/iu);
    expect(existsSync(path)).toBe(true);
  });

  it("does not follow a chat-file symlink or accept crafted session identities", async () => {
    const { root, home, cwd, project } = fixture();
    const sessionId = "66666666-6666-4666-8666-666666666666";
    const target = join(root, "outside.jsonl");
    writeFileSync(target, `${JSON.stringify({ sessionId })}\nprivate\n`);
    const link = join(
      project,
      "chats",
      `session-2026-09-04T10-30-${sessionId.slice(0, 8)}.jsonl`,
    );
    symlinkSync(target, link);

    await cleanupGeminiSessionArtifacts({
      cwd,
      environment: { GEMINI_CLI_HOME: home },
      sessionIds: [sessionId],
    });
    expect(readFileSync(target, "utf8")).toContain("private");
    expect(existsSync(link)).toBe(true);

    await expect(cleanupGeminiSessionArtifacts({
      cwd,
      environment: { GEMINI_CLI_HOME: home },
      sessionIds: ["../outside"],
    })).rejects.toThrow(/invalid session identity/iu);
  });

  it.skipIf(process.platform === "win32")(
    "uses exact POSIX environment casing like the Gemini child process",
    async () => {
      const { root, home, cwd, project } = fixture();
      const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const path = sessionFile(join(project, "chats"), sessionId);
      const differentHome = join(root, "different-home");

      await cleanupGeminiSessionArtifacts({
        cwd,
        environment: {
          HOME: differentHome,
          gemini_cli_home: home,
        },
        sessionIds: [sessionId],
      });
      expect(existsSync(path)).toBe(true);

      await cleanupGeminiSessionArtifacts({
        cwd,
        environment: {
          GEMINI_CLI_HOME: home,
          gemini_cli_home: differentHome,
        },
        sessionIds: [sessionId],
        requiredSessionIds: [sessionId],
      });
      expect(existsSync(path)).toBe(false);
    },
  );

  it("is idempotent when Gemini created no storage", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-gemini-cleanup-empty-"));
    roots.push(root);
    await expect(cleanupGeminiSessionArtifacts({
      cwd: root,
      environment: { GEMINI_CLI_HOME: join(root, "home") },
      sessionIds: ["77777777-7777-4777-8777-777777777777"],
    })).resolves.toBeUndefined();

    await expect(cleanupGeminiSessionArtifacts({
      cwd: root,
      environment: { GEMINI_CLI_HOME: join(root, "home") },
      sessionIds: ["77777777-7777-4777-8777-777777777777"],
      requiredSessionIds: ["77777777-7777-4777-8777-777777777777"],
    })).rejects.toThrow(/attest the workspace/iu);

    await expect(cleanupGeminiSessionArtifacts({
      cwd: root,
      environment: { GEMINI_CLI_HOME: join(root, "home") },
      sessionIds: ["77777777-7777-4777-8777-777777777777"],
      requiredSessionIds: ["88888888-8888-4888-8888-888888888888"],
    })).rejects.toThrow(/unowned required session identity/iu);
  });
});
