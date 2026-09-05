import type { RuntimeLifecycleDiagnosticSnapshot } from "../shared/lifecycle-diagnostics.js";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type { AppUpdateStatus } from "../shared/desktop.js";
import { appUpdatePreparationDiagnostic } from
  "../shared/app-update-preparation-diagnostic.js";
import {
  embeddedLifecycleBuildMetadata,
  type LifecycleBuildMetadata,
} from "../shared/lifecycle-build-metadata.js";
import { parseRuntimeLifecycleDiagnosticSnapshot } from "../shared/lifecycle-diagnostics.js";
import { AppUpdateHandoffJournal } from "./app-update-handoff.js";
import {
  RuntimeDiagnostics,
  type RuntimeSupportReport,
} from "./runtime-diagnostics.js";
import type { RuntimeSupervisorSnapshot } from "./runtime-supervisor.js";

export interface CopyLifecycleSupportReportInput {
  lifecycleInput: unknown;
  diagnostics: RuntimeDiagnostics;
  version: string;
  channel: "stable" | "canary";
  platform: string;
  architecture: string;
  runtime: RuntimeSupervisorSnapshot | null;
  appUpdateStatus?: AppUpdateStatus | null;
  buildMetadata?: LifecycleBuildMetadata | null;
  dataDirectory: string;
  writeClipboard(text: string): void | Promise<void>;
}

interface RegisterLifecycleSupportReportIpcInput {
  ipcMain: Pick<IpcMain, "handle">;
  channel: string;
  assertTrustedIpc(
    event: IpcMainInvokeEvent,
    suppliedArguments: number,
    expectedArguments?: number,
  ): void;
  createInput(): Omit<CopyLifecycleSupportReportInput, "lifecycleInput">;
}

function exactLifecycleProjection(
  value: unknown,
): RuntimeLifecycleDiagnosticSnapshot | null {
  if (value === null) return null;
  const parsed = parseRuntimeLifecycleDiagnosticSnapshot(value);
  if (!parsed) {
    throw new Error("The lifecycle diagnostic snapshot is invalid.");
  }
  return parsed;
}

export async function copyLifecycleSupportReport(
  input: CopyLifecycleSupportReportInput,
): Promise<Pick<RuntimeSupportReport, "eventCount"> & { copied: true }> {
  const lifecycle = exactLifecycleProjection(input.lifecycleInput);
  let updateHandoff: ReturnType<AppUpdateHandoffJournal["diagnostic"]> | null =
    null;
  try {
    updateHandoff = new AppUpdateHandoffJournal(
      input.dataDirectory,
    ).diagnostic();
  } catch {
    // Corrupt/unsafe handoff state is handled by startup admission. A support
    // report never weakens that path or copies raw journal failure details.
  }
  const report = input.diagnostics.supportReport({
    version: input.version,
    channel: input.channel,
    platform: input.platform,
    architecture: input.architecture,
    runtime: input.runtime,
    lifecycle,
    updateHandoff,
    updatePreparation: input.appUpdateStatus
      ? appUpdatePreparationDiagnostic(input.appUpdateStatus)
      : null,
    buildMetadata: input.buildMetadata === undefined
      ? embeddedLifecycleBuildMetadata()
      : input.buildMetadata,
  });
  await input.writeClipboard(report.text);
  input.diagnostics.record("report.copy");
  return { copied: true, eventCount: report.eventCount };
}

export function registerLifecycleSupportReportIpc(
  input: RegisterLifecycleSupportReportIpcInput,
): void {
  input.ipcMain.handle(input.channel, async (event, ...arguments_) => {
    input.assertTrustedIpc(event, arguments_.length, 1);
    return await copyLifecycleSupportReport({
      ...input.createInput(),
      lifecycleInput: arguments_[0],
    });
  });
}
