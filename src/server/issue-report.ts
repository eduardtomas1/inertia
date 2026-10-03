import { randomUUID } from "node:crypto";
import { INERTIA_VERSION } from "../shared/version";
import { parseRuntimeLifecycleDiagnosticSnapshot, type RuntimeLifecycleDiagnosticSnapshot } from "../shared/lifecycle-diagnostics";
import { issueReportSchema, scrubReportText, REPORT_BODY_LIMIT, type IssueReport, type IssueReportInput } from "../shared/issue-report";
import type { AppSnapshot, ProviderInfo } from "../shared/contracts";
import type { IssueHostEvidence } from "../node/runtime-issue-evidence-protocol";
import { RuntimeRequestError } from "./runtime-errors";

export interface IssueEvidenceContext {
  snapshot: AppSnapshot;
  providers: readonly ProviderInfo[];
  host: IssueHostEvidence | null;
  platform?: NodeJS.Platform;
  architecture?: string;
  electron?: string;
}

const SAFE_VERSION = /^v?[0-9][0-9A-Za-z.+_-]{0,63}$/u;
const OS_NAMES: Partial<Record<NodeJS.Platform, string>> = { darwin: "macOS", win32: "Windows", linux: "Linux" };

function lifecycleLine(lifecycle: RuntimeLifecycleDiagnosticSnapshot | null): string {
  if (!lifecycle) return "unavailable";
  const resources = Object.entries(lifecycle.ownedResources).filter(([, count]) => count > 0).map(([name, count]) => `${name} ${count}`);
  const maintenance = lifecycle.providerMaintenance.filter(({ state }) => state !== "idle").map(({ providerId, state }) => `${providerId} ${state}`);
  const cleanup = (lifecycle.windowsCleanupFailures ?? []).map(({ phase, scope, exitCode }) => `${phase}:${scope}:${exitCode ?? "none"}`);
  return [
    lifecycle.actionableState,
    `blockers ${lifecycle.startupBlockerCodes.join(", ") || "none"}`,
    `quarantine ${lifecycle.quarantineReason ?? "none"}`,
    `cleanup ${lifecycle.cleanupProofMethod}`,
    `owned resources ${resources.join(", ") || "none"}`,
    `unresolved turns ${lifecycle.unresolvedTurnCount}, interactions ${lifecycle.unresolvedInteractionCount}`,
    ...(maintenance.length > 0 ? [`maintenance ${maintenance.join(", ")}`] : []),
    ...(cleanup.length > 0 ? [`windows cleanup ${cleanup.join(", ")}`] : []),
  ].join(" · ");
}

function providerLine(input: IssueReportInput, context: IssueEvidenceContext, lifecycle: RuntimeLifecycleDiagnosticSnapshot | null): string {
  if (!input.providerId) return "not specified";
  const active = lifecycle?.activeProviders.find(({ providerId }) => providerId === input.providerId);
  if (active) return `${input.providerId} (${active.harnessId} ${active.version ?? "version unknown"})`;
  const version = context.providers.find(({ id }) => id === input.providerId)?.version?.trim();
  return `${input.providerId} ${version && SAFE_VERSION.test(version) ? version : "version unknown"}`;
}

export function collectIssueEnvironment(input: IssueReportInput, context: IssueEvidenceContext): string {
  const lifecycle = parseRuntimeLifecycleDiagnosticSnapshot(context.snapshot.lifecycleDiagnostics);
  const platform = context.platform ?? process.platform;
  const architecture = context.architecture ?? process.arch;
  const electron = context.electron ?? process.versions.electron;
  return [
    `- Inertia: ${INERTIA_VERSION} (${context.host?.channel ?? "channel unknown"})`,
    `- OS: ${OS_NAMES[platform] ?? "other"} ${context.host?.osVersion ?? "version unknown"} (${["arm64", "x64", "ia32"].includes(architecture) ? architecture : "other"})`,
    `- Electron: ${electron && SAFE_VERSION.test(electron) ? electron : "unknown"}`,
    `- Provider: ${providerLine(input, context, lifecycle)}`,
    `- Lifecycle: ${lifecycleLine(lifecycle)}`,
  ].join("\n");
}

function diagnosticsSection(attach: boolean, host: IssueHostEvidence | null): string {
  if (!attach) return "Not attached.";
  if (!host) return "Diagnostics could not be collected.";
  if (!host.diagnostics) return "No diagnostics were recorded in the last 24 hours.";
  return ["Recent diagnostics from the last 24 hours, pseudonymised by Inertia:", "```text", host.diagnostics.replace(/`{3,}/gu, "'''"), "```"].join("\n");
}

export function reportBody(input: IssueReportInput, context: IssueEvidenceContext): string {
  return [
    "## What happened", scrubReportText(input.description),
    "## Steps to reproduce", scrubReportText(input.steps) || "Not provided.",
    "## Environment", collectIssueEnvironment(input, context),
    "## Diagnostics", diagnosticsSection(input.attachDiagnostics, context.host),
  ].join("\n\n");
}

export function newIssueReport(input: IssueReportInput, context: IssueEvidenceContext): IssueReport {
  return issueReportSchema.parse({
    id: randomUUID(), revision: 0, status: "preview",
    description: scrubReportText(input.description), steps: scrubReportText(input.steps),
    providerId: input.providerId, attachDiagnostics: input.attachDiagnostics,
    title: scrubReportText(input.description.trim().split("\n")[0]!, 120),
    body: scrubReportText(reportBody(input, context), REPORT_BODY_LIMIT),
    notice: "", issueUrl: null,
  });
}

export function editReport(report: IssueReport, title: string, body: string): IssueReport {
  const nextTitle = scrubReportText(title, 200);
  const nextBody = scrubReportText(body, REPORT_BODY_LIMIT);
  if (nextTitle.length < 3 || nextBody.length < 10) throw new RuntimeRequestError("Add a title and a useful problem description.");
  return { ...report, revision: report.revision + 1, title: nextTitle, body: nextBody, status: "preview", notice: nextTitle !== title.trim() || nextBody !== body.trim() ? "Potential private information was removed. Review the issue before creating it." : "" };
}
