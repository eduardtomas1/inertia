import { existsSync } from "node:fs";
import { dialog, type BrowserWindow } from "electron";

import type { ModernDarwinRecoveryAuthorityDescriptor } from
  "../node/runtime-modern-recovery-authorities.js";
import {
  authorizeLegacyRuntimeRecovery,
  authorizeModernDarwinRuntimeRecovery,
  LEGACY_RUNTIME_RECOVERY_DIALOG_DETAIL,
  MODERN_DARWIN_RECOVERY_DIALOG_DETAIL,
  prepareModernDarwinBootstrapRecovery,
  runtimeBootstrapAdmissionBlocked,
  prepareRuntimeBootstrapSafety,
  type RuntimeBootstrapSafety,
} from "./runtime-bootstrap-safety.js";
import { resolveRuntimeProcessGuardianPath } from "./runtime-assets.js";

export function resolveRequiredRuntimeProcessGuardianPath(options: {
  readonly platform: NodeJS.Platform;
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly appPath: string;
}): string | null {
  const path = options.platform === "darwin" || options.platform === "linux"
    ? resolveRuntimeProcessGuardianPath(options)
    : null;
  if (path && !existsSync(path)) {
    throw new Error(`The required runtime process guardian is missing: ${path}`);
  }
  return path;
}

export interface RuntimeBootstrapRecoveryResult {
  readonly bootstrapSafety: RuntimeBootstrapSafety;
  readonly modernDarwinRecoveryAuthority:
    ModernDarwinRecoveryAuthorityDescriptor | null;
  readonly runtimeRecoveryBlocked: boolean;
}

export async function promptForLiveModernDarwinRuntimeRecovery(
  dataDirectory: string,
  systemBootId: string,
  runtimeProcessGuardianPath: string,
  window: BrowserWindow,
): Promise<ModernDarwinRecoveryAuthorityDescriptor | null> {
  if (window.isDestroyed()) return null;
  const recovery = await prepareModernDarwinBootstrapRecovery(
    dataDirectory,
    systemBootId,
    runtimeProcessGuardianPath,
  );
  if (window.isDestroyed()) return null;
  // Unparented macOS alerts run synchronously, stopping main-process timers,
  // diagnostics and shutdown. Live recovery must remain a cancellable sheet.
  const controller = new AbortController();
  const cancel = (): void => controller.abort();
  window.once("closed", cancel);
  try {
    if (recovery.blocked) {
      await dialog.showMessageBox(window, {
        type: "error",
        title: "Runtime recovery remains safety locked",
        message: "Inertia could not verify its exact local recovery journal. Your projects and attachments remain preserved; close Inertia and try again.",
        buttons: ["Keep safety lock"],
        defaultId: 0,
        cancelId: 0,
        signal: controller.signal,
      });
      return null;
    }
    if (recovery.authority) return recovery.authority;
    if (!recovery.candidate) return null;
    const decision = await dialog.showMessageBox(window, {
      type: "warning",
      title: "Recover unproven macOS runtime state?",
      message: "The Inertia local service stopped with unproven process ownership state.",
      detail: MODERN_DARWIN_RECOVERY_DIALOG_DETAIL,
      buttons: ["I closed them — recover", "Keep safety lock"],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      signal: controller.signal,
    });
    if (decision.response !== 0
      || controller.signal.aborted
      || window.isDestroyed()) return null;
    const authority = authorizeModernDarwinRuntimeRecovery(
      dataDirectory,
      recovery.candidate,
      systemBootId,
      runtimeProcessGuardianPath,
    );
    if (!authority) {
      await dialog.showMessageBox(window, {
        type: "error",
        title: "Runtime recovery was not authorized",
        message: "The recorded process state changed before recovery could begin. Inertia kept the safety lock and preserved your work; close every older Inertia, agent, and terminal process, then try again.",
        buttons: ["Keep safety lock"],
        defaultId: 0,
        cancelId: 0,
        signal: controller.signal,
      });
    }
    return authority;
  } finally {
    window.removeListener("closed", cancel);
  }
}

