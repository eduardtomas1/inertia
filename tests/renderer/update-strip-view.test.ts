import { describe, expect, it } from "vitest";
import type { ProviderMaintenanceOperation, ProviderMaintenanceProviderId } from "../../src/shared/contracts";
import { formatUpdateElapsed, updateStripView, type UpdateStripInput } from "../../src/renderer/src/components/sidebar/updateStripView";
import type { UpdateEverythingOutcome } from "../../src/renderer/src/utils/updateEverythingRun";
import { updateStatus } from "../support/app-update-fixture";

const NOW = Date.parse("2030-01-01T12:00:00.000Z");
const LABELS: Record<string, string> = { codex: "Codex", claude: "Claude Code", cursor: "Cursor" };
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
function operation(providerId: ProviderMaintenanceProviderId, status: ProviderMaintenanceOperation["status"], extra: Partial<ProviderMaintenanceOperation> = {}): ProviderMaintenanceOperation {
  return { id: `${providerId}-op`, providerId, status, startedAt: at(-30_000), finishedAt: null, beforeVersion: "1.0.0", afterVersion: null,
    targetVersion: "1.1.0", message: "", output: null, outputTruncated: false, ...extra };
}
function input(overrides: Partial<UpdateStripInput> = {}): UpdateStripInput {
  return { phase: null, activeRun: null, outcome: null, operations: new Map(), appStatus: updateStatus({ state: "current" }),
    label: (providerId) => LABELS[providerId] ?? providerId, now: NOW, watermark: NOW - 60 * 60_000, dismissed: new Set(),
    downloadedVersion: null, ...overrides };
}
function ops(...list: ProviderMaintenanceOperation[]): Map<ProviderMaintenanceProviderId, ProviderMaintenanceOperation> {
  return new Map(list.map((entry) => [entry.providerId, entry]));
}
function outcome(providers: UpdateEverythingOutcome["providers"], app: UpdateEverythingOutcome["app"] = "not-included", appMessage: string | null = null): UpdateEverythingOutcome {
  return { startedAt: NOW - 120_000, providers, app, appMessage, error: null };
}
const result = (providerId: ProviderMaintenanceProviderId, outcomeKind: "updated" | "unchanged" | "failed" | "skipped", afterVersion: string | null = null, error: string | null = null) =>
  ({ providerId, outcome: outcomeKind, beforeVersion: "1.0.0", afterVersion, error });

describe("update strip while work is running", () => {
  it("shows nothing when nothing is moving or newly finished", () => {
    expect(updateStripView(input())).toBeNull();
    expect(updateStripView(input({ appStatus: updateStatus({ state: "checking" }) }))).toBeNull();
  });
  it("follows the app download with a determinate fill and an Inertia row inside a run", () => {
    const view = updateStripView(input({ phase: { kind: "download" }, activeRun: { startedAt: NOW, includeApp: true, providerIds: ["codex"] },
      appStatus: updateStatus({ state: "downloading", latestVersion: "0.0.78", progress: { percent: 42.4, transferredBytes: 1, totalBytes: 2, bytesPerSecond: 1 } }) }));
    expect(view).toMatchObject({ active: true, tone: "loading", icon: "download", title: "Downloading Inertia 0.0.78…", meta: "42%", progress: 0.42 });
    expect(view?.items.map(({ label, status }) => [label, status])).toEqual([["Inertia", "Downloading · 42%"], ["Codex", "Queued"]]);
  });
  it("names the provider being updated and counts the run's finished providers", () => {
    const run = { startedAt: NOW - 60_000, includeApp: false, providerIds: ["codex", "claude", "cursor"] as ProviderMaintenanceProviderId[] };
    const view = updateStripView(input({ phase: { kind: "providers", providerIds: run.providerIds }, activeRun: run, operations: ops(
      operation("codex", "succeeded", { finishedAt: at(-10_000), afterVersion: "1.1.0" }),
      operation("claude", "running", { startedAt: at(-50_000) }),
      operation("cursor", "succeeded", { finishedAt: at(-24 * 60 * 60_000) }),
    ) }));
    expect(view).toMatchObject({ title: "Updating Claude Code…", meta: "1 of 3", slow: false, icon: "loading" });
    expect(view?.items.map(({ status }) => status)).toEqual(["Updated to 1.1.0", "Updating · <1m", "Queued"]);
  });
  it("turns the counter into elapsed time in warning once a provider takes three minutes", () => {
    const view = updateStripView(input({ operations: ops(operation("codex", "running", { startedAt: at(-4 * 60_000) })) }));
    expect(view).toMatchObject({ title: "Updating Codex…", meta: "4m", slow: true });
  });
  it("prepares the restart without a spinner icon", () => {
    expect(updateStripView(input({ phase: { kind: "app" } }))).toMatchObject({ icon: "restart", title: "Preparing Inertia to restart…" });
  });
});

