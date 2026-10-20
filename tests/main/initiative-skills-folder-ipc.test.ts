import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { IpcMainInvokeEvent } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  INITIATIVE_SKILLS_FOLDER_OPEN_REFUSAL,
  registerInitiativeSkillsFolderIpc,
} from "../../src/main/initiative-skills-folder-ipc";
import { runtimeConnectionUnavailableError } from "../../src/main/runtime-supervisor-connection";
import type { RunningRuntime } from "../../src/server";
import type { ClientCommand, ServerEvent } from "../../src/shared/contracts";
import type { RuntimePathRequest } from "../../src/shared/desktop";
import { DESKTOP_IPC } from "../../src/shared/desktop-ipc";
import { connectRuntime } from "../support/runtime-event-queue";
import { SecureFileTestBroker } from "../support/secure-file-test-broker";
import { startTestRuntime } from "../support/test-runtime";

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
type CommandWithoutId = ClientCommand extends infer Command
  ? Command extends ClientCommand ? Omit<Command, "requestId"> : never
  : never;

const CHANNEL = DESKTOP_IPC.openInitiativeSkillsFolder;
const UNTRUSTED = "Rejected untrusted renderer request";
const mainWindow = { sender: { id: 1 } } as unknown as IpcMainInvokeEvent;
const detachedWindow = { sender: { id: 2 } } as unknown as IpcMainInvokeEvent;

// The main process admits this channel from the main window only, as
// `DetachedChatMain.assertMainIpc` does for every main-window channel.
function assertMainIpc(event: IpcMainInvokeEvent, argumentCount: number, expectedArguments: number): void {
  if (event !== mainWindow || argumentCount !== expectedArguments) throw new Error(UNTRUSTED);
}

let root: string;
let runtime: RunningRuntime;
let stopClient: () => void;
let command: (value: CommandWithoutId) => Promise<ServerEvent>;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "inertia-skills-folder-ipc-"));
  mkdirSync(join(root, "workspace"));
  runtime = await startTestRuntime({
    dataDirectory: join(root, "data"),
    defaultWorkspacePath: join(root, "workspace"),
    enableProviders: false,
    runtimeGenerationId: "00000000-0000-4000-8000-000000000071:1",
    systemBootId: "test:00000000-0000-4000-8000-000000000071",
    secureFiles: new SecureFileTestBroker(),
  });
  const client = await connectRuntime(runtime.websocketUrl);
  stopClient = () => client.socket.close();
  command = async (value) => {
    const requestId = randomUUID();
    client.socket.send(JSON.stringify({ ...value, requestId }));
    return await client.events.nextForRequest(
      requestId,
      (event): event is Extract<ServerEvent, { type: "request.ok" }> => event.type === "request.ok",
      Date.now() + 10_000,
    );
  };
}, 60_000);

afterEach(async () => {
  stopClient();
  await runtime.close();
  rmSync(root, { recursive: true, force: true });
});

function register(resolveProjectPath: (request: RuntimePathRequest) => Promise<string>) {
  const handlers = new Map<string, Handler>();
  const openPath = vi.fn(async (_path: string) => "");
  let available = true;
  registerInitiativeSkillsFolderIpc({
    ipcMain: { handle: (channel: string, handler: Handler) => { handlers.set(channel, handler); } } as never,
    channel: CHANNEL,
    assertTrusted: assertMainIpc,
    runtime: () => available ? { resolveProjectPath } : null,
    openPath,
  });
  const invoke = async (event: IpcMainInvokeEvent, ...args: unknown[]) => await handlers.get(CHANNEL)!(event, ...args);
  return { invoke, openPath, stop: () => { available = false; } };
}

