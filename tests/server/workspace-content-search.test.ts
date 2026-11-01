import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clientCommandSchema,
  type ServerEvent,
  WORKSPACE_CONTENT_SEARCH_LIMITS,
} from "../../src/shared/contracts";
import { parseServerEvent } from "../../src/shared/contracts/server-event-schema";
import {
  createProjectWorkspaceCommandHandler,
  type ProjectWorkspaceCommandDependencies,
} from "../../src/server/runtime/commands/project-workspace-commands";
import { detachedChatCommandRejection } from "../../src/server/runtime/detached-chat-runtime-policy";
import type { IncidentObservation } from "../../src/node/application-incidents";
import { publicRuntimeError, userCorrectableRuntimeError } from "../../src/server/runtime-errors";
import { CommandIncidents } from "../../src/server/runtime/command-incidents";
import {
  createRuntimeCommandExecutor,
  defineRuntimeCommandHandler,
  RUNTIME_COMMAND_TYPES,
} from "../../src/server/runtime/commands/command-router";
import { searchWorkspaceContent } from "../../src/server/workspace";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "inertia-content-search-"));
  temporaryDirectories.push(directory);
  return directory;
}

function linkType(): "junction" | "dir" {
  return process.platform === "win32" ? "junction" : "dir";
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("workspace content search", () => {
  it("finds literal, case-insensitive, line-based matches with forward-slash paths", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, "src", "nested"), { recursive: true });
    await writeFile(join(root, "src", "app.ts"), [
      "const first = 1;",
      "  export function NeedleMaker() {",
      "  return needle + NEEDLE;",
      "}",
    ].join("\n"));
    await writeFile(join(root, "src", "nested", "regex.txt"), "a.b*c(d) needle?\n");
    await writeFile(join(root, "src", "nested", "nomatch.txt"), "a-b-c\n");

    const result = await searchWorkspaceContent(root, "needle");
    expect(result.truncated).toBe(false);
    expect(result.matches).toEqual([
      {
        projectPath: "src/app.ts",
        line: 2,
        column: 19,
        snippet: "export function NeedleMaker() {",
      },
      // One result per line: the first occurrence wins.
      {
        projectPath: "src/app.ts",
        line: 3,
        column: 10,
        snippet: "return needle + NEEDLE;",
      },
      {
        projectPath: "src/nested/regex.txt",
        line: 1,
        column: 10,
        snippet: "a.b*c(d) needle?",
      },
    ]);

    // Regex syntax in the query is matched literally.
    const literal = await searchWorkspaceContent(root, "b*C(d)");
    expect(literal.matches.map(({ projectPath, line, column }) => [projectPath, line, column]))
      .toEqual([["src/nested/regex.txt", 1, 3]]);
    expect((await searchWorkspaceContent(root, "a.b-c")).matches).toEqual([]);
  });

  it("counts CRLF and LF lines like the preview and strips carriage returns", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "windows.txt"), "alpha\r\nbeta target\r\ngamma\r\ntarget\r\n");
    await writeFile(join(root, "bom.txt"), "﻿target first\n");

    const result = await searchWorkspaceContent(root, "TARGET");
    expect(result.matches).toEqual([
      { projectPath: "bom.txt", line: 1, column: 1, snippet: "target first" },
      { projectPath: "windows.txt", line: 2, column: 6, snippet: "beta target" },
      { projectPath: "windows.txt", line: 4, column: 1, snippet: "target" },
    ]);
  });

  it("skips binary files, oversized files, ignored folders, and hidden entries", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
    await mkdir(join(root, ".hidden"));
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "text.ts"), "needle\n");
    await writeFile(
      join(root, "src", "binary.bin"),
      Buffer.concat([Buffer.from("needle"), Buffer.from([0, 1, 2]), Buffer.from("needle")]),
    );
    // A NUL after the 8 KiB sniff window does not make a file binary.
    await writeFile(
      join(root, "src", "late-nul.txt"),
      Buffer.concat([
        Buffer.from("needle late\n"),
        Buffer.alloc(WORKSPACE_CONTENT_SEARCH_LIMITS.binarySniffBytes, 0x61),
        Buffer.from([0]),
      ]),
    );
    await writeFile(join(root, "src", "large.txt"), `needle\n${"x".repeat(4_096)}`);
    await writeFile(join(root, "node_modules", "pkg", "index.js"), "needle\n");
    await writeFile(join(root, ".hidden", "secret.ts"), "needle\n");
    await writeFile(join(root, ".env"), "needle\n");

    const result = await searchWorkspaceContent(root, "needle", {
      maxFileBytes: 4_000,
    });
    expect(result.matches.map(({ projectPath }) => projectPath)).toEqual([
      "src/text.ts",
    ]);
    expect(result.truncated).toBe(false);

    const unbounded = await searchWorkspaceContent(root, "needle late");
    expect(unbounded.matches.map(({ projectPath }) => projectPath)).toEqual([
      "src/late-nul.txt",
    ]);
  });

  it("caps results and marks the result truncated", async () => {
    const root = await temporaryDirectory();
    for (let index = 0; index < 5; index += 1) {
      await writeFile(join(root, `file-${index}.txt`), "match\nmatch\n");
    }
    const result = await searchWorkspaceContent(root, "match", { maxResults: 3 });
    expect(result.matches).toHaveLength(3);
    expect(result.truncated).toBe(true);

    const capped = await searchWorkspaceContent(root, "match", { maxResults: 10_000 });
    expect(capped.matches).toHaveLength(10);
    expect(capped.truncated).toBe(false);
  });

  it("returns partial results when the byte or time budget is exhausted", async () => {
    const root = await temporaryDirectory();
    for (let index = 0; index < 4; index += 1) {
      await writeFile(join(root, `file-${index}.txt`), `match ${"x".repeat(100)}\n`);
    }
    const bytes = await searchWorkspaceContent(root, "match", { maxTotalBytes: 250 });
    expect(bytes.matches).toHaveLength(2);
    expect(bytes.bytesRead).toBeLessThanOrEqual(250);
    expect(bytes.truncated).toBe(true);

    let clock = 0;
    const timed = await searchWorkspaceContent(root, "match", {
      timeBudgetMs: 10,
      now: () => clock,
      afterEntryObserved: () => {
        clock += 6;
      },
    });
    expect(timed.matches.length).toBeLessThan(4);
    expect(timed.truncated).toBe(true);
  });

  it("bounds long lines to a snippet around the match", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "min.js"), `${"a".repeat(5_000)}NEEDLE${"b".repeat(5_000)}\n`);
    const [match] = (await searchWorkspaceContent(root, "needle")).matches;
    expect(match).toMatchObject({ projectPath: "min.js", line: 1, column: 5_001 });
    expect(match.snippet.length).toBeLessThanOrEqual(WORKSPACE_CONTENT_SEARCH_LIMITS.snippetCharacters);
    expect(match.snippet).toContain("NEEDLE");
    expect(match.snippet.startsWith("…")).toBe(true);
    expect(match.snippet.endsWith("…")).toBe(true);
  });

  it("never reads through symbolic links or swapped directories", async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    await writeFile(join(outside, "secret.ts"), "needle outside\n");
    await symlink(outside, join(root, "escape"), linkType());
    if (process.platform !== "win32") {
      await symlink(join(outside, "secret.ts"), join(root, "linked.ts"));
    }
    await mkdir(join(root, "race"));
    await writeFile(join(root, "race", "inside.ts"), "needle inside\n");

    const plain = await searchWorkspaceContent(root, "needle");
    expect(plain.matches.map(({ projectPath }) => projectPath)).toEqual([
      "race/inside.ts",
    ]);

    let swapped = false;
    const raced = await searchWorkspaceContent(root, "needle", {
      afterEntryObserved: async (path) => {
        if (path !== "race/inside.ts" || swapped) return;
        swapped = true;
        await rename(join(root, "race"), join(root, "race-moved"));
        await mkdir(join(outside, "race"));
        await writeFile(join(outside, "race", "inside.ts"), "needle outside\n");
        await symlink(join(outside, "race"), join(root, "race"), linkType());
      },
    });
    expect(swapped).toBe(true);
    expect(raced.matches.map(({ snippet }) => snippet)).not.toContain("needle outside");
  });

  it.skipIf(process.platform === "win32")(
    "preserves POSIX backslash file names as literal path characters",
    async () => {
      const root = await temporaryDirectory();
      await writeFile(join(root, "notes\\draft.md"), "needle\n");
      const result = await searchWorkspaceContent(root, "needle");
      expect(result.matches.map(({ projectPath }) => projectPath)).toEqual([
        "notes\\draft.md",
      ]);
    },
  );

  it("rejects invalid queries and cancelled searches", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "a.txt"), "needle\n");
    for (const query of ["", "   ", "a\nb", "a\u0000b", "tab\there", "x".repeat(201)]) {
      await expect(searchWorkspaceContent(root, query))
        .rejects.toMatchObject({ code: "invalid-input" });
    }
  });

  it("answers a cancelled search with an empty, cancelled result instead of an error", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "a.txt"), "needle\n");
    await writeFile(join(root, "b.txt"), "needle\n");
    const before = new AbortController();
    before.abort();
    await expect(searchWorkspaceContent(root, "needle", { signal: before.signal })).resolves.toMatchObject({
      matches: [], truncated: false, cancelled: true,
    });
    const during = new AbortController();
    await expect(searchWorkspaceContent(root, "needle", {
      signal: during.signal,
      afterEntryObserved: () => during.abort(),
    })).resolves.toMatchObject({ matches: [], truncated: false, cancelled: true });
    await expect(searchWorkspaceContent(root, "needle")).resolves.toMatchObject({ cancelled: false });
  });
});

