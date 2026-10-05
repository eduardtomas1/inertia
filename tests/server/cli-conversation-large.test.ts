// @inertia-test-suite portable
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CliConversationDiscovery, localAbsolutePath } from "../../src/server/cli-import/discovery";
import { CliTranscriptDeadline, readCliLines } from "../../src/server/cli-import/line-reader";
import { parseCliTranscript } from "../../src/server/cli-import/transcript";
import { RuntimeStore } from "../../src/server/database";
import { buildResponseTimeline } from "../../src/renderer/src/utils/responseTimeline";
import { CLI_IMPORT_MAX_MESSAGES, CLI_IMPORT_MAX_TEXT } from "../../src/shared/cli-conversations";
import { continuationIdentityForSelection, providerNativeModelSelection } from "../../src/shared/model-routing";

const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
const unowned = () => ({ importedConversationId: null, omission: null, owned: false });
const message = (role: string, text: string) => JSON.stringify({ type: "response_item", timestamp: "2026-09-25T10:00:00.000Z", payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] } });
const toolOutput = (bytes: number) => JSON.stringify({ type: "response_item", payload: { type: "function_call_output", output: "o".repeat(bytes) } });

async function largeRollout(turns: number, outputBytes: number) {
  const root = await mkdtemp(join(tmpdir(), "inertia-cli-large-")); directories.push(root);
  const workspace = join(root, "project"); const sessions = join(root, "sessions");
  await Promise.all([mkdir(workspace), mkdir(sessions)]);
  const sessionId = randomUUID();
  const lines = [JSON.stringify({ type: "session_meta", payload: { id: sessionId, cwd: workspace, model_provider: "openai" } }), message("user", "Opening request"), message("assistant", "Opening reply")];
  for (let index = 0; index < turns; index += 1) lines.push(message("user", `Request ${index}`), toolOutput(outputBytes), message("assistant", `Reply ${index}`));
  await writeFile(join(sessions, `rollout-${sessionId}.jsonl`), lines.join("\n") + "\n");
  return { workspace, sessions, sessionId };
}

