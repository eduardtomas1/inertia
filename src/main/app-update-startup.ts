import { existsSync } from "node:fs";

import {
  appUpdateCandidateBootstrapRequest,
  runRestrictedAppUpdateCandidate,
  runRestrictedWindowsAppUpdateCandidate,
  windowsAppUpdateCandidateBootstrapRequest,
  type AppUpdateCandidateAdmission,
  type AppUpdateWindowsCandidateBootstrapRequest,
} from "./app-update-bootstrap.js";
import {
  AppUpdateHandoffJournal,
  appUpdateHandoffOwner,
  type AppUpdateHandoffSnapshot,
} from "./app-update-handoff.js";
import { AppUpdateHandoffTokenVault } from
  "./app-update-handoff-token-vault.js";
import {
  finalizeAppImageUpdate,
  recoverAppImageUpdate,
  recoverAppImageUpdateForHandoff,
  type AppImageHandoffRecoveryExpectation,
} from "./appimage-installed-identity.js";
import { finishNormalShutdownAfterCleanup } from "./privileged-shutdown.js";
import type { InertiaReleaseChannel } from "./release-channel.js";

export interface AppUpdateStartupOptions {
  readonly platform: NodeJS.Platform;
  readonly environment: NodeJS.ProcessEnv;
  readonly channel: InertiaReleaseChannel;
  readonly version: string;
  readonly executablePath: string;
  readonly dataDirectory: string;
  readonly profileDirectory: string;
  readonly application: Pick<
    typeof import("electron")["app"],
    "exit" | "on" | "quit" | "requestSingleInstanceLock" | "whenReady"
  >;
  focusMainWindow(): void;
  updateInstallCoordinator(): { allowBeforeQuit(): boolean } | null;
  recordBeforeQuit(): void;
  cleanupBeforeQuit(): Promise<boolean>;
  finishNormalShutdown(): void;
  onUnconfirmedShutdown(): void;
  reportCleanupFailure(error: unknown): void;
  validateCandidateBootstrap(operationId: string): Promise<void>;
  bootstrap(): Promise<void>;
  awaitCandidateReadiness(): Promise<void>;
  cleanupFailedCandidate(): Promise<boolean>;
  reportCandidateFailure(message: string, error: unknown): void;
}

function registerApplicationLifecycle(options: AppUpdateStartupOptions): void {
  const application = options.application;
  application.on("second-instance", options.focusMainWindow);
  application.on("activate", options.focusMainWindow);
  application.on("window-all-closed", () => {
    if (options.platform !== "darwin") application.quit();
  });
  application.on("before-quit", (event) => {
    const coordinator = options.updateInstallCoordinator();
    if (coordinator?.allowBeforeQuit()) return;
    event.preventDefault();
    options.recordBeforeQuit();
    if (coordinator) return;
    void options.cleanupBeforeQuit().then((cleanupConfirmed) => {
      finishNormalShutdownAfterCleanup({
        cleanupConfirmed,
        finish: options.finishNormalShutdown,
        onUnconfirmed: options.onUnconfirmedShutdown,
      });
    }, options.reportCleanupFailure);
  });
}

function retireUpdateRollback(journal: AppUpdateHandoffJournal): boolean {
  const current = journal.current();
  if (!current) return false;
  const rollingBack = current.phase === "rollback-required"
    ? current
    : journal.transition(
        appUpdateHandoffOwner(current),
        "rollback-required",
      );
  if (!rollingBack) return false;
  const completed = journal.transition(
    appUpdateHandoffOwner(rollingBack),
    "rollback-completed",
  );
  return !!completed && journal.retire(appUpdateHandoffOwner(completed));
}

function appImageRecoveryExpectation(
  pending: AppUpdateHandoffSnapshot,
): AppImageHandoffRecoveryExpectation {
  const phases = pending.phase === "rollback-required"
    ? ["staged", "ownership-committed"] as const
    : pending.phase === "ownership-transfer-committed"
        || pending.phase === "candidate-admitted"
        || pending.phase === "completed"
      ? ["ownership-committed"] as const
      : ["staged"] as const;
  return {
    operationId: pending.operationId,
    artifactDigest: pending.candidateArtifactDigest,
    executableIdentityDigest: pending.candidateExecutableIdentityDigest,
    phases,
  };
}

async function recoverLinuxHandoff(
  options: AppUpdateStartupOptions,
  pending: AppUpdateHandoffSnapshot,
  activePath: string,
  journal: AppUpdateHandoffJournal,
): Promise<string> {
  const recovered = await recoverAppImageUpdateForHandoff({
    channel: options.channel,
    activePath,
    expected: appImageRecoveryExpectation(pending),
  });
  if (!retireUpdateRollback(journal)) {
    throw new Error("The app update rollback authority could not be retired.");
  }
  return await recoverAppImageUpdate({
    channel: options.channel,
    activePath: recovered.activePath,
  });
}

