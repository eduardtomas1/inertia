import xa11y from "@crowecawcaw/xa11y";
import ffi from "ffi-rs";
import { isAbsolute } from "node:path";

import { appControlFailure, type AppControlResult } from "../node/runtime-app-control-protocol.js";
import { captureMaskedWindow } from "./app-control-capture.js";
import {
  AppControlNative,
  nativeFailure,
  type AppControlScope,
  type NativeModule,
} from "./app-control-native.js";
import { AppControlTreeTooLargeError, type AppControlProcessEntry } from "./app-control-process-tree.js";
import { MacProcessFacts } from "./app-control-macos-process.js";
import { uipiBlocks, WindowsProcessFacts } from "./app-control-windows.js";
import { macWindowPixels, stopMacWindowCaptures } from "./snapshot-macos-window.js";
import type { AppControlWorkerRequest, AppControlWorkerResponse } from "./app-control-worker-protocol.js";

/**
 * "Inertia App Control": the main-owned utility process that loads the native
 * accessibility binding. Main sends one command at a time with the launch's
 * owned process tree; a hang or crash here never reaches main or the runtime.
 */

const { App, screenshot, setDefaultTimeout } = xa11y;
const native: NativeModule = {
  App: {
    list: async () => await App.list(),
    byPid: async (pid) => {
      try {
        return await App.byPid(pid, { timeout: 0 });
      } catch (error) {
        // Permission and bus failures are gates; any other failure means no
        // accessibility application for that pid, which most processes of a tree have.
        if (error instanceof xa11y.PermissionDeniedError || error instanceof xa11y.AccessibilityNotEnabledError) throw error;
        return null;
      }
    },
  },
  errors: {
    PermissionDeniedError: xa11y.PermissionDeniedError,
    AccessibilityNotEnabledError: xa11y.AccessibilityNotEnabledError,
    SelectorNotMatchedError: xa11y.SelectorNotMatchedError,
    ActionNotSupportedError: xa11y.ActionNotSupportedError,
    InvalidActionDataError: xa11y.InvalidActionDataError,
  },
};
const windowsFacts = process.platform === "win32" ? new WindowsProcessFacts(ffi) : null;
const macFacts = process.platform === "darwin" ? new MacProcessFacts(ffi) : null;
let ownIntegrity: number | null | undefined;

function elevated(pid: number): boolean {
  if (!windowsFacts) return false;
  try {
    ownIntegrity ??= windowsFacts.integrityRid("self");
    return uipiBlocks(windowsFacts.integrityRid(pid), ownIntegrity);
  } catch {
    return false;
  }
}

const control = new AppControlNative(native, { elevated, platform: process.platform });

function tree(rootPid: number): AppControlProcessEntry[] {
  if (macFacts) return macFacts.processTree(rootPid);
  if (!windowsFacts) throw new Error("unsupported");
  return windowsFacts.processTree(rootPid);
}

async function run(request: AppControlWorkerRequest): Promise<AppControlWorkerResponse["result"]> {
  const { command } = request;
  if (command.command === "tree") return { ok: true, value: { kind: "tree", entries: tree(command.rootPid) } };
  const scope: AppControlScope = { pids: new Set(request.scope.pids), deniedPids: new Set(request.scope.deniedPids) };
  switch (command.command) {
    case "windows": return { ok: true, value: await control.windows(scope) };
    case "snapshot": return { ok: true, value: await control.snapshot(scope, command.window) };
    case "inspect": return { ok: true, value: await control.inspect(scope, command.window, command.element) };
    case "perform": return {
      ok: true,
      value: await control.perform(scope, command.window, command.element, command.action, command.text, command.expect),
    };
    case "screenshot": {
      const resolved = await control.resolve(scope, command.window);
      const plan = await control.screenshotPlan(resolved);
      const directory = request.captureDirectory;
      const capture = await captureMaskedWindow(
        { pid: resolved.pid, title: resolved.window.name, bounds: plan.bounds },
        plan.masks,
        {
          platform: process.platform,
          env: process.env,
          regionScreenshot: async (region) => await screenshot({ region }),
          ...(process.platform === "darwin" && directory && isAbsolute(directory) ? { macPixels: macWindowPixels(directory) } : {}),
        },
      );
      // A field that filled in while the pixels were taken withholds them.
      await control.screenshotPlan(resolved);
      return {
        ok: true,
        value: {
          kind: "screenshot",
          png: new Uint8Array(capture.png),
          width: capture.width,
          height: capture.height,
          mayIncludeOverlappingWindows: capture.mayIncludeOverlappingWindows,
        },
      };
    }
  }
}

function failureOf(error: unknown): AppControlResult {
  if (error instanceof AppControlTreeTooLargeError) return appControlFailure("unavailable", "tree-too-large");
  const failure = nativeFailure(error, native.errors);
  return appControlFailure(failure.code, failure.reason, failure.dispatched);
}

const parent = process.parentPort;
if (parent) {
  try { setDefaultTimeout(0); } catch { /* Element actions never wait on their own. */ }
  process.on("exit", stopMacWindowCaptures);
  process.once("SIGTERM", () => process.exit(1));
  let queue = Promise.resolve();
  parent.on("message", (event) => {
    const request = event.data as AppControlWorkerRequest;
    if (!request || typeof request !== "object" || !Number.isSafeInteger(request.id)) {
      process.exit(1);
      return;
    }
    queue = queue.then(async () => {
      let result: AppControlWorkerResponse["result"];
      try {
        result = await run(request);
      } catch (error) {
        result = failureOf(error);
      }
      parent.postMessage({ id: request.id, result } satisfies AppControlWorkerResponse);
    });
  });
  parent.postMessage("ready");
}
