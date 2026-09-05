import { mkdirSync } from "node:fs";
import { app, BrowserWindow, dialog, type MessageBoxOptions } from "electron";

import { promptForLiveModernDarwinRuntimeRecovery } from
  "../../../src/main/runtime-bootstrap-recovery";
import { RuntimeGenerationLeaseJournal } from
  "../../../src/node/runtime-generation-leases";
import { RuntimeOwnedProcessJournal } from
  "../../../src/node/runtime-owned-process-journal";
import { ModernDarwinRecoveryAuthorityJournal } from
  "../../../src/node/runtime-modern-recovery-authorities";

export interface RecoveryFixture {
  start(): void;
  cancel(): void;
  closeParent(): void;
  snapshot(): {
    parented: boolean; pending: boolean; completed: boolean; authorized: boolean;
    ticks: number; claims: number | null; authority: boolean; cancelId: number | undefined;
    title: string | undefined;
  };
}

// This fixture never starts a runtime or child process. Its one synthetic
// pending claim exercises the real recovery preparation and refusal path.
const dataDirectory = process.argv.at(-3)!;
const guardianPath = process.argv.at(-2)!;
const mode = process.argv.at(-1)!;
const bootId = "test:00000000-0000-4000-8000-000000000001";
const generationId = "30000000-0000-4000-8000-000000000003:4";
mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
const leases = new RuntimeGenerationLeaseJournal(dataDirectory);
const owned = new RuntimeOwnedProcessJournal(dataDirectory, {
  platform: "darwin",
  // The malformed variant lacks the required Darwin admission boundary and
  // must receive the locked error sheet rather than a recovery decision.
  ...(mode === "candidate" ? { darwinGuardianPath: guardianPath } : {}),
});
if (!leases.publish(generationId, bootId) || !owned.startSession(generationId, bootId)) {
  throw new Error("The isolated recovery fixture could not establish its journal.");
}
owned.begin(generationId, bootId, owned.sessionCapability(generationId, bootId)!);
const nativeMessageBox = dialog.showMessageBox.bind(dialog);
const cancellation = new AbortController();
let parented = false;
let pending = false;
let completed = false;
let authorized = false;
let ticks = 0;
let title: string | undefined;
let cancelId: number | undefined;
let clock: ReturnType<typeof setInterval> | null = null;

Reflect.set(dialog, "showMessageBox", (
  windowOrOptions: BrowserWindow | MessageBoxOptions,
  options?: MessageBoxOptions,
) => {
  parented = windowOrOptions instanceof BrowserWindow;
  const nativeOptions = options ?? windowOrOptions as MessageBoxOptions;
  title = nativeOptions.title;
  cancelId = nativeOptions.cancelId;
  // Drive a native cancel without automating user consent or replacing the
  // native message box. Retain the production close signal and all options.
  const signal = nativeOptions.signal
    ? AbortSignal.any([nativeOptions.signal, cancellation.signal])
    : cancellation.signal;
  pending = true;
  return parented
    ? nativeMessageBox(windowOrOptions as BrowserWindow, { ...nativeOptions, signal })
    : nativeMessageBox({ ...nativeOptions, signal });
});

void app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 540, height: 320 });
  const controls: RecoveryFixture = {
    start: () => {
      clock = setInterval(() => { ticks += 1; }, 25);
      void promptForLiveModernDarwinRuntimeRecovery(
        dataDirectory, bootId, guardianPath, window,
      ).then((authority) => {
        authorized = authority !== null;
        completed = true;
      });
    },
    snapshot: () => ({
      parented, pending, completed, authorized, ticks, title, cancelId,
      claims: owned.records(generationId)?.length ?? null,
      authority: new ModernDarwinRecoveryAuthorityJournal(dataDirectory).pending() !== null,
    }),
    cancel: () => cancellation.abort(),
    closeParent: () => window.destroy(),
  };
  Reflect.set(globalThis, "recoveryTest", controls);
  await window.loadURL("data:text/html,<h1>Isolated live recovery test</h1>");
});
app.on("before-quit", () => { if (clock) clearInterval(clock); });
// Keep the test main process available for the post-window-close assertions.
app.on("window-all-closed", () => undefined);
