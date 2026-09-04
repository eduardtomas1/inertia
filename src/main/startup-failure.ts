export interface StartupFailureDependencies {
  environment: NodeJS.ProcessEnv;
  recordDiagnostic(message: string): void;
  logFailure(error: unknown): void;
  showErrorBox(title: string, content: string): void;
  quit(): void;
}

const STARTUP_FAILURE_TITLE = "Inertia could not start";
const STARTUP_FAILURE_CONTENT =
  "The local workspace runtime failed to start. Please reopen Inertia and try again.";
const STARTUP_FAILURE_DIAGNOSTIC = "Inertia could not start.";

function bestEffort(action: () => void): void {
  try {
    action();
  } catch {
    // Startup is already unrecoverable. A secondary reporting failure must not
    // prevent the remaining diagnostics or the mandatory application shutdown.
  }
}

/**
 * Complete a failed desktop startup without allowing automated Electron runs to
 * create native dialogs that outlive the failed fixture. Test runs retain the
 * same diagnostics, console reporting, and quit path as production.
 */
export function handleStartupFailure(
  error: unknown,
  dependencies: StartupFailureDependencies,
): void {
  bestEffort(() => dependencies.recordDiagnostic(
    error instanceof Error ? error.message : STARTUP_FAILURE_DIAGNOSTIC,
  ));
  bestEffort(() => dependencies.logFailure(error));
  if (dependencies.environment.NODE_ENV !== "test") {
    bestEffort(() => dependencies.showErrorBox(
      STARTUP_FAILURE_TITLE,
      STARTUP_FAILURE_CONTENT,
    ));
  }
  dependencies.quit();
}
