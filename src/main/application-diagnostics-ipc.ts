import { randomUUID } from "node:crypto";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { DIAGNOSTICS_IPC } from "../shared/application-diagnostics-ipc.js";
import { diagnosticQuerySchema, rendererDiagnosticSchema } from "../shared/application-diagnostics.js";
import type { RuntimeDiagnostics } from "./runtime-diagnostics.js";
import { exportDiagnosticReport } from "./diagnostic-export.js";

interface DiagnosticsIpcOptions {
  ipcMain: IpcMain;
  diagnostics: () => RuntimeDiagnostics;
  assertTrusted: (event: IpcMainInvokeEvent, received: number, expected?: number) => void;
  copyText: (text: string) => void | Promise<void>;
  chooseExportPath: () => Promise<string | null>;
  now?: () => number;
}

export function registerApplicationDiagnosticsIpc(options: DiagnosticsIpcOptions): void {
  const now = options.now ?? Date.now;
  const budgets = new WeakMap<object, { at: number; reads: number; reports: number }>();
  let exporting = false;
  const admit = (event: IpcMainInvokeEvent, argumentCount: number, report = false): void => {
    options.assertTrusted(event, argumentCount, 1);
    const time = now();
    let budget = budgets.get(event.sender);
    if (!budget || time - budget.at >= 60_000) {
      budget = { at: time, reads: 0, reports: 0 };
      budgets.set(event.sender, budget);
    }
    const key = report ? "reports" : "reads";
    if (++budget[key] > (report ? 20 : 120)) throw new Error("Diagnostics requests are temporarily rate limited.");
  };
  const query = (value: unknown) => {
    const parsed = diagnosticQuerySchema.safeParse(value);
    if (!parsed.success) throw new Error("The diagnostics filter is invalid.");
    return parsed.data;
  };
  options.ipcMain.handle(DIAGNOSTICS_IPC.query, (event, ...args) => {
    admit(event, args.length);
    return options.diagnostics().queryIncidents(query(args[0]));
  });
  options.ipcMain.handle(DIAGNOSTICS_IPC.copy, async (event, ...args) => {
    admit(event, args.length);
    const filter = query(args[0]);
    const diagnostics = options.diagnostics();
    const text = diagnostics.exportIncidents(filter);
    await options.copyText(text);
    return { copied: true, count: diagnostics.queryIncidents(filter).total };
  });
  options.ipcMain.handle(DIAGNOSTICS_IPC.export, async (event, ...args) => {
    admit(event, args.length);
    const report = options.diagnostics().exportIncidents(query(args[0]));
    if (exporting) throw new Error("A diagnostics export is already open.");
    exporting = true;
    try { return await exportDiagnosticReport(report, options.chooseExportPath); }
    catch { throw new Error("Diagnostics could not be saved. Choose a writable regular file and try again."); }
    finally { exporting = false; }
  });
  options.ipcMain.handle(DIAGNOSTICS_IPC.reportValidation, (event, ...args) => {
    admit(event, args.length, true);
    const parsed = rendererDiagnosticSchema.safeParse(args[0]);
    if (!parsed.success) throw new Error("The validation diagnostic is invalid.");
    const input = parsed.data;
    const record = options.diagnostics().recordIncident({
      schemaVersion: 1, id: randomUUID(), correlationId: input.correlationId,
      code: input.code, at: new Date(now()).toISOString(), runtimeGeneration: null,
      outcome: "not-started", context: input.context ?? {}, metadata: {},
    });
    return record ? { incidentId: record.id } : null;
  });
}