async function initiativeWithFolder(skillsFolder: boolean): Promise<string> {
  const id = randomUUID();
  expect(await command({ type: "initiative.create", payload: { id, name: "Checkout" } }))
    .toMatchObject({ type: "request.ok" });
  if (skillsFolder) {
    expect(await command({
      type: "initiative.update",
      payload: { id, expectedRevision: 1, preferences: { skillsFolder: true } },
    })).toMatchObject({ type: "request.ok" });
  }
  return id;
}

/** Replaces a folder with a link to a copy of it elsewhere. */
function swapForLink(path: string): void {
  const elsewhere = join(root, `elsewhere-${randomUUID()}`);
  cpSync(path, elsewhere, { recursive: true });
  renameSync(path, `${path}-moved`);
  symlinkSync(elsewhere, path, process.platform === "win32" ? "junction" : "dir");
}

describe("opening an initiative's skills folder", () => {
  it("opens the folder the runtime created and contained", async () => {
    const initiativeId = await initiativeWithFolder(true);
    const { invoke, openPath } = register((request) => runtime.resolveProjectPath(request));
    await expect(invoke(mainWindow, initiativeId)).resolves.toBeUndefined();
    expect(openPath).toHaveBeenCalledOnce();
    expect(openPath.mock.calls[0]![0]).toMatch(/[\\/]\.claude[\\/]skills$/u);
  }, 60_000);

  it("refuses a detached window, a malformed id and an unknown initiative without opening anything", async () => {
    const initiativeId = await initiativeWithFolder(true);
    const resolve = vi.fn((request: RuntimePathRequest) => runtime.resolveProjectPath(request));
    const { invoke, openPath } = register(resolve);
    await expect(invoke(detachedWindow, initiativeId)).rejects.toThrow(UNTRUSTED);
    await expect(invoke(mainWindow, initiativeId, "extra")).rejects.toThrow(UNTRUSTED);
    for (const malformed of ["../skills", "/tmp", "", null, { initiativeId }, 7]) {
      await expect(invoke(mainWindow, malformed)).rejects.toThrow("Invalid initiative skills folder request");
    }
    expect(resolve).not.toHaveBeenCalled();
    await expect(invoke(mainWindow, randomUUID())).rejects.toThrow("That initiative no longer exists.");
    expect(openPath).not.toHaveBeenCalled();
  }, 60_000);

  it("refuses while the folder is turned off, and when the runtime is unavailable or in recovery safety mode", async () => {
    const initiativeId = await initiativeWithFolder(false);
    const { invoke, openPath, stop } = register((request) => runtime.resolveProjectPath(request));
    await expect(invoke(mainWindow, initiativeId)).rejects.toThrow("Turn on the skills folder for this initiative first.");

    // Recovery safety mode blocks the runtime; the supervisor refuses every
    // path request with the blocker's reason before the runtime is asked.
    const blocked = register(async () => {
      throw runtimeConnectionUnavailableError("stopped", "prior-runtime-cleanup-unconfirmed");
    });
    await expect(blocked.invoke(mainWindow, initiativeId))
      .rejects.toThrow("Runtime startup is blocked because prior process cleanup remains unconfirmed.");
    stop();
    await expect(invoke(mainWindow, initiativeId)).rejects.toThrow("The local runtime is not available");
    expect(openPath).not.toHaveBeenCalled();
    expect(blocked.openPath).not.toHaveBeenCalled();
  }, 60_000);

  it.each([
    ["the folder itself", (path: string) => path],
    ["a folder above it", (path: string) => dirname(dirname(dirname(path)))],
  ])("refuses a link swapped in at %s after the runtime checked it", async (_label, target) => {
    const initiativeId = await initiativeWithFolder(true);
    const { invoke, openPath } = register(async (request) => {
      const path = await runtime.resolveProjectPath(request);
      swapForLink(target(path));
      return path;
    });
    await expect(invoke(mainWindow, initiativeId)).rejects.toThrow(INITIATIVE_SKILLS_FOLDER_OPEN_REFUSAL);
    expect(openPath).not.toHaveBeenCalled();
  }, 60_000);
});
