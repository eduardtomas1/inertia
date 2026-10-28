import { readFileSync } from "node:fs";

import type {
  RuntimeOwnedProcessDiagnostic,
  RuntimeOwnedProcessFault,
} from "./runtime-owned-process-diagnostic.js";
import type { LinuxGuardianMonitorFailure } from "./runtime-owned-process-linux.js";

const MAX_INSPECTED_GUARDIAN_CHILDREN = 256;

export function linuxAdmissionFailureTaintsRegistry(
  stage: RuntimeOwnedProcessDiagnostic["stage"],
): boolean {
  return stage === "linux-durable-claim" || stage === "linux-durable-authorization";
}

export function linuxAdmissionFault(
  diagnostic: RuntimeOwnedProcessDiagnostic,
): RuntimeOwnedProcessFault {
  return {
    kind: diagnostic.stage === "linux-stop" ? "quarantined" : "admission-rejected",
    diagnostic,
  };
}

export function linuxGuardianHasRootDescendant(pid: number, procRoot = "/proc"): boolean {
  let children: string[];
  try {
    children = readFileSync(`${procRoot}/${pid}/task/${pid}/children`, "utf8")
      .trim().split(/\s+/u).filter((child) => /^[1-9][0-9]*$/u.test(child))
      .slice(0, MAX_INSPECTED_GUARDIAN_CHILDREN);
  } catch {
    return false;
  }
  return children.some((child) => {
    try {
      const uid = readFileSync(`${procRoot}/${child}/status`, "utf8")
        .match(/^Uid:\s+(\d+)/mu)?.[1];
      return uid === "0";
    } catch {
      return false;
    }
  });
}

export function linuxMonitorFault(
  reason: LinuxGuardianMonitorFailure,
  guardianPid: number,
  diagnostic: RuntimeOwnedProcessDiagnostic,
  procRoot = "/proc",
): RuntimeOwnedProcessFault {
  return {
    kind: reason === "bad-terminal" && linuxGuardianHasRootDescendant(guardianPid, procRoot)
      ? "root-descendant"
      : "quarantined",
    diagnostic,
  };
}

export function reportRuntimeOwnedProcessFault(
  registry: { readonly onProcessFault: (fault: RuntimeOwnedProcessFault) => void },
  fault: RuntimeOwnedProcessFault,
): void {
  try { registry.onProcessFault(fault); } catch {
    return;
  }
}
