import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { IpcMainInvokeEvent } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CustomAgentFileError,
  readCustomAgentExportFile,
  registerCustomAgentFileIpc,
  writeCustomAgentExportFile,
} from "../../src/main/custom-agent-file-main";
import { buildCustomAgentExport, MAX_CUSTOM_AGENT_EXPORT_BYTES, type CustomAgentDraft } from "../../src/shared/custom-agents";
import { DESKTOP_IPC } from "../../src/shared/desktop-ipc";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "inertia-custom-agent-file-"));
  temporaryDirectories.push(path);
  return path;
}

const draft: CustomAgentDraft = {
  name: "Reviewer",
  handle: "reviewer",
  description: "Reads diffs.",
  icon: { kind: "symbol", name: "shield" },
  accent: "blue",
  blocks: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", kind: "role", body: "You review code." }],
  skills: [],
};
const envelope = buildCustomAgentExport([draft], "2026-10-29T10:00:00.000Z");

describe("custom agent export files", () => {
  it("writes atomically with private permissions and reads the envelope back", async () => {
    const folder = await directory();
    const target = join(folder, "agents.json");
    await writeCustomAgentExportFile(target, JSON.stringify(envelope));
    expect(await readdir(folder)).toEqual(["agents.json"]);
    if (process.platform !== "win32") expect((await stat(target)).mode & 0o777).toBe(0o600);
    expect(await readCustomAgentExportFile(target)).toEqual([draft]);
  });

  it("refuses links, oversized content and files that are not exports", async () => {
    const folder = await directory();
    const real = join(folder, "real.json");
    await writeFile(real, JSON.stringify(envelope));
    const link = join(folder, "link.json");
    await symlink(real, link);
    await expect(writeCustomAgentExportFile(link, "{}")).rejects.toThrow(CustomAgentFileError);
    await expect(readCustomAgentExportFile(link)).rejects.toThrow(/not a link/u);
    await expect(writeCustomAgentExportFile(join(folder, "big.json"), "x".repeat(MAX_CUSTOM_AGENT_EXPORT_BYTES + 1))).rejects.toThrow(/larger than/u);
    await expect(writeCustomAgentExportFile("relative.json", "{}")).rejects.toThrow(CustomAgentFileError);
    const bad = join(folder, "bad.json");
    await writeFile(bad, JSON.stringify({ ...envelope, version: 2 }));
    await expect(readCustomAgentExportFile(bad)).rejects.toThrow("That file is not an Inertia custom agents export.");
    await writeFile(bad, "not json");
    await expect(readCustomAgentExportFile(bad)).rejects.toThrow("That file is not an Inertia custom agents export.");
    await writeFile(bad, "");
    await expect(readCustomAgentExportFile(bad)).rejects.toThrow("That file is empty.");
    expect((await readdir(folder)).filter((name) => name.endsWith(".partial"))).toEqual([]);
  });
});

describe("custom agent file IPC", () => {
  async function register(options: { save?: string | null; open?: string | null; trusted?: boolean } = {}) {
    const folder = await directory();
    const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>>();
    const assertTrusted = vi.fn((_event: IpcMainInvokeEvent, received: number, expected = 0) => {
      if (options.trusted === false || received !== expected) throw new Error("Rejected untrusted renderer request");
    });
    const showSaveDialog = vi.fn(async () => ({ canceled: options.save === null, filePath: options.save ?? undefined }));
    const showOpenDialog = vi.fn(async () => ({ canceled: options.open === null, filePaths: options.open ? [options.open] : [] }));
    registerCustomAgentFileIpc({
      ipcMain: { handle: (channel: string, handler: never) => { handlers.set(channel, handler); } } as never,
      assertTrusted,
      window: () => ({ isDestroyed: () => false }) as never,
      dialog: { showSaveDialog, showOpenDialog } as never,
      defaultPath: () => folder,
    });
    const invoke = (...args: unknown[]) => handlers.get(DESKTOP_IPC.customAgentFile)!({} as IpcMainInvokeEvent, ...args);
    return { folder, invoke, showSaveDialog, showOpenDialog };
  }

  it("exports a parsed envelope through the save dialog and imports it through the open dialog", async () => {
    const folder = await directory();
    const target = join(folder, "out.json");
    const exporter = await register({ save: target });
    expect(await exporter.invoke("export", envelope)).toEqual({ status: "exported" });
    expect(exporter.showSaveDialog).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      defaultPath: expect.stringMatching(/inertia-agent-reviewer-\d{4}-\d{2}-\d{2}\.json$/u),
      filters: [{ name: "JSON", extensions: ["json"] }],
    }));
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual(envelope);
    const importer = await register({ open: target });
    expect(await importer.invoke("import")).toEqual({ status: "imported", agents: [draft] });
    expect(await (await register({ save: null })).invoke("export", envelope)).toEqual({ status: "cancelled" });
    expect(await (await register({ open: null })).invoke("import")).toEqual({ status: "cancelled" });
  });

  it("round-trips an agent that wears a mark through an export file", async () => {
    const folder = await directory();
    const target = join(folder, "marked.json");
    const marked: CustomAgentDraft = { ...draft, icon: { kind: "mark", name: "guard" } };
    const markedEnvelope = buildCustomAgentExport([marked], "2026-10-29T10:00:00.000Z");
    expect(await (await register({ save: target })).invoke("export", markedEnvelope)).toEqual({ status: "exported" });
    expect(await readFile(target, "utf8")).toContain('"icon": {\n        "kind": "mark",\n        "name": "guard"\n      }');
    expect(await (await register({ open: target })).invoke("import")).toEqual({ status: "imported", agents: [marked] });
  });

  it("rejects untrusted senders, malformed payloads and unknown actions before any dialog", async () => {
    await expect((await register({ trusted: false })).invoke("import")).rejects.toThrow(/untrusted/u);
    const trusted = await register({ save: "/tmp/never.json" });
    await expect(trusted.invoke("export", { ...envelope, agents: [{ ...draft, handle: "Bad Handle" }] })).rejects.toThrow(/Invalid custom agent export/u);
    await expect(trusted.invoke("export")).rejects.toThrow(/untrusted/u);
    await expect(trusted.invoke("import", "extra")).rejects.toThrow(/untrusted/u);
    await expect(trusted.invoke("delete", "x")).rejects.toThrow(/untrusted|Invalid custom agent file action/u);
    expect(trusted.showSaveDialog).not.toHaveBeenCalled();
    expect(trusted.showOpenDialog).not.toHaveBeenCalled();
  });

  it("reports an unreadable import as a rejection instead of throwing", async () => {
    const folder = await directory();
    const bad = join(folder, "bad.json");
    await writeFile(bad, "{\"format\":\"something-else\"}");
    expect(await (await register({ open: bad })).invoke("import")).toEqual({
      status: "rejected",
      message: "That file is not an Inertia custom agents export.",
    });
  });
});
