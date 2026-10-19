import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import type { LaunchProjectRequest } from "../shared/desktop.js";

export const NEW_CHAT_FLAG = "--new-chat";
export const FOREGROUND_FLAG = "--foreground";
export const DETACHED_LAUNCH_ENVIRONMENT = "INERTIA_DETACHED_LAUNCH";

export function newChatLaunchRequest(
  argv: readonly string[],
  workingDirectory: string,
): LaunchProjectRequest | null {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    let target: string;
    if (argument === NEW_CHAT_FLAG) {
      const next = argv[index + 1];
      target = next !== undefined && next !== "" && !next.startsWith("-") ? next : ".";
    } else if (argument.startsWith(`${NEW_CHAT_FLAG}=`)) {
      target = argument.slice(NEW_CHAT_FLAG.length + 1) || ".";
    } else {
      continue;
    }
    const path = resolve(workingDirectory, target);
    let realPath: string | null;
    try {
      realPath = realpathSync(path);
    } catch {
      realPath = null;
    }
    return { path, realPath };
  }
  return null;
}

export interface DetachedRelaunch {
  command: string;
  args: string[];
}

export function detachedRelaunchPlan(options: {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  attachedToTerminal: boolean;
  argv: readonly string[];
  execPath: string;
  environment: NodeJS.ProcessEnv;
}): DetachedRelaunch | null {
  if (!options.isPackaged || !options.attachedToTerminal) return null;
  if (options.platform !== "linux" && options.platform !== "darwin") return null;
  if (options.environment[DETACHED_LAUNCH_ENVIRONMENT] === "1") return null;
  if (Object.keys(options.environment).some((key) => key.startsWith("INERTIA_APP_UPDATE_"))) return null;
  const args = options.argv.slice(1);
  if (args.includes(FOREGROUND_FLAG)) return null;
  const appImage = options.platform === "linux" ? options.environment.APPIMAGE : undefined;
  if (appImage && !/\/\.mount_[^/]+\//u.test(options.execPath)) return null;
  return appImage
    ? { command: appImage, args: args.filter((argument) => argument !== "--no-sandbox") }
    : { command: options.execPath, args };
}

export function relaunchDetached(
  plan: DetachedRelaunch,
  environment: NodeJS.ProcessEnv,
  workingDirectory: string,
): Promise<boolean> {
  return new Promise((settle) => {
    try {
      const child = spawn(plan.command, plan.args, {
        cwd: workingDirectory,
        detached: true,
        shell: false,
        stdio: "ignore",
        env: { ...environment, [DETACHED_LAUNCH_ENVIRONMENT]: "1" },
      });
      child.once("error", () => settle(false));
      child.once("spawn", () => {
        child.unref();
        settle(true);
      });
    } catch {
      settle(false);
    }
  });
}

export class LaunchRequestQueue {
  private pending: LaunchProjectRequest[] = [];

  constructor(private readonly notify: () => void) {}

  add(request: LaunchProjectRequest | null): void {
    if (!request) return;
    this.pending = [...this.pending.filter(({ path }) => path !== request.path), request].slice(-4);
    this.notify();
  }

  take(): LaunchProjectRequest[] {
    const taken = this.pending;
    this.pending = [];
    return taken;
  }
}
