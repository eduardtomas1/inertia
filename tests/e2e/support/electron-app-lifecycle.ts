import type { ElectronApplication, Page } from "@playwright/test";

export function observeElectronProcess(
  current: ElectronApplication,
  appendDiagnostic: (source: "stdout" | "stderr", chunk: Buffer) => void,
): void {
  current.process().stdout?.on("data", (chunk: Buffer) => {
    appendDiagnostic("stdout", chunk);
  });
  current.process().stderr?.on("data", (chunk: Buffer) => {
    appendDiagnostic("stderr", chunk);
  });
}

export function observeElectronPage(
  currentPage: Page,
  rendererErrors: string[],
): void {
  currentPage.on("console", (message) => {
    if (message.type() === "error") rendererErrors.push(message.text());
  });
  currentPage.on("pageerror", (error) => rendererErrors.push(error.message));
}

export async function closeElectronAppBounded(
  current: ElectronApplication,
): Promise<void> {
  const child = current.process();
  const closeResult = current.close().then(() => true, () => false);
  let gracefulTimer: ReturnType<typeof setTimeout> | null = null;
  const graceful = await Promise.race([
    closeResult,
    new Promise<boolean>((resolve) => {
      gracefulTimer = setTimeout(() => resolve(false), 5_000);
      gracefulTimer.unref();
    }),
  ]);
  if (gracefulTimer) clearTimeout(gracefulTimer);
  if (graceful) return;
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = await new Promise<boolean>((resolve) => {
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, 5_000);
    timer.unref();
    child.once("exit", onExit);
    if (child.exitCode !== null || child.signalCode !== null) {
      child.off("exit", onExit);
      clearTimeout(timer);
      resolve(true);
    }
  });
  if (!exited) {
    throw new Error("The Electron fixture process did not exit after forced close.");
  }
}
