import type { App, Dialog, MessageBoxOptions } from "electron";
import type { LinuxSingletonContention } from "./linux-singleton-launch.js";

interface LinuxShutdownNoticeOptions {
  platform: NodeJS.Platform;
  automated: boolean;
  version: string;
  showMessageBox(options: MessageBoxOptions): Promise<{ response: number }>;
  retryQuit(): void;
  focusWindow(): void;
  reportError(error: unknown): void;
}

/** Keeps an unconfirmed Linux quit visible without bypassing cleanup authority. */
export class LinuxShutdownNotice {
  private pending: Promise<void> | null = null;

  constructor(private readonly options: LinuxShutdownNoticeOptions) {}

  show(): Promise<void> {
    if (this.options.platform !== "linux" || this.options.automated) {
      return Promise.resolve();
    }
    if (this.pending) return this.pending;
    const pending = Promise.resolve().then(async () => {
      const result = await this.options.showMessageBox({
        type: "warning",
        title: "Inertia is still shutting down",
        message: `Inertia ${this.options.version} could not finish closing.`,
        detail: "The local service has not confirmed that all of its processes stopped. "
          + "Inertia is still running, even if its window is closed, and another version cannot open this workspace yet. "
          + "Retry quit to check cleanup again, or show Inertia to view its status.",
        buttons: ["Retry quit", "Show Inertia"],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      });
      // A retry may immediately report a fresh failure; retire this notice first.
      if (this.pending === pending) this.pending = null;
      if (result.response === 0) this.options.retryQuit();
      else this.options.focusWindow();
    }).catch((error: unknown) => {
      this.options.reportError(error);
    }).finally(() => {
      if (this.pending === pending) this.pending = null;
    });
    this.pending = pending;
    return pending;
  }
}

export function createLinuxLifecycleNotices(
  application: Pick<App, "getVersion" | "whenReady" | "quit">,
  nativeDialog: Pick<Dialog, "showMessageBox">,
  focusWindow: () => void,
) {
  const notice = new LinuxShutdownNotice({
    platform: process.platform,
    automated: process.env.NODE_ENV === "test",
    version: application.getVersion(),
    showMessageBox: async (options) => {
      await application.whenReady();
      return await nativeDialog.showMessageBox(options);
    },
    retryQuit: () => application.quit(), focusWindow,
    reportError: (error) => console.error("Failed to show shutdown status", error),
  });
  return {
    reportUnconfirmedShutdown(): void {
      console.error("Refusing to exit because privileged shutdown could not be confirmed.");
      void notice.show();
    },
    async reportSingletonContention(contention: LinuxSingletonContention): Promise<void> {
      if (process.env.NODE_ENV === "test") return;
      await application.whenReady();
      await nativeDialog.showMessageBox({
        type: "warning",
        title: "Another Inertia instance is still running",
        message: `Inertia ${contention.requestedVersion} did not open.`,
        detail: (contention.runningVersion
          ? `Inertia ${contention.runningVersion} is still using this workspace. `
          : "Another Inertia instance is still using this workspace. ")
          + "Closing its window may not have finished shutting it down. "
          + "Finish quitting the existing instance, then open this AppImage again. "
          + "The running instance and your saved work have been left intact.",
        buttons: ["OK"], noLink: true,
      });
    },
  };
}