export async function prepareRuntimeBootstrapRecovery(
  dataDirectory: string,
  runtimeProcessGuardianPath: string | null,
): Promise<RuntimeBootstrapRecoveryResult> {
  let bootstrapSafety = prepareRuntimeBootstrapSafety(dataDirectory);
  let modernDarwinRecoveryAuthority = null as
    ModernDarwinRecoveryAuthorityDescriptor | null;
  const modernDarwinRecovery = await prepareModernDarwinBootstrapRecovery(
    dataDirectory,
    bootstrapSafety.systemBootId,
    runtimeProcessGuardianPath,
  );
  modernDarwinRecoveryAuthority = modernDarwinRecovery.authority;
  let modernRecoveryReady = !modernDarwinRecovery.blocked
    && modernDarwinRecovery.candidate === null;

  if (modernDarwinRecovery.blocked) {
    dialog.showErrorBox(
      "Runtime recovery remains safety locked",
      "Inertia could not verify its exact local recovery journal. Your projects and attachments remain preserved; close Inertia and try again.",
    );
  } else if (modernDarwinRecovery.candidate) {
    const decision = await dialog.showMessageBox({
      type: "warning",
      title: "Recover unproven macOS runtime state?",
      message: "A previous Inertia runtime still has unproven process ownership state.",
      detail: MODERN_DARWIN_RECOVERY_DIALOG_DETAIL,
      buttons: ["I closed them — recover", "Keep safety lock"],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (decision.response === 0) {
      modernDarwinRecoveryAuthority = authorizeModernDarwinRuntimeRecovery(
        dataDirectory,
        modernDarwinRecovery.candidate,
        bootstrapSafety.systemBootId,
        runtimeProcessGuardianPath ?? "",
      );
      if (!modernDarwinRecoveryAuthority) {
        dialog.showErrorBox(
          "Runtime recovery was not authorized",
          "The recorded process state changed before recovery could begin. Inertia kept the safety lock and preserved your work; close every older Inertia, agent, and terminal process, then reopen Inertia to review the current state.",
        );
      } else {
        modernRecoveryReady = true;
      }
    }
  }

  // Bind the complete modern snapshot first. Only then can an unrelated
  // unavailable legacy batch be offered in the same launch; cancellation or
  // either partial publication leaves every provider admission safety-locked.
  bootstrapSafety = prepareRuntimeBootstrapSafety(dataDirectory);
  if (
    modernRecoveryReady
    && bootstrapSafety.legacyRecoveryCandidates.length > 0
  ) {
    const decision = await dialog.showMessageBox({
      type: "warning",
      title: "Recover legacy local runtime state?",
      message: "A previous Inertia runtime has legacy process ownership state.",
      detail: LEGACY_RUNTIME_RECOVERY_DIALOG_DETAIL,
      buttons: ["Recover and continue", "Keep safety lock"],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (decision.response === 0) {
      const authorized = authorizeLegacyRuntimeRecovery(
        dataDirectory,
        bootstrapSafety.legacyRecoveryCandidates,
        bootstrapSafety.systemBootId,
      );
      if (!authorized) {
        dialog.showErrorBox(
          "Legacy runtime recovery was not authorized",
          "Inertia kept the existing safety lock and preserved your work. Close Inertia and try again.",
        );
      }
      bootstrapSafety = prepareRuntimeBootstrapSafety(dataDirectory);
    }
  }

  return {
    bootstrapSafety,
    modernDarwinRecoveryAuthority,
    runtimeRecoveryBlocked: !modernRecoveryReady
      || bootstrapSafety.legacyRecoveryCandidates.length > 0
      || runtimeBootstrapAdmissionBlocked(dataDirectory, bootstrapSafety.systemBootId),
  };
}