async function reconcileUnclaimedLinuxAppUpdate(
  options: AppUpdateStartupOptions,
): Promise<void> {
  const activePath = options.environment.APPIMAGE;
  if (options.platform !== "linux" || !activePath) return;
  const journal = existsSync(options.dataDirectory)
    ? new AppUpdateHandoffJournal(options.dataDirectory)
    : null;
  const pending = journal?.current() ?? null;
  if (pending && pending.platform !== "linux") {
    throw new Error("The pending app update belongs to another platform.");
  }
  if (journal && pending?.phase === "completed") {
    await finalizeAppImageUpdate({
      channel: options.channel,
      operationId: pending.operationId,
      stablePath: activePath,
      artifactDigest: pending.candidateArtifactDigest,
      executableIdentityDigest: pending.candidateExecutableIdentityDigest,
    });
    journal.retire(appUpdateHandoffOwner(pending));
    return;
  }
  if (!journal || !pending) {
    options.environment.APPIMAGE = await recoverAppImageUpdate({
      channel: options.channel,
      activePath,
    });
    return;
  }
  options.environment.APPIMAGE = await recoverLinuxHandoff(
    options,
    pending,
    activePath,
    journal,
  );
  if (options.version === pending.newVersion) {
    throw new Error(
      "An unclaimed app update candidate was rolled back before startup.",
    );
  }
}

function completeWindowsUpdateRollback(
  journal: AppUpdateHandoffJournal,
  vault: AppUpdateHandoffTokenVault,
): void {
  const current = journal.current();
  if (!current) return;
  const rollingBack = current.phase === "rollback-required"
    ? current
    : journal.transition(
        appUpdateHandoffOwner(current),
        "rollback-required",
      );
  if (!rollingBack || !vault.discard(rollingBack)) {
    throw new Error("The Windows app update rollback authority is incomplete.");
  }
  const completed = journal.transition(
    appUpdateHandoffOwner(rollingBack),
    "rollback-completed",
  );
  if (!completed || !journal.retire(appUpdateHandoffOwner(completed))) {
    throw new Error("The Windows app update rollback could not be retired.");
  }
}

function reconcileUnclaimedWindowsAppUpdate(
  options: AppUpdateStartupOptions,
): void {
  if (!existsSync(options.dataDirectory)) return;
  const journal = new AppUpdateHandoffJournal(options.dataDirectory);
  const pending = journal.current();
  if (!pending) return;
  if (pending.platform !== "win32") {
    throw new Error("The pending app update belongs to another platform.");
  }
  const vault = new AppUpdateHandoffTokenVault(options.dataDirectory);
  if (pending.phase === "completed") {
    if (options.version !== pending.newVersion || !vault.discard(pending)) {
      throw new Error("The completed Windows app update identity is invalid.");
    }
    if (!journal.retire(appUpdateHandoffOwner(pending))) {
      throw new Error("The completed Windows app update could not be retired.");
    }
    return;
  }
  if (pending.phase === "rollback-completed") {
    if (options.version !== pending.oldVersion || !vault.discard(pending)) {
      throw new Error("The rolled-back Windows app update identity is invalid.");
    }
    if (!journal.retire(appUpdateHandoffOwner(pending))) {
      throw new Error("The Windows app update rollback could not be retired.");
    }
    return;
  }
  if (options.version === pending.newVersion) {
    throw new Error(
      "The installed Windows update lacks completed candidate admission.",
    );
  }
  if (options.version !== pending.oldVersion) {
    throw new Error("The pending Windows app update version is incompatible.");
  }
  if (pending.phase === "prepared") {
    completeWindowsUpdateRollback(journal, vault);
    return;
  }
  throw new Error(
    pending.phase === "ownership-transfer-committed"
      || pending.phase === "candidate-launched"
      || pending.phase === "candidate-bootstrap-validated"
      || pending.phase === "candidate-admitted"
      ? "The old Windows application cannot resume after ownership transfer."
      : "The native Windows installer outcome is still unresolved.",
  );
}

async function rollbackFailedCandidateAdmission(
  options: AppUpdateStartupOptions,
  admission: AppUpdateCandidateAdmission,
  journal: AppUpdateHandoffJournal,
): Promise<void> {
  if (admission.platform === "win32") {
    if (!admission.tokenClaim.rollback()) {
      throw new Error(
        "The Windows app update recovery token could not be restored.",
      );
    }
    return;
  }
  const failed = journal.current();
  if (failed && failed.operationId === admission.snapshot.operationId) {
    journal.transition(appUpdateHandoffOwner(failed), "rollback-required");
  }
  await recoverLinuxHandoff(
    options,
    admission.snapshot,
    admission.stableAppImagePath,
    journal,
  ).catch(() => undefined);
}

async function failBootstrappedCandidate(
  options: AppUpdateStartupOptions,
  admission: AppUpdateCandidateAdmission,
  journal: AppUpdateHandoffJournal,
  error: unknown,
): Promise<never> {
  const cleanupConfirmed = await options.cleanupFailedCandidate()
    .catch(() => false);
  if (!cleanupConfirmed) {
    throw new AggregateError(
      [error],
      "The failed app update candidate cleanup is unconfirmed.",
    );
  }
  try {
    await rollbackFailedCandidateAdmission(options, admission, journal);
  } catch (rollbackError) {
    throw new AggregateError(
      [error, rollbackError],
      "The failed app update candidate retained recovery authority.",
    );
  }
  throw error;
}

