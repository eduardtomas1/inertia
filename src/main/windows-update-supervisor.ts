import { createHash, randomUUID } from "node:crypto";
import {
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import {
  pinDirectRuntimeJournalRoot,
  readDirectRuntimeJournalLeaf,
  writeDirectRuntimeJournalLeaf,
} from "../node/direct-runtime-journal.js";
import {
  appUpdateArtifactIdentity,
  type AppUpdateArtifactIdentity,
} from "./app-update-bootstrap.js";
import {
  appUpdateHandoffTokenDigest,
  type AppUpdateHandoffSnapshot,
} from "./app-update-handoff.js";
import {
  launchWindowsUpdateSupervisorThroughExecutableLock,
  validateWindowsRuntimeJobAssembly,
  WindowsUpdateSupervisorBrokerError,
  type WindowsRuntimeJobAssembly,
} from "./windows-runtime-job.js";
import {
  retireWindowsUpdateOperationClaim,
  retireWindowsUpdateSupervisorHelper,
  WindowsUpdateTerminalReceiptJournal,
  windowsUpdateSupervisorExecutableName,
  windowsUpdateTerminalReceiptName,
  windowsUpdateTerminalReceiptTemporaryName,
} from "./windows-update-terminal-receipt.js";

const READY_TIMEOUT_MS = 10_000;
const MAX_SUPERVISOR_BYTES = 1024 * 1024;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_REQUEST_FIELD_BYTES = 4 * 1024;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;

export interface WindowsUpdateSupervisorLaunchOptions {
  readonly dataDirectory: string;
  readonly installerPath: string;
  readonly installerIdentity: AppUpdateArtifactIdentity;
  readonly oldExecutablePath: string;
  readonly oldExecutableIdentity: AppUpdateArtifactIdentity;
  readonly newExecutableDigest: string;
  readonly snapshot: AppUpdateHandoffSnapshot;
  readonly handoffToken: string;
  readonly assembly: WindowsRuntimeJobAssembly;
  readonly parentProcessId?: number;
  readonly readyTimeoutMs?: number;
  readonly launchThroughExecutableLock?:
    typeof launchWindowsUpdateSupervisorThroughExecutableLock;
}

export interface WindowsUpdateSupervisorAdmission {
  readonly helperPath: string;
  readonly helperDigest: string;
}

export class WindowsUpdateSupervisorCleanupError extends Error {
  constructor(readonly cause: unknown) {
    super("The rejected Windows update supervisor cleanup is unconfirmed.");
  }
}

function pathOutsideInstallTree(path: string, executablePath: string): boolean {
  const installRoot = dirname(realpathSync(executablePath));
  const candidate = realpathSync(path);
  const difference = relative(installRoot, candidate);
  return difference !== ""
    && difference !== "."
    && (difference.startsWith("..") || isAbsolute(difference));
}

function encodeField(name: string, value: string): string {
  if (
    value.length === 0
    || value.includes("\0")
    || Buffer.byteLength(value, "utf8") > MAX_REQUEST_FIELD_BYTES
  ) throw new Error(`The Windows update supervisor ${name} is invalid.`);
  return `${name}=${Buffer.from(value, "utf8").toString("base64")}`;
}

export function serializeWindowsUpdateSupervisorRequest(options: {
  readonly operationId: string;
  readonly handoffChecksum: string;
  readonly launchId: string;
  readonly parentProcessId: number;
  readonly installerPath: string;
  readonly installerDigest: string;
  readonly oldExecutablePath: string;
  readonly oldExecutableDigest: string;
  readonly newExecutablePath: string;
  readonly newExecutableDigest: string;
  readonly receiptPath: string;
  readonly receiptTemporaryPath: string;
  readonly supervisorDigest: string;
  readonly handoffToken: string;
  readonly deadlineAt: string;
}): string {
  if (
    !Number.isSafeInteger(options.parentProcessId)
    || options.parentProcessId <= 1
    || options.parentProcessId > 0x7fff_ffff
  ) throw new Error("The Windows update supervisor parent is invalid.");
  const fields = [
    ["operationId", options.operationId],
    ["handoffChecksum", options.handoffChecksum],
    ["launchId", options.launchId],
    ["parentProcessId", String(options.parentProcessId)],
    ["installerPath", options.installerPath],
    ["installerDigest", options.installerDigest],
    ["oldExecutablePath", options.oldExecutablePath],
    ["oldExecutableDigest", options.oldExecutableDigest],
    ["newExecutablePath", options.newExecutablePath],
    ["newExecutableDigest", options.newExecutableDigest],
    ["receiptPath", options.receiptPath],
    ["receiptTemporaryPath", options.receiptTemporaryPath],
    ["supervisorDigest", options.supervisorDigest],
    ["handoffToken", options.handoffToken],
    ["deadlineAt", options.deadlineAt],
  ] as const;
  const request = [
    "INERTIA_UPDATE_SUPERVISOR_V1",
    ...fields.map(([name, value]) => encodeField(name, value)),
    "",
  ].join("\n");
  if (Buffer.byteLength(request, "utf8") > MAX_REQUEST_BYTES) {
    throw new Error("The Windows update supervisor request is oversized.");
  }
  return request;
}

function stageSupervisor(options: {
  readonly dataDirectory: string;
  readonly operationId: string;
  readonly assembly: WindowsRuntimeJobAssembly;
  readonly executablePath: string;
}): WindowsUpdateSupervisorAdmission {
  const assembly = validateWindowsRuntimeJobAssembly(options.assembly);
  const root = pinDirectRuntimeJournalRoot(options.dataDirectory);
  if (!pathOutsideInstallTree(root.path, options.executablePath)) {
    throw new Error("The Windows update supervisor is inside the install tree.");
  }
  const bytes = readFileSync(assembly.path);
  if (
    bytes.byteLength < 1
    || bytes.byteLength > MAX_SUPERVISOR_BYTES
    || createHash("sha256").update(bytes).digest("hex") !== assembly.sha256
  ) throw new Error("The Windows update supervisor integrity changed.");
  const name = windowsUpdateSupervisorExecutableName(options.operationId);
  const existing = readDirectRuntimeJournalLeaf(
    root,
    name,
    MAX_SUPERVISOR_BYTES,
  );
  if (existing) {
    if (createHash("sha256").update(existing.bytes).digest("hex") !== assembly.sha256) {
      throw new Error("The staged Windows update supervisor is invalid.");
    }
  } else if (!writeDirectRuntimeJournalLeaf(
    root,
    `${name}.publish.tmp`,
    name,
    bytes,
  )) {
    throw new Error("The Windows update supervisor could not be staged.");
  }
  const staged = readDirectRuntimeJournalLeaf(
    root,
    name,
    MAX_SUPERVISOR_BYTES,
  );
  if (
    !staged
    || createHash("sha256").update(staged.bytes).digest("hex") !== assembly.sha256
  ) throw new Error("The staged Windows update supervisor is invalid.");
  return Object.freeze({
    helperPath: join(root.path, name),
    helperDigest: assembly.sha256,
  });
}

function boundedTimeout(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0
    ? Math.min(Number(value), fallback)
    : fallback;
}

export async function launchWindowsUpdateSupervisor(
  options: WindowsUpdateSupervisorLaunchOptions,
): Promise<WindowsUpdateSupervisorAdmission> {
  const { snapshot } = options;
  if (
    snapshot.platform !== "win32"
    || snapshot.phase !== "old-generation-cleanup-confirmed"
    || !DIGEST_PATTERN.test(options.newExecutableDigest)
    || appUpdateHandoffTokenDigest(options.handoffToken)
      !== snapshot.handoffTokenDigest
  ) throw new Error("The Windows update supervisor authority is invalid.");
  // Resolve every caller-controlled namespace once, before identity admission.
  // A junction or symbolic-link parent can subsequently be retargeted without
  // changing these direct canonical launch paths.
  const dataDirectory = realpathSync(options.dataDirectory);
  const installerPath = realpathSync(options.installerPath);
  const executablePath = realpathSync(options.oldExecutablePath);
  const [installerIdentity, oldExecutableIdentity] = await Promise.all([
    appUpdateArtifactIdentity(installerPath),
    appUpdateArtifactIdentity(executablePath),
  ]);
  if (
    installerIdentity.artifactDigest
      !== options.installerIdentity.artifactDigest
    || installerIdentity.directFileIdentityDigest
      !== options.installerIdentity.directFileIdentityDigest
    || oldExecutableIdentity.artifactDigest
      !== options.oldExecutableIdentity.artifactDigest
    || oldExecutableIdentity.directFileIdentityDigest
      !== options.oldExecutableIdentity.directFileIdentityDigest
  ) throw new Error("The Windows update supervisor artifact identity changed.");
  const receiptJournal = new WindowsUpdateTerminalReceiptJournal(
    dataDirectory,
  );
  try {
    if (receiptJournal.current(snapshot.operationId)) {
      throw new Error("A Windows update terminal receipt already exists.");
    }
  } catch (error) {
    // A canonical receipt, an in-flight claim, or ambiguous receipt storage is
    // native authority owned by this operation. A competing caller must not
    // turn that authority into an ordinary pre-admission rollback.
    throw new WindowsUpdateSupervisorCleanupError(error);
  }
  const admitted = stageSupervisor({
    dataDirectory,
    operationId: snapshot.operationId,
    assembly: options.assembly,
    executablePath,
  });
  const launchId = randomUUID();
  const retireRejectedHelper = async (): Promise<boolean> => {
    try {
      return await retireWindowsUpdateSupervisorHelper({
        dataDirectory,
        operationId: snapshot.operationId,
        supervisorDigest: admitted.helperDigest,
      });
    } catch {
      return false;
    }
  };
  const retireRejectedClaim = (): boolean => {
    try {
      return retireWindowsUpdateOperationClaim({
        dataDirectory,
        operationId: snapshot.operationId,
        handoffChecksum: snapshot.checksum,
        launchId,
        supervisorDigest: admitted.helperDigest,
        handoffToken: options.handoffToken,
        deadlineAt: snapshot.deadlineAt,
      });
    } catch {
      return false;
    }
  };
  let request: string;
  try {
    request = serializeWindowsUpdateSupervisorRequest({
      operationId: snapshot.operationId,
      handoffChecksum: snapshot.checksum,
      launchId,
      parentProcessId: options.parentProcessId ?? process.pid,
      installerPath,
      installerDigest: installerIdentity.artifactDigest,
      oldExecutablePath: executablePath,
      oldExecutableDigest: oldExecutableIdentity.artifactDigest,
      newExecutablePath: executablePath,
      newExecutableDigest: options.newExecutableDigest,
      receiptPath: join(
        dataDirectory,
        windowsUpdateTerminalReceiptName(snapshot.operationId),
      ),
      receiptTemporaryPath: join(
        dataDirectory,
        windowsUpdateTerminalReceiptTemporaryName(snapshot.operationId),
      ),
      supervisorDigest: admitted.helperDigest,
      handoffToken: options.handoffToken,
      deadlineAt: snapshot.deadlineAt,
    });
  } catch (error) {
    if (!await retireRejectedHelper()) {
      throw new WindowsUpdateSupervisorCleanupError(error);
    }
    throw error;
  }
  try {
    await (
      options.launchThroughExecutableLock
      ?? launchWindowsUpdateSupervisorThroughExecutableLock
    )({
      assembly: options.assembly,
      helperPath: admitted.helperPath,
      helperDigest: admitted.helperDigest,
      request,
      timeoutMs: boundedTimeout(options.readyTimeoutMs, READY_TIMEOUT_MS),
    });
  } catch (error) {
    if (
      !(error instanceof WindowsUpdateSupervisorBrokerError)
      || !error.cleanupConfirmed
    ) throw new WindowsUpdateSupervisorCleanupError(error);
    if (!retireRejectedClaim() || !await retireRejectedHelper()) {
      throw new WindowsUpdateSupervisorCleanupError(error);
    }
    throw error;
  }
  return admitted;
}

export function windowsUpdateSupervisorStagedPath(options: {
  readonly dataDirectory: string;
  readonly operationId: string;
}): string {
  return resolve(
    options.dataDirectory,
    windowsUpdateSupervisorExecutableName(options.operationId),
  );
}
