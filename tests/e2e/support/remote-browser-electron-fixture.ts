import {
  _electron as electron,
  type Page,
} from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export interface RemoteBrowserElectronFixture {
  electronApp: Awaited<ReturnType<typeof electron.launch>>;
  page: Page;
  close(): Promise<void>;
}

interface LaunchRemoteBrowserOptions {
  staticUrl: string;
  profilePrefix?: string;
  ready?(page: Page): Promise<void>;
}

export async function launchRemoteBrowser({
  staticUrl,
  profilePrefix = "inertia-remote-e2e-",
  ready,
}: LaunchRemoteBrowserOptions): Promise<RemoteBrowserElectronFixture> {
  const userDataDir = await mkdtemp(join(tmpdir(), profilePrefix));
  let electronApp: Awaited<ReturnType<typeof electron.launch>> | null = null;
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
      close: async () => {
        try {
          await ownedApp.close();
        } finally {
          await removeProfile(userDataDir);
        }
      },
    };
  } catch (error) {
    try {
      await electronApp?.close();
    } finally {
      await removeProfile(userDataDir);
    }
    throw error;
  }
}

async function removeProfile(path: string): Promise<void> {
  await rm(path, {
    recursive: true,
    force: true,
    ...(process.platform === "win32" ? { maxRetries: 8, retryDelay: 100 } : {}),
  });
}
