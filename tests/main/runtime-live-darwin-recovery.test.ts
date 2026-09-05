import type { BrowserWindow } from "electron";
import { describe, expect, it, vi } from "vitest";

import { RuntimeLiveDarwinRecoveryCoordinator } from
  "../../src/main/runtime-live-darwin-recovery";
import type { RuntimeSupervisor } from "../../src/main/runtime-supervisor";
import type { RuntimeSupervisorSnapshot } from
  "../../src/main/runtime-supervisor-types";

const stoppedSnapshot: RuntimeSupervisorSnapshot = {
  phase: "stopped",
  generation: 4,
  pid: null,
  websocketUrl: null,
  runtimeGenerationHash: null,
  restartAttempt: 2,
  restartScheduled: false,
  lastError: "cleanup unconfirmed",
  startupBlockerCode: "prior-runtime-cleanup-unconfirmed",
};
const descriptor = {
  operationId: "00000000-0000-4000-8000-000000000001",
  snapshotDigest: "a".repeat(64),
  runtimeGenerationIds: [
    "30000000-0000-4000-8000-000000000003:4",
  ],
} as const;
const window = { isDestroyed: () => false } as BrowserWindow;

describe("RuntimeLiveDarwinRecoveryCoordinator", () => {
  it("offers one exact recovery decision and resumes the blocked supervisor", async () => {
    const prompt = vi.fn(async () => descriptor);
    const resumeWithModernDarwinRecovery = vi.fn(() => true);
    const supervisor = {
      canResumeWithModernDarwinRecovery: () => true,
      resumeWithModernDarwinRecovery,
    } as unknown as RuntimeSupervisor;
    const coordinator = new RuntimeLiveDarwinRecoveryCoordinator({
      dataDirectory: "/tmp/inertia-test-data",
      systemBootId: "test:00000000-0000-4000-8000-000000000001",
      guardianPath: "/tmp/runtime-process-guardian",
      getWindow: () => window,
      platform: "darwin",
      prompt,
    });

    coordinator.observe(stoppedSnapshot, supervisor);
    coordinator.observe(stoppedSnapshot, supervisor);
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));

    expect(prompt).toHaveBeenCalledWith(
      "/tmp/inertia-test-data",
      "test:00000000-0000-4000-8000-000000000001",
      "/tmp/runtime-process-guardian",
      window,
    );
    expect(resumeWithModernDarwinRecovery).toHaveBeenCalledWith(descriptor);
  });

  it("does not offer recovery outside an eligible macOS safety lock", () => {
    const prompt = vi.fn(async () => descriptor);
    const supervisor = {
      canResumeWithModernDarwinRecovery: () => false,
      resumeWithModernDarwinRecovery: vi.fn(),
    } as unknown as RuntimeSupervisor;
    const coordinator = new RuntimeLiveDarwinRecoveryCoordinator({
      dataDirectory: "/tmp/inertia-test-data",
      systemBootId: "test:00000000-0000-4000-8000-000000000001",
      guardianPath: "/tmp/runtime-process-guardian",
      getWindow: () => window,
      platform: "linux",
      prompt,
    });

    coordinator.observe(stoppedSnapshot, supervisor);

    expect(prompt).not.toHaveBeenCalled();
  });

  it("defers a missing or destroyed parent without consuming the generation decision", async () => {
    const prompt = vi.fn(async () => null);
    const resume = vi.fn();
    const supervisor = {
      canResumeWithModernDarwinRecovery: () => true,
      resumeWithModernDarwinRecovery: resume,
    } as unknown as RuntimeSupervisor;
    let parent: BrowserWindow | null = null;
    const coordinator = new RuntimeLiveDarwinRecoveryCoordinator({
      dataDirectory: "/tmp/inertia-test-data",
      systemBootId: "test:boot",
      guardianPath: "/tmp/runtime-process-guardian",
      getWindow: () => parent,
      platform: "darwin",
      prompt,
    });
    coordinator.observe(stoppedSnapshot, supervisor);
    parent = { isDestroyed: () => true } as BrowserWindow;
    coordinator.observe(stoppedSnapshot, supervisor);
    expect(prompt).not.toHaveBeenCalled();
    parent = window;
    coordinator.observe(stoppedSnapshot, supervisor);
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
    expect(resume).not.toHaveBeenCalled();
    coordinator.observe(stoppedSnapshot, supervisor);
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("does not resume if the parent closes before a pending decision settles", async () => {
    let destroyed = false;
    const prompt = vi.fn(async () => { destroyed = true; return descriptor; });
    const resume = vi.fn();
    const supervisor = {
      canResumeWithModernDarwinRecovery: () => true,
      resumeWithModernDarwinRecovery: resume,
    } as unknown as RuntimeSupervisor;
    const coordinator = new RuntimeLiveDarwinRecoveryCoordinator({
      dataDirectory: "/tmp/inertia-test-data",
      systemBootId: "test:boot",
      guardianPath: "/tmp/runtime-process-guardian",
      getWindow: () => ({ isDestroyed: () => destroyed }) as BrowserWindow,
      platform: "darwin",
      prompt,
    });
    coordinator.observe(stoppedSnapshot, supervisor);
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
    expect(resume).not.toHaveBeenCalled();
  });
});