async function finishCandidateAdmission(
  options: AppUpdateStartupOptions,
  admission: AppUpdateCandidateAdmission,
): Promise<void> {
  const journal = new AppUpdateHandoffJournal(options.dataDirectory);
  const current = journal.current();
  if (
    !current
    || current.operationId !== admission.snapshot.operationId
    || current.checksum !== admission.snapshot.checksum
    || (
      current.phase !== "ownership-transfer-committed"
      && current.phase !== "candidate-bootstrap-validated"
      && current.phase !== "candidate-admitted"
    )
  ) {
    await rollbackFailedCandidateAdmission(options, admission, journal);
    throw new Error("The app update admission authority changed.");
  }
  // This durable phase is the explicit grant for normal runtime/provider
  // bootstrap. Completion is recorded only after bootstrap proves readiness.
  const admitted = current.phase === "candidate-admitted"
    ? current
    : journal.transition(
        appUpdateHandoffOwner(current),
        "candidate-admitted",
      );
  if (!admitted) {
    await rollbackFailedCandidateAdmission(options, admission, journal);
    throw new Error("The app update candidate was not admitted.");
  }
  try {
    await options.application.whenReady();
    await options.bootstrap();
    await options.awaitCandidateReadiness();
  } catch (error) {
    await failBootstrappedCandidate(options, admission, journal, error);
  }
  const completed = journal.transition(
    appUpdateHandoffOwner(admitted),
    "completed",
  );
  if (!completed) {
    return await failBootstrappedCandidate(
      options,
      admission,
      journal,
      new Error("The admitted app update could not record completion."),
    );
  }
  try {
    if (admission.platform === "win32") {
      if (!admission.tokenClaim.commit()) {
        throw new Error("The Windows app update token could not be consumed.");
      }
      if (!journal.retire(appUpdateHandoffOwner(completed))) {
        throw new Error("The completed Windows app update could not be retired.");
      }
      return;
    }
    await finalizeAppImageUpdate({
      channel: options.channel,
      operationId: completed.operationId,
      stablePath: admission.stableAppImagePath,
      artifactDigest: completed.candidateArtifactDigest,
      executableIdentityDigest: completed.candidateExecutableIdentityDigest,
    });
    if (!journal.retire(appUpdateHandoffOwner(completed))) {
      console.error("The completed app update handoff could not be retired.");
    }
  } catch (error) {
    console.error("The completed app update retained recovery authority.", error);
  }
}

export async function startApplicationWithUpdateHandoff(
  options: AppUpdateStartupOptions,
): Promise<void> {
  const linuxRequest = appUpdateCandidateBootstrapRequest(options.environment);
  let candidateAdmission: AppUpdateCandidateAdmission | null = null;
  if (linuxRequest) {
    try {
      candidateAdmission = await runRestrictedAppUpdateCandidate({
        request: linuxRequest,
        environment: options.environment,
        platform: options.platform,
        channel: options.channel,
        version: options.version,
        validateBootstrap: options.validateCandidateBootstrap,
      });
      options.environment.APPIMAGE = candidateAdmission.stableAppImagePath;
    } catch (error) {
      options.reportCandidateFailure(
        "The restricted app update candidate was rejected.",
        error,
      );
      options.application.exit(1);
      return;
    }
  }

  if (!options.application.requestSingleInstanceLock()) {
    if (candidateAdmission?.platform === "linux") {
      const journal = new AppUpdateHandoffJournal(options.dataDirectory);
      await recoverLinuxHandoff(
        options,
        candidateAdmission.snapshot,
        candidateAdmission.stableAppImagePath,
        journal,
      ).catch(() => undefined);
    }
    options.application.quit();
    return;
  }

  if (options.platform === "win32") {
    let windowsRequest: AppUpdateWindowsCandidateBootstrapRequest | null;
    try {
      windowsRequest = existsSync(options.dataDirectory)
        ? await windowsAppUpdateCandidateBootstrapRequest({
            handoffDirectory: options.dataDirectory,
            profileDirectory: options.profileDirectory,
            dataDirectory: options.dataDirectory,
            executablePath: options.executablePath,
            channel: options.channel,
            version: options.version,
          })
        : null;
      if (windowsRequest) {
        candidateAdmission = await runRestrictedWindowsAppUpdateCandidate(
          windowsRequest,
          options.validateCandidateBootstrap,
        );
      } else {
        reconcileUnclaimedWindowsAppUpdate(options);
      }
    } catch (error) {
      options.reportCandidateFailure(
        "The restricted Windows update candidate was rejected.",
        error,
      );
      options.application.exit(1);
      return;
    }
  } else if (!candidateAdmission) {
    await reconcileUnclaimedLinuxAppUpdate(options);
  }

  registerApplicationLifecycle(options);
  if (candidateAdmission) {
    await finishCandidateAdmission(options, candidateAdmission);
  } else {
    await options.application.whenReady();
    await options.bootstrap();
  }
}