describe("CLI transcripts larger than the old 16 MiB file bound", () => {
  it("lists and reads a large rollout, keeping the opening exchange and the newest messages", async () => {
    const f = await largeRollout(600, 32 * 1024);
    const discovery = new CliConversationDiscovery([{ providerId: "codex", path: f.sessions }], []);
    const scan = await discovery.scan("project", f.workspace, unowned);
    expect(scan).toMatchObject({ skipped: 0, candidates: [{ title: "Opening request", opening: { user: "Opening request", assistant: "Opening reply" } }] });
    const read = await discovery.read("project", f.workspace, scan.candidates[0]!.id);
    const contents = read.transcript.messages.map(({ content }) => content);
    expect(contents.slice(0, 2)).toEqual(["Opening request", "Opening reply"]);
    expect(contents.at(-1)).toBe("Reply 599");
    expect(contents).toHaveLength(200);
    expect(read.transcript.omittedMessages).toBe(1202 - 200);
    expect(read.transcript.omittedBytes).toBeGreaterThan(0);
  });

  it("drops and counts records over the per-line bound, keeps split UTF-8 intact and leaves an unterminated last line to the parser", async () => {
    const root = await mkdtemp(join(tmpdir(), "inertia-cli-lines-")); directories.push(root);
    const path = join(root, "lines.jsonl");
    const split = "x".repeat(1024 * 1024 - 1) + "é";
    await writeFile(path, ["short", "y".repeat(5000), split, "after", "tail"].join("\n"));
    const handle = await open(path, "r");
    try {
      const size = (await handle.stat()).size;
      const lines: Array<[number, boolean]> = [];
      const read = await readCliLines(handle, { size, deadline: Date.now() + 60_000, maxLineBytes: 2 * 1024 * 1024 - 5000, onLine: (line, terminated) => { lines.push([line.length, terminated]); } });
      expect(read).toMatchObject({ bytes: size, droppedRecords: 0, complete: true });
      expect(lines).toEqual([[5, true], [5000, true], [split.length, true], [5, true], [4, false]]);
      const bounded: string[] = [];
      expect(await readCliLines(handle, { size, deadline: Date.now() + 60_000, maxLineBytes: 4096, onLine: (line) => { bounded.push(line); } })).toMatchObject({ droppedRecords: 2, complete: true });
      expect(bounded).toEqual(["short", "after", "tail"]);
      await expect(readCliLines(handle, { size, deadline: Date.now() - 1, onLine: () => undefined })).rejects.toBeInstanceOf(CliTranscriptDeadline);
      const controller = new AbortController(); controller.abort();
      await expect(readCliLines(handle, { size, deadline: Date.now() + 60_000, signal: controller.signal, onLine: () => undefined })).rejects.toThrow();
    } finally { await handle.close(); }
  });

  it("keeps the opening exchange and the newest messages within the import budget and counts what it leaves out", () => {
    const meta = JSON.stringify({ type: "session_meta", payload: { id: randomUUID(), cwd: "/workspace", model_provider: "openai" } });
    const lines = [meta, message("user", "Opening request"), message("assistant", "Opening reply")];
    for (let index = 0; index < 400; index += 1) lines.push(message("user", `Request ${index} ${"r".repeat(2000)}`), message("assistant", `Reply ${index}`));
    lines.push(JSON.stringify({ type: "event_msg", payload: { type: "thread_rolled_back", num_turns: 2 } }), message("user", "After rollback"));
    const result = parseCliTranscript(lines.join("\n"), "codex", "2026-09-25T10:00:00.000Z");
    const contents = result.messages.map(({ content }) => content);
    const bytes = result.messages.reduce((total, entry) => total + Buffer.byteLength(entry.content), 0);
    expect(contents.slice(0, 2)).toEqual(["Opening request", "Opening reply"]);
    expect(contents.at(-1)).toBe("After rollback");
    expect(contents).not.toContain("Reply 399");
    expect(contents.at(-2)).toBe("Reply 397");
    expect(result.messages.length).toBeLessThanOrEqual(CLI_IMPORT_MAX_MESSAGES);
    expect(bytes).toBeLessThanOrEqual(CLI_IMPORT_MAX_TEXT);
    const total = 2 + 398 * 2 + 1;
    expect(result.omittedMessages).toBe(total - result.messages.length);
    const all = 15 + 13 + 398 * 13 + [...Array(398).keys()].reduce((sum, index) => sum + Buffer.byteLength(`Request ${index} `) + 2000 + Buffer.byteLength(`Reply ${index}`) - 13, 0) + 14;
    expect(result.omittedBytes).toBe(all - bytes);
  });

  it("follows Claude's final branch when the middle of a long session is not kept", () => {
    const sessionId = randomUUID();
    const record = (uuid: string, parentUuid: string | null, type: string, text: string) => JSON.stringify({ uuid, parentUuid, type, sessionId, cwd: "/workspace", timestamp: "2026-09-25T10:00:00.000Z", message: { role: type, content: text } });
    const lines = [record("u0", null, "user", "Abandoned opening"), record("u1", null, "user", "Opening request"), record("a1", "u1", "assistant", "Opening reply")];
    let parent = "a1";
    for (let index = 0; index < 300; index += 1) {
      lines.push(record(`q${index}`, parent, "user", `Request ${index}`), record(`r${index}`, `q${index}`, "assistant", `Reply ${index}`));
      if (index === 250) lines.push(record("dead", `r${index}`, "user", "Abandoned branch"));
      parent = `r${index}`;
    }
    const result = parseCliTranscript(lines.join("\n"), "claude", "2026-09-25T10:00:00.000Z");
    const contents = result.messages.map(({ content }) => content);
    expect(result.title).toBe("Opening request");
    expect(contents.slice(0, 2)).toEqual(["Opening request", "Opening reply"]);
    expect(contents).not.toContain("Abandoned branch");
    expect(contents.at(-1)).toBe("Reply 299");
    expect(result.omittedMessages).toBe(602 - contents.length);
  });

  it("drops a record over the per-line bound, counts it, and fails a read past its deadline closed", async () => {
    const f = await largeRollout(3, 64 * 1024);
    const discovery = new CliConversationDiscovery([{ providerId: "codex", path: f.sessions }], [], undefined, { recordBytes: 32 * 1024 });
    const scan = await discovery.scan("project", f.workspace, unowned);
    const read = await discovery.read("project", f.workspace, scan.candidates[0]!.id);
    expect(read.droppedRecords).toBe(3);
    expect(read.transcript.messages.map(({ content }) => content)).toEqual(["Opening request", "Opening reply", "Request 0", "Reply 0", "Request 1", "Reply 1", "Request 2", "Reply 2"]);
    const slow = new CliConversationDiscovery([{ providerId: "codex", path: f.sessions }], [], undefined, { readMilliseconds: -1 });
    await expect(slow.scan("project", f.workspace, unowned)).resolves.toMatchObject({ candidates: [], skipped: 1 });
    const timed = new CliConversationDiscovery([{ providerId: "codex", path: f.sessions }], []);
    const listed = await timed.scan("project", f.workspace, unowned);
    Reflect.set(Reflect.get(timed, "limits") as object, "readMilliseconds", -1);
    await expect(timed.read("project", f.workspace, listed.candidates[0]!.id)).rejects.toThrow(/took longer than/u);
  });

  it("records what an import left out on its receipt and as one note after the opening exchange", async () => {
    const f = await largeRollout(600, 64);
    const discovery = new CliConversationDiscovery([{ providerId: "codex", path: f.sessions }], []);
    const scan = await discovery.scan("project", f.workspace, unowned);
    const read = await discovery.read("project", f.workspace, scan.candidates[0]!.id);
    const store = new RuntimeStore(join(f.workspace, "..", "inertia.sqlite"), f.workspace);
    try {
      const project = store.createProject("Studio", f.workspace);
      const selection = providerNativeModelSelection({ providerId: "codex" });
      const conversationId = store.importCliConversation({
        projectId: project.id, sourceKey: "f".repeat(64), providerId: "codex", sessionId: read.transcript.sessionId, cwd: read.transcript.cwd, title: read.transcript.title,
        messages: read.transcript.messages, omittedMessages: read.transcript.omittedMessages, omittedBytes: read.transcript.omittedBytes, droppedRecords: read.droppedRecords, continuation: "native",
        selection, continuationIdentity: continuationIdentityForSelection(selection, "native-fixture"),
      });
      expect(store.cliSessionOwnership("codex", read.transcript.sessionId)).toEqual({ importedConversationId: conversationId, omission: { omitted: 1002, total: 1202 }, owned: false });
      const detail = store.conversationDetail(conversationId)!;
      const notes = detail.messages.filter(({ role }) => role === "system");
      expect(notes.map(({ content, turnId }) => [content, turnId])).toEqual([["Earlier messages were not imported: 1,002 of 1,202", detail.agentTurns[0]!.id]]);
      const timeline = buildResponseTimeline({ turns: detail.agentTurns, messages: detail.messages, activities: detail.activities, reasonings: detail.reasonings, plans: detail.plans, checkpoints: detail.checkpoints });
      expect(timeline.every(({ kind }) => kind === "turn")).toBe(true);
      const first = timeline[0]!;
      expect(first.kind === "turn" ? first.turn.systemMessages.map(({ content }) => content) : []).toEqual(["Earlier messages were not imported: 1,002 of 1,202"]);
      const again = await discovery.scan("project", f.workspace, (provider, sessionId) => store.cliSessionOwnership(provider, sessionId));
      expect(again.candidates[0]).toMatchObject({ importedConversationId: conversationId, importedOmission: { omitted: 1002, total: 1202 } });
    } finally { store.close(); }
  });

  it("lists a resumed Claude transcript by its newest session even when the copied earlier session is already owned", async () => {
    const root = await mkdtemp(join(tmpdir(), "inertia-cli-resumed-")); directories.push(root);
    const workspace = join(root, "project"); const projects = join(root, "projects");
    await Promise.all([mkdir(workspace), mkdir(join(projects, "project"), { recursive: true })]);
    const earlier = randomUUID(); const resumed = randomUUID();
    const record = (uuid: string, parentUuid: string | null, type: string, sessionId: string, text: string) => JSON.stringify({ uuid, parentUuid, type, sessionId, cwd: workspace, timestamp: "2026-09-25T10:00:00.000Z", message: { role: type, content: text } });
    await writeFile(join(projects, "project", `${resumed}.jsonl`), [record("u1", null, "user", earlier, "Earlier request"), record("a1", "u1", "assistant", earlier, "Earlier reply"),
      record("u2", "a1", "user", resumed, "Resumed request"), record("a2", "u2", "assistant", resumed, "Resumed reply")].join("\n") + "\n");
    const discovery = new CliConversationDiscovery([{ providerId: "claude", path: projects }], []);
    const scan = await discovery.scan("project", workspace, (_provider, sessionId) => ({ importedConversationId: null, omission: null, owned: sessionId === earlier }));
    expect(scan.candidates).toHaveLength(1);
    expect((await discovery.read("project", workspace, scan.candidates[0]!.id)).transcript.sessionId).toBe(resumed);
  });

  it("reads a large transcript in full when its first request lies beyond the scanned prefix", async () => {
    const root = await mkdtemp(join(tmpdir(), "inertia-cli-prefix-")); directories.push(root);
    const workspace = join(root, "project"); const sessions = join(root, "sessions");
    await Promise.all([mkdir(workspace), mkdir(sessions)]);
    const id = randomUUID();
    await writeFile(join(sessions, `rollout-${id}.jsonl`), [JSON.stringify({ type: "session_meta", payload: { id, cwd: workspace, model_provider: "openai" } }), toolOutput(4096),
      message("user", "Late request"), message("assistant", "Late reply")].join("\n") + "\n");
    const discovery = new CliConversationDiscovery([{ providerId: "codex", path: sessions }], [], undefined, { fullReadBytes: 1024, prefixBytes: 2048 });
    expect(await discovery.scan("project", workspace, unowned)).toMatchObject({ skipped: 0, candidates: [{ title: "Late request", opening: { user: "Late request", assistant: "Late reply" } }] });
  });
  it("refuses network-share workspace paths before resolving them", () => {
    for (const path of ["\\\\host\\share\\project", "//host/share/project", "relative/project", "/workspace/\0project"]) expect(localAbsolutePath(path)).toBe(false);
    expect(localAbsolutePath(join(tmpdir(), "project"))).toBe(true);
  });
});
