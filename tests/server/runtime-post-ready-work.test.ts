import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { RuntimeGenerationLeaseJournal } from
  "../../src/node/runtime-generation-leases";
import { startRuntime, type RunningRuntime } from "../../src/server";
import { RuntimeStore } from "../../src/server/database";
import { ProjectIdentityRefresher } from
  "../../src/server/project-identity-refresh";
import { TurnGitArtifactManager } from
  "../../src/server/turn-git-artifacts";
import { DuoLaunchCoordinator } from
  "../../src/server/runtime/duo/duo-launch-coordinator";

const directories: string[] = [];
const runtimes: RunningRuntime[] = [];

async function runtimePaths(): Promise<{
  dataDirectory: string;
  workspaceDirectory: string;
  runtimeGenerationId: string;
  systemBootId: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "inertia-post-ready-"));
  const dataDirectory = join(root, "data");
  const workspaceDirectory = join(root, "workspace");
  const runtimeGenerationId = `${randomUUID()}:1`;
  const systemBootId = `test:${randomUUID()}`;
  await Promise.all([mkdir(dataDirectory), mkdir(workspaceDirectory)]);
  if (process.platform !== "win32") await chmod(dataDirectory, 0o700);
  expect(new RuntimeGenerationLeaseJournal(dataDirectory).publish(
    runtimeGenerationId,
    systemBootId,
  )).toBe(true);
  directories.push(root);
  return {
    dataDirectory,
    workspaceDirectory,
    runtimeGenerationId,
    systemBootId,
  };
}

afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.close()));
  vi.restoreAllMocks();
  await Promise.allSettled(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("runtime post-ready work", () => {
  it("starts passive owned work once only after the ready hook", async () => {
    const paths = await runtimePaths();
    const startBackups = vi.spyOn(RuntimeStore.prototype, "startBackups");
    const refreshIdentities = vi.spyOn(
      ProjectIdentityRefresher.prototype,
      "refreshAll",
    ).mockResolvedValue();
    const reconcileArtifacts = vi.spyOn(
      TurnGitArtifactManager.prototype,
      "reconcile",
    ).mockResolvedValue(false);
    const resumeComparisons = vi.spyOn(
      DuoLaunchCoordinator.prototype,
      "resumeComparisons",
    ).mockResolvedValue();
    const providerRefresh = vi.fn(async () => {
      throw new Error("stop provider discovery after proving admission");
    });

    const runtime = await startRuntime({
      ...paths,
      defaultWorkspacePath: paths.workspaceDirectory,
      enableProviders: true,
      testOnlyProviderRefresh: providerRefresh,
    });
    runtimes.push(runtime);

    expect(startBackups).not.toHaveBeenCalled();
    expect(refreshIdentities).not.toHaveBeenCalled();
    expect(reconcileArtifacts).not.toHaveBeenCalled();
    expect(resumeComparisons).not.toHaveBeenCalled();
    expect(providerRefresh).not.toHaveBeenCalled();

    await runtime.startPostReadyWork();
    await vi.waitFor(() => expect(providerRefresh).toHaveBeenCalledOnce());
    expect(startBackups).toHaveBeenCalledOnce();
    expect(refreshIdentities).toHaveBeenCalledOnce();
    expect(reconcileArtifacts).toHaveBeenCalledOnce();
    expect(resumeComparisons).toHaveBeenCalledOnce();

    await runtime.startPostReadyWork();
    expect(startBackups).toHaveBeenCalledOnce();
    expect(refreshIdentities).toHaveBeenCalledOnce();
    expect(reconcileArtifacts).toHaveBeenCalledOnce();
    expect(resumeComparisons).toHaveBeenCalledOnce();
    expect(providerRefresh).toHaveBeenCalledOnce();
  });

  it("starts no passive work when shutdown wins before readiness", async () => {
    const paths = await runtimePaths();
    const startBackups = vi.spyOn(RuntimeStore.prototype, "startBackups");
    const refreshIdentities = vi.spyOn(
      ProjectIdentityRefresher.prototype,
      "refreshAll",
    ).mockResolvedValue();
    const reconcileArtifacts = vi.spyOn(
      TurnGitArtifactManager.prototype,
      "reconcile",
    ).mockResolvedValue(false);
    const resumeComparisons = vi.spyOn(
      DuoLaunchCoordinator.prototype,
      "resumeComparisons",
    ).mockResolvedValue();

    const runtime = await startRuntime({
      ...paths,
      defaultWorkspacePath: paths.workspaceDirectory,
      enableProviders: false,
    });
    await runtime.close();
    await runtime.startPostReadyWork();

    expect(startBackups).not.toHaveBeenCalled();
    expect(refreshIdentities).not.toHaveBeenCalled();
    expect(reconcileArtifacts).not.toHaveBeenCalled();
    expect(resumeComparisons).not.toHaveBeenCalled();
  });
});
