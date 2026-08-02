import {
  _electron as electron,
  type Page,
} from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WebSocketServer } from "ws";

import { forceKillRuntimeProcessTree } from "../../../src/main/runtime-process-tree";

const GRACEFUL_CLOSE_TIMEOUT_MS = 2_000;
const FORCE_KILL_TIMEOUT_MS = 4_000;

type ElectronApp = Awaited<ReturnType<typeof electron.launch>>;
type ElectronProcess = ReturnType<ElectronApp["process"]>;

export interface RemoteBrowserElectronFixture {
  electronApp: ElectronApp;
  page: Page;
  close(): Promise<void>;
}

interface LaunchRemoteBrowserOptions {
  staticUrl: string;
  profilePrefix?: string;
  ready?(page: Page): Promise<void>;
  closeApp?(app: ElectronApp): Promise<void>;
}

export async function launchRemoteBrowser({
  staticUrl,
  profilePrefix = "inertia-remote-e2e-",
  ready,
  closeApp = async (app) => await app.close(),
}: LaunchRemoteBrowserOptions): Promise<RemoteBrowserElectronFixture> {
  const userDataDir = await mkdtemp(join(tmpdir(), profilePrefix));
  let electronApp: ElectronApp | null = null;
  try {
    electronApp = await electron.launch({
      args: [
        resolve("tests/fixtures/remote-browser-electron.cjs"),
        staticUrl,
        `--user-data-dir=${userDataDir}`,
      ],
    });
    const ownedApp = electronApp;
    const page = await ownedApp.firstWindow();
    await ready?.(page);
    return {
      electronApp: ownedApp,
      page,
      close: async () => await cleanupOwnedApp(
        ownedApp,
        userDataDir,
        closeApp,
      ),
    };
  } catch (error) {
    try {
      if (electronApp) {
        await cleanupOwnedApp(electronApp, userDataDir, closeApp);
      } else {
        await removeProfile(userDataDir);
      }
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Remote browser fixture launch and cleanup failed.",
      );
    }
    throw error;
  }
}

export async function closeRemoteBrowserRelayResources(
  browser: Pick<RemoteBrowserElectronFixture, "close"> | null,
  relay: WebSocketServer,
): Promise<void> {
  const errors: unknown[] = [];
  try {
    await browser?.close();
  } catch (error) {
    errors.push(error);
  }
  try {
    await closeRelay(relay);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      "Remote browser fixture resource cleanup failed.",
    );
  }
}

async function cleanupOwnedApp(
  app: ElectronApp,
  userDataDir: string,
  closeApp: (app: ElectronApp) => Promise<void>,
): Promise<void> {
  const child = app.process();
  try {
    await withTimeout(
      closeApp(app),
      GRACEFUL_CLOSE_TIMEOUT_MS,
      "Remote browser fixture close timed out.",
    );
    if (!await waitForRootExit(
      child,
      Date.now() + GRACEFUL_CLOSE_TIMEOUT_MS,
    )) {
      throw new Error("Remote browser fixture root did not exit after close.");
    }
    await removeProfile(userDataDir);
    return;
  } catch (closeError) {
    const errors: unknown[] = [closeError];
    const deadlineAt = Date.now() + FORCE_KILL_TIMEOUT_MS;
    let treeConfirmed = false;
    const pid = child.pid;
    if (typeof pid !== "number") {
      errors.push(new Error(
        "Remote browser fixture root PID was unavailable for forced cleanup.",
      ));
    } else {
      try {
        treeConfirmed = await forceKillRuntimeProcessTree(pid, {
          deadlineAt,
        });
      } catch (error) {
        errors.push(error);
      }
    }
    if (!treeConfirmed) {
      errors.push(new Error(
        "Remote browser fixture process-tree cleanup was not confirmed.",
      ));
    }
    const rootExited = await waitForRootExit(child, deadlineAt);
    if (!rootExited) {
      errors.push(new Error(
        "Remote browser fixture root remained alive after forced cleanup.",
      ));
    } else {
      try {
        await removeProfile(userDataDir);
      } catch (error) {
        errors.push(error);
      }
    }
    throw new AggregateError(
      errors,
      "Remote browser fixture cleanup failed.",
    );
  }
}

async function closeRelay(relay: WebSocketServer): Promise<void> {
  const errors: unknown[] = [];
  for (const client of relay.clients) {
    try {
      client.terminate();
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    await withTimeout(
      new Promise<void>((resolveClose, rejectClose) => {
        relay.close((error) => {
          if (error) rejectClose(error);
          else resolveClose();
        });
      }),
      GRACEFUL_CLOSE_TIMEOUT_MS,
      "Remote browser fixture relay close timed out.",
    );
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      "Remote browser fixture relay cleanup failed.",
    );
  }
}

async function waitForRootExit(
  child: ElectronProcess,
  deadlineAt: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  const remainingMs = Math.trunc(deadlineAt - Date.now());
  if (remainingMs <= 0) return false;
  return await new Promise<boolean>((resolveExit) => {
    let settled = false;
    const finish = (exited: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      resolveExit(exited);
    };
    const onExit = (): void => finish(true);
    const timer = setTimeout(() => finish(false), remainingMs);
    child.once("exit", onExit);
    if (child.exitCode !== null || child.signalCode !== null) finish(true);
  });
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function removeProfile(path: string): Promise<void> {
  await rm(path, {
    recursive: true,
    force: true,
    ...(process.platform === "win32" ? { maxRetries: 8, retryDelay: 100 } : {}),
  });
}