describe("update strip results", () => {
  it.each([
    [[result("codex", "updated", "1.1.0")], "success", "Codex updated to 1.1.0"],
    [[result("codex", "updated"), result("claude", "updated")], "success", "Codex and Claude Code updated"],
    [[result("codex", "updated"), result("claude", "updated"), result("cursor", "updated")], "success", "3 providers updated"],
    [[result("codex", "unchanged"), result("claude", "updated")], "warning", "Codex still needs an update"],
    [[result("codex", "failed", null, "npm exited 1"), result("claude", "unchanged")], "error", "Codex update failed"],
    [[result("codex", "failed"), result("claude", "failed")], "error", "2 provider updates failed"],
  ] as const)("lets the worst outcome of a run win: %#", (providers, tone, title) => {
    const view = updateStripView(input({ outcome: outcome([...providers]) }));
    expect(view).toMatchObject({ active: false, tone, title, autoDismiss: tone === "success", dismissible: tone !== "success" });
  });
  it("keeps a provider's failure reason for the details", () => {
    const view = updateStripView(input({ outcome: outcome([result("codex", "failed", null, "npm exited 1")]) }));
    expect(view?.items).toEqual([{ id: "codex", label: "Codex", status: "Failed", detail: "npm exited 1", failed: true }]);
  });
  it.each([
    ["threw", "The local service stopped.", "error", "Update couldn’t finish"],
    ["download-failed", "Offline.", "error", "Inertia download failed"],
    ["restart-refused", "Finish active agent work before restarting to update.", "warning", "Inertia is ready to restart"],
  ] as const)("reports the app part of a run: %s", (app, message, tone, title) => {
    expect(updateStripView(input({ outcome: outcome([result("codex", "updated")], app, message) }))).toMatchObject({ tone, title });
  });
  it("stays quiet when a run only skipped providers", () => {
    expect(updateStripView(input({ outcome: outcome([result("codex", "skipped")]) }))).toBeNull();
  });
  it("reports provider updates started outside a run, but never ones that finished before Inertia opened", () => {
    const finished = operation("codex", "succeeded", { finishedAt: at(-5_000), afterVersion: "1.1.0" });
    expect(updateStripView(input({ operations: ops(finished) }))).toMatchObject({ tone: "success", title: "Codex updated to 1.1.0" });
    expect(updateStripView(input({ operations: ops(finished), watermark: NOW }))).toBeNull();
    expect(updateStripView(input({ operations: ops(operation("codex", "cancelled", { finishedAt: at(-5_000) })) }))).toBeNull();
  });
  it("does not repeat a run's providers as separate results", () => {
    const view = updateStripView(input({ outcome: outcome([result("codex", "updated", "1.1.0")]),
      operations: ops(operation("codex", "succeeded", { finishedAt: at(-60_000), afterVersion: "1.1.0" })), dismissed: new Set([`result:${NOW - 120_000}`]) }));
    expect(view).toBeNull();
  });
  it("honours dismissals per result and shows the next one", () => {
    const failed = operation("codex", "failed", { finishedAt: at(-5_000), message: "denied" });
    const first = updateStripView(input({ operations: ops(failed) }))!;
    const dismissed = new Set([first.key, ...first.key.split("|")]);
    expect(updateStripView(input({ operations: ops(failed), dismissed }))).toBeNull();
    const again = { ...failed, id: "codex-op-2", finishedAt: at(-1_000) };
    expect(updateStripView(input({ operations: ops(again), dismissed }))).toMatchObject({ tone: "error", title: "Codex update failed" });
  });
  it("offers a restart once a download the user started has finished", () => {
    const appStatus = updateStatus({ state: "downloaded", latestVersion: "0.0.78" });
    expect(updateStripView(input({ appStatus, downloadedVersion: "0.0.78" }))).toMatchObject({
      tone: "success", title: "Inertia 0.0.78 downloaded", action: "restart", autoDismiss: true });
    expect(updateStripView(input({ appStatus }))).toBeNull();
  });
  it("formats elapsed time compactly", () => {
    expect([30_000, 61_000, 59 * 60_000, 75 * 60_000].map(formatUpdateElapsed)).toEqual(["<1m", "1m", "59m", "1h 15m"]);
  });
});
