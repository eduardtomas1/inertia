// @inertia-test-suite portable
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { prepareProviderAuthLaunch } from "../../src/server/provider/auth-launch";
import { probeKimiAuthentication } from "../../src/server/provider/kimi-auth-probe";
import { ProviderManagerInstallationAuthority } from "../../src/server/provider/provider-manager-installation";
import { ProviderInstallationLeaseCoordinator } from "../../src/server/provider/installation-lease";
import { ProviderMetadataCache } from "../../src/server/provider/metadata";
import { ProcessTreeTerminationError } from "../../src/server/process-lifecycle";

vi.mock("../../src/server/provider/kimi-auth-probe", () => ({ probeKimiAuthentication: vi.fn() }));

const roots: string[] = [];
afterEach(() => { vi.resetAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "inertia-auth-handoff-"));
  roots.push(cwd);
  const executable = join(cwd, "selected-kimi");
  writeFileSync(executable, "synthetic installed identity");
  const leases = new ProviderInstallationLeaseCoordinator();
  const invalidateEvidence = vi.fn();
  const authority = new ProviderManagerInstallationAuthority({
    leases, metadataCache: new ProviderMetadataCache(),
    configuredBoundary: () => executable, operationId: () => "selected-login",
    invalidateEvidence,
  });
  const controller = new AbortController();
  const options = {
    providerId: "kimi" as const, executable, cwd,
    environment: { PATH: "/synthetic/bin", KIMI_CODE_HOME: cwd, INERTIA_HOST_CONTROL_SECRET: "never-forward" },
    signal: controller.signal, installationAuthority: authority,
  };
  return { cwd, executable, leases, authority, invalidateEvidence, controller, options };
}

it("keeps the selected installation leased through negotiation and exact terminal handoff", async () => {
  const f = fixture();
  vi.mocked(probeKimiAuthentication).mockImplementationOnce(async (executable, cwd, environment, signal) => {
    expect(f.leases.hasProviderAuthority("kimi")).toBe(true);
    expect({ executable, cwd, signal }).toEqual({ executable: f.executable, cwd: f.cwd, signal: f.controller.signal });
    expect(environment).toEqual({ PATH: "/synthetic/bin", KIMI_CODE_HOME: f.cwd });
    return { type: "terminal", id: "login", name: "Sign in", args: ["--login"], env: { KIMI_CODE_HOME: f.cwd } };
  });
  const launch = await prepareProviderAuthLaunch(f.options);
  expect(launch).toMatchObject({
    executable: f.executable, args: ["acp", "--login"],
    env: { PATH: "/synthetic/bin", KIMI_CODE_HOME: f.cwd },
  });
  expect(launch.env).not.toHaveProperty("INERTIA_HOST_CONTROL_SECRET");
  expect(f.leases.hasProviderAuthority("kimi")).toBe(true);
  const terminalOwner = launch.installationUse.accept();
  expect(terminalOwner).not.toBeNull();
  expect(launch.installationUse.accept()).toBeNull();
  expect(launch.installationUse.abandonBeforeSpawn()).toBe(false);
  expect(terminalOwner!.release({ cleanupConfirmed: true })).toBe(true);
  expect(terminalOwner!.release({ cleanupConfirmed: true })).toBe(false);
  expect(f.leases.hasProviderAuthority("kimi")).toBe(false);
});

it.each(["malformed", "cancelled"])("releases a confirmed stopped probe without spawning after %s preparation", async (scenario) => {
  const f = fixture();
  vi.mocked(probeKimiAuthentication).mockImplementationOnce(async () => {
    if (scenario === "malformed") throw new Error("Invalid terminal authentication descriptor");
    f.controller.abort();
    return { type: "terminal", id: "login", name: "Sign in", args: ["--login"], env: {} };
  });
  await expect(prepareProviderAuthLaunch(f.options)).rejects.toThrow();
  expect(f.leases.hasProviderAuthority("kimi")).toBe(false);
  expect(f.authority.uncertain).toBe(false);
});

it("quarantines unconfirmed cleanup instead of offering a terminal descriptor", async () => {
  const f = fixture();
  vi.mocked(probeKimiAuthentication).mockRejectedValueOnce(new ProcessTreeTerminationError("Synthetic auth probe"));
  await expect(prepareProviderAuthLaunch(f.options)).rejects.toMatchObject({ code: "process-tree-termination-unconfirmed" });
  expect(f.leases.hasProviderAuthority("kimi")).toBe(true);
  expect(f.authority.uncertain).toBe(true);
  expect(f.invalidateEvidence).toHaveBeenCalledWith("kimi");
});

it("refuses replacement of the exact installation during authentication negotiation", async () => {
  const f = fixture();
  vi.mocked(probeKimiAuthentication).mockImplementationOnce(async () => {
    writeFileSync(f.executable, "different installed executable identity and length");
    return { type: "terminal", id: "login", name: "Sign in", args: ["--login"], env: {} };
  });
  await expect(prepareProviderAuthLaunch(f.options)).rejects.toThrow("installation changed");
  expect(f.leases.hasProviderAuthority("kimi")).toBe(true);
  expect(f.authority.uncertain).toBe(true);
});

it.each(["codex", "claude"] as const)("preserves %s sign-in without an ACP probe", async (providerId) => {
  const f = fixture();
  const launch = await prepareProviderAuthLaunch({ ...f.options, providerId });
  expect(launch.args).toEqual(providerId === "claude" ? ["auth", "login"] : ["login"]);
  expect(probeKimiAuthentication).not.toHaveBeenCalled();
  expect(launch.installationUse.abandonBeforeSpawn()).toBe(true);
  expect(f.leases.hasProviderAuthority(providerId)).toBe(false);
});