describe("workspace.search.content command", () => {
  const projectId = randomUUID();
  const conversationId = randomUUID();

  it("validates the command payload at the protocol boundary", () => {
    const requestId = randomUUID();
    const parse = (payload: unknown) => clientCommandSchema.safeParse({
      type: "workspace.search.content",
      requestId,
      payload,
    }).success;
    expect(parse({ projectId, query: "needle" })).toBe(true);
    expect(parse({ projectId, conversationId, query: " a b ", maxResults: 200 })).toBe(true);
    expect(parse({ projectId, query: "" })).toBe(false);
    expect(parse({ projectId, query: "   " })).toBe(false);
    expect(parse({ projectId, query: "x".repeat(201) })).toBe(false);
    expect(parse({ projectId, query: "a\u0007b" })).toBe(false);
    expect(parse({ projectId, query: "a", maxResults: 201 })).toBe(false);
    expect(parse({ projectId, query: "a", maxResults: 0 })).toBe(false);
    expect(parse({ projectId, query: "a", regex: true })).toBe(false);
    expect(parse({ projectId: "not-a-uuid", query: "a" })).toBe(false);
  });

  it("validates result events", () => {
    const event = (result: unknown) => ({
      type: "request.result",
      requestId: randomUUID(),
      result,
    });
    expect(parseServerEvent(event({
      kind: "workspace.search.content",
      matches: [{ projectPath: "src/a.ts", line: 1, column: 2, snippet: "x" }],
      truncated: false,
    }))).toMatchObject({ result: { kind: "workspace.search.content" } });
    expect(parseServerEvent(event({
      kind: "workspace.search.content", matches: [], truncated: false, cancelled: true,
    }))).toMatchObject({ result: { cancelled: true } });
    for (const malformed of [
      { kind: "workspace.search.content", matches: [], truncated: false, cancelled: false },
      { kind: "workspace.search.content", matches: [], truncated: true, cancelled: true },
      {
        kind: "workspace.search.content",
        matches: [{ projectPath: "src/a.ts", line: 1, column: 2, snippet: "x" }],
        truncated: false,
        cancelled: true,
      },
      { kind: "workspace.search.content", matches: [], truncated: "no" },
      { kind: "workspace.search.content", matches: [{ projectPath: "a", line: 0, column: 1, snippet: "" }], truncated: false },
      { kind: "workspace.search.content", matches: [{ projectPath: "a", line: 1, column: 1, snippet: "x".repeat(241) }], truncated: false },
    ]) {
      expect(() => parseServerEvent(event(malformed))).toThrow("Malformed server event");
    }
  });

  it("is allowed in a detached chat window only for its own workspace", () => {
    const rejection = (searched: string) => detachedChatCommandRejection(
      { kind: "detached-chat", conversationId, clientId: "detached" } as Parameters<typeof detachedChatCommandRejection>[0],
      {
        type: "workspace.search.content",
        requestId: randomUUID(),
        payload: { projectId, conversationId: searched, query: "needle" },
      },
      {
        snapshot: () => ({
          conversations: [{ id: conversationId, projectId }],
          runs: [],
        }) as unknown as ReturnType<Parameters<typeof detachedChatCommandRejection>[2]["snapshot"]>,
        subagentConversationId: () => null,
        checkpointConversationId: () => null,
        turnConversationId: () => null,
        duoLaunchConversationIds: () => null,
        pendingApproval: () => null,
        pendingInput: () => null,
      },
    );
    expect(rejection(conversationId)).toBeNull();
    expect(rejection(randomUUID())).toBe("That request is unavailable in a detached chat.");
  });

  it("searches the authorized workspace and reports bounded results", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "a.ts"), "one\nNeedle two\n");
    const sent: ServerEvent[] = [];
    const workspacePath = vi.fn((project: string, conversation?: string) => {
      if (project !== projectId || (conversation && conversation !== conversationId)) {
        throw new Error("The conversation does not belong to the project.");
      }
      return root;
    });
    const handler = createProjectWorkspaceCommandHandler({
      workspacePath,
      send: (_socket: WebSocket, event: ServerEvent) => sent.push(event),
    } as unknown as ProjectWorkspaceCommandDependencies);
    const socket = Object.assign(new EventEmitter(), {
      readyState: WebSocket.OPEN,
    }) as unknown as WebSocket;
    const requestId = randomUUID();

    await expect(handler(socket, {
      type: "workspace.search.content",
      requestId,
      payload: { projectId, conversationId, query: "needle" },
    })).resolves.toBe("handled");
    expect(workspacePath).toHaveBeenCalledWith(projectId, conversationId);
    expect(sent).toEqual([{
      type: "request.result",
      requestId,
      result: {
        kind: "workspace.search.content",
        matches: [{ projectPath: "a.ts", line: 2, column: 1, snippet: "Needle two" }],
        truncated: false,
      },
    }]);
    expect((socket as unknown as EventEmitter).listenerCount("close")).toBe(0);

    await expect(handler(socket, {
      type: "workspace.search.content",
      requestId: randomUUID(),
      payload: { projectId, conversationId: randomUUID(), query: "needle" },
    })).rejects.toThrow("does not belong");
    expect(sent).toHaveLength(1);
  });
  it("replies to a superseded search normally, so no failure is recorded", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "a.ts"), "needle\n");
    const sent: ServerEvent[] = [];
    const incidentSink = vi.fn<(observation: IncidentObservation) => unknown>();
    const incidents = new CommandIncidents(incidentSink, "generation-1", userCorrectableRuntimeError);
    const send = (_socket: WebSocket, event: ServerEvent): void => {
      sent.push(incidents.observe(event));
    };
    const handler = createProjectWorkspaceCommandHandler({
      workspacePath: () => root,
      send,
    } as unknown as ProjectWorkspaceCommandDependencies);
    const execute = createRuntimeCommandExecutor({
      handlers: [
        handler,
        defineRuntimeCommandHandler(
          RUNTIME_COMMAND_TYPES.filter((type) => !handler.commandTypes?.includes(type)),
          async () => "not-handled",
        ),
      ],
      send,
      broadcastSnapshot: () => undefined,
      publicError: publicRuntimeError,
      onFailure: incidents.noteFailure,
    });
    const socket = Object.assign(new EventEmitter(), { readyState: WebSocket.OPEN }) as unknown as WebSocket;
    const search = (query: string) => clientCommandSchema.parse({
      type: "workspace.search.content",
      requestId: randomUUID(),
      payload: { projectId, query },
    });
    const first = search("need");
    const second = search("needle");
    await Promise.all([
      incidents.run(first, () => execute(socket, first)),
      incidents.run(second, () => execute(socket, second)),
    ]);

    expect(sent.some(({ type }) => type === "request.error")).toBe(false);
    expect(sent).toContainEqual({
      type: "request.result",
      requestId: first.requestId,
      result: { kind: "workspace.search.content", matches: [], truncated: false, cancelled: true },
    });
    expect(sent).toContainEqual({
      type: "request.result",
      requestId: second.requestId,
      result: {
        kind: "workspace.search.content",
        matches: [{ projectPath: "a.ts", line: 1, column: 1, snippet: "needle" }],
        truncated: false,
      },
    });
    expect(incidentSink).not.toHaveBeenCalled();
  });
});
