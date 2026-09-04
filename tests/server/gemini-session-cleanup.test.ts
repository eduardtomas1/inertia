import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
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

function subagentFile(
  directory: string,
  sessionId: string,
  options: {
    fileName?: string;
    kind?: string;
    projectHash?: string;
  } = {},
): string {
  const path = join(directory, options.fileName ?? `${sessionId}.jsonl`);
  writeFileSync(path, `${JSON.stringify({
    sessionId,
    projectHash: options.projectHash ?? "fixture",
    kind: options.kind ?? "subagent",
    startTime: "2026-09-04T10:30:00.000Z",
  })}\n`);
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
    subagentFile(descendants, childId);
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

  it("fails closed when an owned session identity has duplicate chat records", async () => {
    const { home, cwd, project } = fixture();
    const sessionId = "56565656-5656-4656-8656-565656565656";
    const first = sessionFile(join(project, "chats"), sessionId, "first");
    const duplicate = sessionFile(
      join(project, "chats"),
      sessionId,
      "duplicate",
    );

    await expect(cleanupGeminiSessionArtifacts({
      cwd,
      environment: { GEMINI_CLI_HOME: home },
      sessionIds: [sessionId],
      requiredSessionIds: [sessionId],
    })).rejects.toThrow(/ambiguous owned chat records/iu);
    expect(existsSync(first)).toBe(true);
    expect(existsSync(duplicate)).toBe(true);
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
    "rejects a symlinked provider-owned .gemini root without touching its target",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "inertia-gemini-cleanup-link-"));
      roots.push(root);
      const home = join(root, "home");
      const cwd = join(root, "workspace");
      const outsideGemini = join(root, "outside-gemini");
      const project = join(outsideGemini, "tmp", "workspace-project");
      mkdirSync(home, { recursive: true });
      mkdirSync(join(project, "chats"), { recursive: true });
      mkdirSync(cwd, { recursive: true });
      writeFileSync(join(project, ".project_root"), `${cwd}\n`);
      const sessionId = "90909090-9090-4090-8090-909090909090";
      const chat = sessionFile(join(project, "chats"), sessionId);
      symlinkSync(outsideGemini, join(home, ".gemini"), "dir");

      await expect(cleanupGeminiSessionArtifacts({
        cwd,
        environment: { GEMINI_CLI_HOME: home },
        sessionIds: [sessionId],
        requiredSessionIds: [sessionId],
      })).rejects.toThrow(/unsafe storage directory/iu);
      expect(readFileSync(chat, "utf8")).toContain(sessionId);
    },
  );

  it.skipIf(process.platform === "win32")(
    "allows an explicitly configured home boundary to resolve through a symlink",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "inertia-gemini-cleanup-link-"));
      roots.push(root);
      const actualHome = join(root, "actual-home");
      const configuredHome = join(root, "configured-home");
      const cwd = join(root, "workspace");
      const project = join(
        actualHome,
        ".gemini",
        "tmp",
        "workspace-project",
      );
      mkdirSync(join(project, "chats"), { recursive: true });
      mkdirSync(cwd, { recursive: true });
      writeFileSync(join(project, ".project_root"), `${cwd}\n`);
      const sessionId = "90919191-9091-4091-8091-909191919091";
      const chat = sessionFile(join(project, "chats"), sessionId);
      symlinkSync(actualHome, configuredHome, "dir");

      await cleanupGeminiSessionArtifacts({
        cwd,
        environment: { GEMINI_CLI_HOME: configuredHome },
        sessionIds: [sessionId],
        requiredSessionIds: [sessionId],
      });
      expect(existsSync(chat)).toBe(false);
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a symlinked Gemini temp root without touching its target",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "inertia-gemini-cleanup-link-"));
      roots.push(root);
      const home = join(root, "home");
      const cwd = join(root, "workspace");
      const outsideTemp = join(root, "outside-temp");
      const project = join(outsideTemp, "workspace-project");
      mkdirSync(join(home, ".gemini"), { recursive: true });
      mkdirSync(join(project, "chats"), { recursive: true });
      mkdirSync(cwd, { recursive: true });
      writeFileSync(join(project, ".project_root"), `${cwd}\n`);
      const sessionId = "91919191-9191-4191-8191-919191919191";
      const chat = sessionFile(join(project, "chats"), sessionId);
      symlinkSync(outsideTemp, join(home, ".gemini", "tmp"), "dir");

      await expect(cleanupGeminiSessionArtifacts({
        cwd,
        environment: { GEMINI_CLI_HOME: home },
        sessionIds: [sessionId],
        requiredSessionIds: [sessionId],
      })).rejects.toThrow(/unsafe storage directory/iu);
      expect(readFileSync(chat, "utf8")).toContain(sessionId);
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a symlinked chats directory without touching its target",
    async () => {
      const { root, home, cwd, project } = fixture();
      const sessionId = "92929292-9292-4292-8292-929292929292";
      const outsideChats = join(root, "outside-chats");
      mkdirSync(outsideChats, { recursive: true });
      const chat = sessionFile(outsideChats, sessionId);
      rmSync(join(project, "chats"), { recursive: true });
      symlinkSync(outsideChats, join(project, "chats"), "dir");

      await expect(cleanupGeminiSessionArtifacts({
        cwd,
        environment: { GEMINI_CLI_HOME: home },
        sessionIds: [sessionId],
        requiredSessionIds: [sessionId],
      })).rejects.toThrow(/unsafe storage directory/iu);
      expect(readFileSync(chat, "utf8")).toContain(sessionId);
    },
  );

  it.skipIf(process.platform === "win32").each([
    "logs",
    "tool-outputs",
  ])("rejects a symlinked %s ancestor before deleting any record", async (name) => {
    const { root, home, cwd, project } = fixture();
    const sessionId = "93939393-9393-4393-8393-939393939393";
    const chat = sessionFile(join(project, "chats"), sessionId);
    const outside = join(root, `outside-${name}`);
    mkdirSync(outside, { recursive: true });
    const artifact = name === "logs"
      ? join(outside, `session-${sessionId}.jsonl`)
      : join(outside, `session-${sessionId}`, "tool.txt");
    mkdirSync(name === "logs" ? outside : join(outside, `session-${sessionId}`), {
      recursive: true,
    });
    writeFileSync(artifact, "keep\n");
    symlinkSync(outside, join(project, name), "dir");

    await expect(cleanupGeminiSessionArtifacts({
      cwd,
      environment: { GEMINI_CLI_HOME: home },
      sessionIds: [sessionId],
      requiredSessionIds: [sessionId],
    })).rejects.toThrow(/unsafe storage directory/iu);
    expect(readFileSync(chat, "utf8")).toContain(sessionId);
    expect(readFileSync(artifact, "utf8")).toBe("keep\n");
  });

  it.skipIf(process.platform === "win32")(
    "rejects a FIFO ownership marker without blocking for a writer",
    async () => {
      const { home, cwd, project } = fixture();
      const marker = join(project, ".project_root");
      unlinkSync(marker);
      const created = spawnSync("mkfifo", [marker], { stdio: "ignore" });
      expect(created.status).toBe(0);

      await expect(cleanupGeminiSessionArtifacts({
        cwd,
        environment: { GEMINI_CLI_HOME: home },
        sessionIds: ["94949494-9494-4494-8494-949494949494"],
      })).rejects.toThrow(/invalid ownership marker/iu);
    },
  );

  it("does not let corrupt descendant metadata target reserved or unrelated artifacts", async () => {
    const { home, cwd, project } = fixture();
    const parentId = "inertia-99999999-9999-4999-8999-999999999999";
    const acpId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const wrongNameId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const wrongKindId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const wrongProjectId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const nonUuidId = "not-a-uuid-child-id";
    const childId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const nestedId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const chats = join(project, "chats");
    sessionFile(chats, parentId);
    sessionFile(chats, acpId);
    const descendants = join(chats, acpId);
    mkdirSync(descendants, { recursive: true });

    subagentFile(descendants, "tool-outputs");
    subagentFile(descendants, wrongNameId, { fileName: "misnamed.jsonl" });
    subagentFile(descendants, wrongKindId, { kind: "main" });
    subagentFile(descendants, wrongProjectId, { projectHash: "other-project" });
    subagentFile(descendants, nonUuidId);
    subagentFile(descendants, childId);
    const nestedDescendants = join(chats, childId);
    mkdirSync(nestedDescendants, { recursive: true });
    subagentFile(nestedDescendants, nestedId);

    const toolOutputsMarker = join(project, "tool-outputs", "unrelated.txt");
    mkdirSync(join(project, "tool-outputs"), { recursive: true });
    writeFileSync(toolOutputsMarker, "keep\n");
    for (const id of [
      wrongNameId,
      wrongKindId,
      wrongProjectId,
      nonUuidId,
      childId,
      nestedId,
    ]) {
      mkdirSync(join(project, id), { recursive: true });
      writeFileSync(join(project, id, "keep.txt"), "keep\n");
    }

    await cleanupGeminiSessionArtifacts({
      cwd,
      environment: { GEMINI_CLI_HOME: home },
      sessionIds: [parentId, acpId],
      requiredSessionIds: [parentId, acpId],
    });

    expect(readFileSync(toolOutputsMarker, "utf8")).toBe("keep\n");
    expect(existsSync(join(project, childId))).toBe(false);
    for (const id of [
      wrongNameId,
      wrongKindId,
      wrongProjectId,
      nonUuidId,
      nestedId,
    ]) {
      expect(readFileSync(join(project, id, "keep.txt"), "utf8"))
        .toBe("keep\n");
    }
  });

  it.each([
    "chats",
    "CHECKPOINTS",
    "context_trace",
    "degraded-blobs",
    "logs",
    "memory",
    "plans",
    "shell_history",
    "tasks",
    "tracker",
    "TOOL-OUTPUTS",
  ])("rejects the reserved project artifact identity %s", async (sessionId) => {
    const { home, cwd } = fixture();
    await expect(cleanupGeminiSessionArtifacts({
      cwd,
      environment: { GEMINI_CLI_HOME: home },
      sessionIds: [sessionId],
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
