import { existsSync } from "node:fs";

import {
  appUpdateArtifactIdentity,
  appUpdateCandidateBootstrapRequest,
  appUpdateDirectoryIdentityDigest,
  runRestrictedAppUpdateCandidate,
  runRestrictedWindowsAppUpdateCandidate,
  windowsAppUpdateCandidateBootstrapRequest,
  type AppUpdateCandidateAdmission,
  type AppUpdateWindowsCandidateBootstrapRequest,
} from "./app-update-bootstrap.js";
import {
  AppUpdateHandoffJournal,
  appUpdateHandoffIdentityMatches,
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
import {
  recoverLinuxAppUpdateCandidateClaim,
  retireLinuxAppUpdateCandidateClaimAfterAdmission,
} from "./linux-app-update-candidate-process.js";
import { LinuxAppUpdateCandidateClaimJournal } from
  "./linux-app-update-candidate-claim.js";
import type { InertiaReleaseChannel } from "./release-channel.js";
import type { AppUpdateCandidateExpectedRuntimeOwner } from
  "../node/app-update-candidate-viability-protocol.js";
import {
  retireWindowsUpdateSupervisorArtifacts,
  WindowsUpdateTerminalReceiptJournal,
  windowsUpdateSupervisorArtifactPresent,
  windowsUpdateTerminalReceiptMatches,
  windowsUpdateTerminalReceiptMatchesQuarantine,
  windowsUpdateTerminalReceiptMatchesRollbackAuthority,
} from "./windows-update-terminal-receipt.js";

export interface AppUpdateStartupOptions {
  readonly platform: NodeJS.Platform;
  readonly environment: NodeJS.ProcessEnv;
  readonly channel: InertiaReleaseChannel;
  readonly version: string;
  readonly executablePath: string;
  readonly dataDirectory: string;
  readonly profileDirectory: string;
  readonly runtimeProcessGuardianPath?: string | null;
  readonly application: Pick<
    typeof import("electron")["app"],
    "exit" | "on" | "quit" | "requestSingleInstanceLock" | "whenReady"
  >;
  focusMainWindow(): void;
  updateInstallCoordinator(): {
    allowBeforeQuit(): boolean;
    retryUnconfirmedNormalShutdown?(): boolean;
  } | null;
  recordBeforeQuit(): void;
  cleanupBeforeQuit(): Promise<boolean>;
  finishNormalShutdown(): void;
  onUnconfirmedShutdown(): void;
  reportCleanupFailure(error: unknown): void;
  validateCandidateBootstrap(
    operationId: string,
    expectedActiveRuntimeOwner: AppUpdateCandidateExpectedRuntimeOwner | null,
  ): Promise<void>;
  bootstrap(): Promise<void>;
  awaitCandidateReadiness(): Promise<void>;
  cleanupFailedCandidate(): Promise<boolean>;
  reportCandidateFailure(message: string, error: unknown): void;
}

export function registerApplicationLifecycle(options: AppUpdateStartupOptions): void {
  const application = options.application;
  application.on("second-instance", () => {
    options.focusMainWindow();
    if (options.platform === "linux") {
      options.updateInstallCoordinator()
        ?.retryUnconfirmedNormalShutdown?.();
    }
  });
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

export function beginAppUpdateRollback(
  journal: AppUpdateHandoffJournal,
  expected: AppUpdateHandoffSnapshot,
): AppUpdateHandoffSnapshot {
  if (expected.platform !== "linux") {
    throw new Error("The app update rollback authority belongs to another platform.");
  }
  const current = journal.current();
  if (!current) {
    throw new Error("The app update rollback authority changed.");
  }
  const exactExpected = current.checksum === expected.checksum
    && current.revision === expected.revision
    && current.phase === expected.phase
    && appUpdateHandoffIdentityMatches(current, expected);
  const exactRollbackSuccessor = current.phase === "rollback-required"
    && current.revision === expected.revision + 1
    && current.previousChecksum === expected.checksum
    && appUpdateHandoffIdentityMatches(current, expected);
  const exactCompletedSuccessor = expected.phase === "rollback-required"
    && current.phase === "rollback-completed"
    && current.revision === expected.revision + 1
    && current.previousChecksum === expected.checksum
    && appUpdateHandoffIdentityMatches(current, expected);
  if (exactCompletedSuccessor) return current;
  if (!exactExpected && !exactRollbackSuccessor) {
    throw new Error("The app update rollback authority changed.");
  }
  if (
    current.phase === "rollback-required"
    || current.phase === "rollback-completed"
  ) return current;
  // Use the caller's exact owner rather than minting authority from a newer
  // snapshot. The journal transition admits only this owner or its already
  // published immediate rollback successor.
  const rollingBack = journal.transition(
    appUpdateHandoffOwner(expected),
    "rollback-required",
  );
  if (!rollingBack) {
    throw new Error("The app update rollback authority could not be recorded.");
  }
  return rollingBack;
}

export function retireAppUpdateRollback(
  journal: AppUpdateHandoffJournal,
  expected: AppUpdateHandoffSnapshot,
): boolean {
  if (
    expected.platform !== "linux"
    || (
      expected.phase !== "rollback-required"
      && expected.phase !== "rollback-completed"
    )
  ) return false;
  const current = journal.current();
  if (!current && expected.phase === "rollback-completed") return true;
  if (!current) return false;
  const exactExpected = current.checksum === expected.checksum
    && current.revision === expected.revision
    && current.phase === expected.phase
    && appUpdateHandoffIdentityMatches(current, expected);
  const exactCompletedSuccessor = expected.phase === "rollback-required"
    && current.phase === "rollback-completed"
    && current.revision === expected.revision + 1
    && current.previousChecksum === expected.checksum
    && appUpdateHandoffIdentityMatches(current, expected);
  if (!exactExpected && !exactCompletedSuccessor) return false;
  const completed = current.phase === "rollback-completed"
    ? current
    : journal.transition(
        appUpdateHandoffOwner(expected),
        "rollback-completed",
      );
  return !!completed && journal.retire(appUpdateHandoffOwner(completed));
}

function appImageRecoveryExpectation(
  pending: AppUpdateHandoffSnapshot,
): AppImageHandoffRecoveryExpectation {
  const phases = pending.phase === "rollback-required"
      || pending.phase === "rollback-completed"
      || pending.phase === "old-generation-cleanup-confirmed"
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
  await recoverLinuxCandidateClaimIfPresent(options, pending);
  const rollingBack = beginAppUpdateRollback(journal, pending);
  // Even a durable rollback-completed phase must re-prove its exact companion
  // transaction before the outer authority is retired. The companion journal
  // is intentionally retained until this point.
  const recoveredPath = (await recoverAppImageUpdateForHandoff({
    channel: options.channel,
    activePath,
    expected: appImageRecoveryExpectation(pending),
  })).activePath;
  if (!retireAppUpdateRollback(journal, rollingBack)) {
    throw new Error("The app update rollback authority could not be retired.");
  }
  return await recoverAppImageUpdate({
    channel: options.channel,
    activePath: recoveredPath,
  });
}

async function recoverLinuxCandidateClaimIfPresent(
  options: AppUpdateStartupOptions,
  pending: AppUpdateHandoffSnapshot,
): Promise<void> {
  const candidateClaim = new LinuxAppUpdateCandidateClaimJournal(
    options.dataDirectory,
  ).recovery(pending);
  if (candidateClaim) {
    if (!options.runtimeProcessGuardianPath) {
      throw new Error("The app update candidate guardian is unavailable.");
    }
    const recovered = await recoverLinuxAppUpdateCandidateClaim({
      handoffDirectory: options.dataDirectory,
      guardianPath: options.runtimeProcessGuardianPath,
      snapshot: pending,
    });
    if (!recovered) {
      throw new Error(
        "The app update candidate guardian cleanup remains quarantined.",
      );
    }
  }
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
    await recoverLinuxCandidateClaimIfPresent(options, pending);
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

export function completeWindowsUpdateRollback(
  journal: AppUpdateHandoffJournal,
  vault: AppUpdateHandoffTokenVault,
  expected: AppUpdateHandoffSnapshot,
): void {
  const current = journal.current();
  const exactExpected = current?.checksum === expected.checksum;
  const completedFromExpected = expected.phase === "prepared"
    && current?.phase === "rollback-completed"
    && current.revision === expected.revision + 1
    && current.previousChecksum === expected.checksum;
  if (
    !current
    || (!exactExpected && !completedFromExpected)
    || !appUpdateHandoffIdentityMatches(current, expected)
  ) {
    throw new Error("The Windows app update rollback authority changed.");
  }
  if (
    current.phase !== "prepared"
    && current.phase !== "rollback-completed"
  ) {
    throw new Error("The native Windows installer outcome is still unresolved.");
  }
  const completed = current.phase === "rollback-completed"
    ? current
    : journal.transition(
        appUpdateHandoffOwner(current),
        "rollback-completed",
      );
  if (
    !completed
    || !vault.discard(completed)
    || !journal.retire(appUpdateHandoffOwner(completed))
  ) {
    throw new Error("The Windows app update rollback could not be retired.");
  }
}

async function completeAuthenticatedWindowsUpdateRollback(
  options: AppUpdateStartupOptions,
  journal: AppUpdateHandoffJournal,
  vault: AppUpdateHandoffTokenVault,
  expected: AppUpdateHandoffSnapshot,
): Promise<void> {
  let current = journal.current();
  const exactExpected = current?.checksum === expected.checksum
    && current.revision === expected.revision;
  const completedFromExpected = expected.phase
      === "old-generation-cleanup-confirmed"
    && current?.phase === "rollback-completed"
    && current.revision === expected.revision + 1
    && current.previousChecksum === expected.checksum;
  if (
    !current
    || (!exactExpected && !completedFromExpected)
    || !appUpdateHandoffIdentityMatches(current, expected)
    || (
      current.phase !== "old-generation-cleanup-confirmed"
      && current.phase !== "rollback-completed"
    )
  ) throw new Error("The Windows app update rollback authority changed.");
  const receiptJournal = new WindowsUpdateTerminalReceiptJournal(
    options.dataDirectory,
  );
  const receipt = receiptJournal.current(current.operationId);
  let claim = null as ReturnType<AppUpdateHandoffTokenVault["claim"]>;
  let claimFinalized = false;
  try {
    if (current.phase === "old-generation-cleanup-confirmed") {
      claim = vault.claim(current, {
        allowExpired: true,
        recoverAbandonedClaim: true,
      });
      if (
        claim
        && receipt
        && windowsUpdateTerminalReceiptMatchesQuarantine({
          receipt,
          snapshot: current,
          handoffToken: claim.token,
        })
      ) {
        throw new Error(
          "The native Windows installer remains quarantined because its terminal outcome was not safely confirmed.",
        );
      }
    }
    // Authenticate an unresolved-installer quarantine before opening an
    // executable namespace that the native installer may still be mutating.
    const executable = await appUpdateArtifactIdentity(options.executablePath);
    if (current.phase === "old-generation-cleanup-confirmed") {
      if (
        !claim
        || !receipt
        || !windowsUpdateTerminalReceiptMatches({
          receipt,
          snapshot: current,
          handoffToken: claim.token,
          outcome: "clean-failure",
          executableDigest: executable.artifactDigest,
        })
      ) throw new Error("The Windows installer failure receipt is invalid.");
      const completed = journal.transition(
        appUpdateHandoffOwner(current),
        "rollback-completed",
      );
      if (!completed) {
        throw new Error("The Windows update rollback was not recorded.");
      }
      current = completed;
    } else if (receipt) {
      claim = vault.claim(current, {
        allowExpired: true,
        recoverAbandonedClaim: true,
      });
      if (
        !claim
        || !windowsUpdateTerminalReceiptMatchesRollbackAuthority({
          receipt,
          snapshot: current,
          handoffToken: claim.token,
          executableDigest: executable.artifactDigest,
        })
      ) throw new Error("The Windows installer failure receipt is invalid.");
    }
    if (!receipt) {
      if (windowsUpdateSupervisorArtifactPresent({
        dataDirectory: options.dataDirectory,
        operationId: current.operationId,
      })) {
        throw new Error("The Windows update supervisor retirement is ambiguous.");
      }
    } else if (!await retireWindowsUpdateSupervisorArtifacts({
      dataDirectory: options.dataDirectory,
      receipt,
    })) {
      throw new Error("The Windows update supervisor could not be retired.");
    }
    const tokenRetired = claim ? claim.commit() : vault.discard(current);
    claimFinalized = tokenRetired;
    if (
      !tokenRetired
      || !journal.retire(appUpdateHandoffOwner(current))
    ) throw new Error("The Windows app update rollback could not be retired.");
  } catch (error) {
    if (claim && !claimFinalized && !claim.rollback()) {
      throw new AggregateError(
        [error],
        "The rejected Windows installer receipt retained its token claim.",
      );
    }
    throw error;
  }
}

function rejectAuthenticatedWindowsUpdateQuarantine(
  options: AppUpdateStartupOptions,
): void {
  if (!existsSync(options.dataDirectory)) return;
  const journal = new AppUpdateHandoffJournal(options.dataDirectory);
  const pending = journal.current();
  if (
    !pending
    || pending.platform !== "win32"
    || pending.phase !== "old-generation-cleanup-confirmed"
  ) return;
  const receipt = new WindowsUpdateTerminalReceiptJournal(
    options.dataDirectory,
  ).current(pending.operationId);
  if (!receipt || receipt.outcome !== "quarantined") return;
  const claim = new AppUpdateHandoffTokenVault(options.dataDirectory).claim(
    pending,
    { allowExpired: true, recoverAbandonedClaim: true },
  );
  if (!claim) return;
  const authenticated = windowsUpdateTerminalReceiptMatchesQuarantine({
    receipt,
    snapshot: pending,
    handoffToken: claim.token,
  });
  if (!claim.rollback()) {
    throw new Error(
      "The quarantined Windows installer receipt retained its token claim.",
    );
  }
  if (authenticated) {
    throw new Error(
      "The native Windows installer remains quarantined because its terminal outcome was not safely confirmed.",
    );
  }
}

async function reconcileUnclaimedWindowsAppUpdate(
  options: AppUpdateStartupOptions,
): Promise<void> {
  if (!existsSync(options.dataDirectory)) return;
  const journal = new AppUpdateHandoffJournal(options.dataDirectory);
  const pending = journal.current();
  if (!pending) return;
  if (pending.platform !== "win32") {
    throw new Error("The pending app update belongs to another platform.");
  }
  if (
    pending.channel !== options.channel
    || pending.profileIdentityDigest !== appUpdateDirectoryIdentityDigest(
      options.profileDirectory,
      "profile",
    )
    || pending.dataIdentityDigest !== appUpdateDirectoryIdentityDigest(
      options.dataDirectory,
      "data",
    )
  ) throw new Error("The pending Windows app update identity is invalid.");
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
    if (options.version !== pending.oldVersion) {
      throw new Error("The rolled-back Windows app update identity is invalid.");
    }
    await completeAuthenticatedWindowsUpdateRollback(
      options,
      journal,
      vault,
      pending,
    );
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
    completeWindowsUpdateRollback(journal, vault, pending);
    return;
  }
  if (pending.phase === "old-generation-cleanup-confirmed") {
    await completeAuthenticatedWindowsUpdateRollback(
      options,
      journal,
      vault,
      pending,
    );
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
  await recoverLinuxHandoff(
    options,
    admission.snapshot,
    admission.stableAppImagePath,
    journal,
  );
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
  if (
    admission.platform === "linux"
    && !retireLinuxAppUpdateCandidateClaimAfterAdmission({
      handoffDirectory: options.dataDirectory,
      snapshot: admitted,
      instanceChecksum: admission.candidateInstanceChecksum,
    })
  ) {
    throw new Error(
      "The admitted app update candidate claim could not be retired.",
    );
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
      try {
        await recoverLinuxHandoff(
          options,
          candidateAdmission.snapshot,
          candidateAdmission.stableAppImagePath,
          journal,
        );
      } catch (error) {
        options.reportCandidateFailure(
          "The restricted app update candidate could not relinquish ownership.",
          error,
        );
        options.application.exit(1);
        return;
      }
    }
    options.application.quit();
    return;
  }

  if (options.platform === "win32") {
    let windowsRequest: AppUpdateWindowsCandidateBootstrapRequest | null;
    try {
      rejectAuthenticatedWindowsUpdateQuarantine(options);
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
        await reconcileUnclaimedWindowsAppUpdate(options);
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
