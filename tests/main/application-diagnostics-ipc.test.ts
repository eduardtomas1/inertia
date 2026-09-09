import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeDiagnostics } from "../../src/main/runtime-diagnostics";
import { registerApplicationDiagnosticsIpc } from "../../src/main/application-diagnostics-ipc";
import { registerInertiaReleaseIpc } from "../../src/main/inertia-release-ipc";
import { registerCredentialVaultIpc } from "../../src/main/credential-vault-ipc";
import { DIAGNOSTICS_IPC } from "../../src/shared/application-diagnostics-ipc";
import { DISCORD_RELEASE_WEBHOOK_PROFILE_ID } from "../../src/shared/backend-credentials";

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status });
const releases = [
  { tag_name: "v2", created_at: "2026-01-02T00:00:00Z", body: "Actual published notes" },
  { tag_name: "v1", created_at: "2026-01-01T00:00:00Z" },
];

function harness() {
  const root = mkdtempSync(join(tmpdir(), "inertia-incidents-ipc-")); directories.push(root);
  const diagnostics = new RuntimeDiagnostics(join(root, "logs"));
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  const ipcMain = { handle: (name: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => handlers.set(name, handler) } as unknown as IpcMain;
  const sender = {};
  const event = { sender } as IpcMainInvokeEvent;
  const assertTrusted = (received: IpcMainInvokeEvent, length: number, expected = 1): void => {
    if (received.sender !== sender || length !== expected) throw new Error("Unauthorized IPC sender");
  };
  const copyText = vi.fn();
  const chooseExportPath = vi.fn(async (): Promise<string | null> => join(root, "export.json"));
  registerApplicationDiagnosticsIpc({ ipcMain, diagnostics: () => diagnostics, assertTrusted, copyText, chooseExportPath });
  const invoke = (name: string, input: unknown) => handlers.get(name)!(event, input);
  return { root, diagnostics, ipcMain, event, handlers, assertTrusted, copyText, chooseExportPath, invoke };
}

describe("offline diagnostics IPC", () => {
  it("rejects unauthorized senders and secret-bearing validation/filter payloads before storage or clipboard", async () => {
    const h = harness();
    for (const channel of Object.values(DIAGNOSTICS_IPC).filter((name) => name !== DIAGNOSTICS_IPC.changed)) {
      await expect(async () => await h.handlers.get(channel)!({ sender: {} } as IpcMainInvokeEvent, {})).rejects.toThrow("Unauthorized");
    }
    expect(() => h.invoke(DIAGNOSTICS_IPC.reportValidation, {
      code: "discord.webhook-missing", correlationId: randomUUID(), prompt: "NEVER_PERSIST",
    })).toThrow("invalid");
    expect(() => h.invoke(DIAGNOSTICS_IPC.reportValidation, {
      code: "runtime.exited", correlationId: randomUUID(),
    })).toThrow("invalid");
    await expect(h.invoke(DIAGNOSTICS_IPC.export, { secret: "NEVER_EXPORT" })).rejects.toThrow("invalid");
    expect(h.diagnostics.queryIncidents({}).total).toBe(0);
    expect(h.copyText).not.toHaveBeenCalled();
    expect(h.chooseExportPath).not.toHaveBeenCalled();
  });

  it("persists a renderer validation failure, copies/exports it offline, and limits sender reports", async () => {
    const h = harness();
    const correlationId = randomUUID();
    const result = h.invoke(DIAGNOSTICS_IPC.reportValidation, { code: "discord.repository-missing", correlationId }) as { incidentId: string };
    h.diagnostics.flushIncidents();
    expect(h.invoke(DIAGNOSTICS_IPC.query, {})).toMatchObject({ runtime: "unavailable", total: 1 });
    await h.invoke(DIAGNOSTICS_IPC.copy, { incidentId: result.incidentId });
    expect(h.copyText).toHaveBeenCalledOnce();
    expect(h.copyText.mock.calls[0]![0]).toContain("discord.repository-missing");
    expect(h.copyText.mock.calls[0]![0]).not.toContain(correlationId);
    await expect(h.invoke(DIAGNOSTICS_IPC.export, { incidentId: result.incidentId })).resolves.toEqual({ status: "exported" });
    const exported = readFileSync(join(h.root, "export.json"), "utf8");
    expect(exported).toContain("discord.repository-missing");
    expect(exported).not.toContain(correlationId);
    h.chooseExportPath.mockResolvedValueOnce(null);
    await expect(h.invoke(DIAGNOSTICS_IPC.export, {})).resolves.toEqual({ status: "cancelled" });
    for (let i = 0; i < 19; i++) h.invoke(DIAGNOSTICS_IPC.reportValidation, { code: "discord.repository-missing", correlationId: randomUUID() });
    expect(() => h.invoke(DIAGNOSTICS_IPC.reportValidation, { code: "discord.repository-missing", correlationId: randomUUID() })).toThrow("rate limited");
    h.diagnostics.flushIncidents();
  });
});

describe("Discord failure-to-diagnostics integration", () => {
  it("captures returned vault unavailability once and records recovery without exposing storage errors", async () => {
    const h = harness(); let available = false;
    registerCredentialVaultIpc(h.ipcMain, () => ({
      setForProfile: async () => null, clearForProfile: async () => null,
      stateForProfile: async () => ({ profileId: DISCORD_RELEASE_WEBHOOK_PROFILE_ID, hasSecret: false,
        storage: { available, provider: "unavailable", message: "PRIVATE_VAULT_ERROR" } }),
    }), h.assertTrusted, (incident) => h.diagnostics.recordIncident(incident));
    const request = { profileId: DISCORD_RELEASE_WEBHOOK_PROFILE_ID };
    const first = await h.invoke("inertia:get-backend-credential-state", request) as { diagnosticId: string };
    expect(first.diagnosticId).toBeTruthy();
    expect(await h.invoke("inertia:get-backend-credential-state", request)).toMatchObject({ diagnosticId: first.diagnosticId });
    expect(h.diagnostics.queryIncidents({}).records[0]?.occurrences).toBe(1);
    available = true;
    await h.invoke("inertia:get-backend-credential-state", request);
    expect(h.diagnostics.queryIncidents({}).records[0]).toMatchObject({ id: first.diagnosticId, outcome: "recovered" });
    h.diagnostics.flushIncidents();
    expect(h.diagnostics.exportIncidents({})).not.toContain("PRIVATE_VAULT_ERROR");
  });
  it.each([
    ["fetch", "discord.release-fetch-failed", "not-started"],
    ["vault", "discord.credential-unavailable", "not-started"],
    ["missing", "discord.webhook-missing", "not-started"],
    ["reject", "discord.delivery-rejected", "failed"],
    ["timeout", "discord.delivery-unknown", "unknown"],
  ] as const)("records %s failures without persisting secrets and never retries POST", async (stage, code, outcome) => {
    const h = harness();
    const secret = "https://discord.com/api/webhooks/123/NEVER_PERSIST";
    const posts = vi.fn();
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      if (stage === "fetch") throw new Error(`provider body ${secret}`);
      if (String(input).includes("/releases?")) return json(releases);
      if (String(input).includes("/compare/")) return json({ commits: [] });
      posts();
      expect(new URL(String(input)).searchParams.get("wait")).toBe("true");
      expect(init?.redirect).toBe("error");
      if (stage === "timeout") throw new Error(`transport body ${secret}`);
      return json({ message: secret }, 403);
    });
    registerInertiaReleaseIpc(h.ipcMain, fetch, () => ({ resolve: async () => {
      if (stage === "vault") throw new Error(secret);
      return stage === "missing" ? null : secret;
    } }), h.assertTrusted, (incident) => h.diagnostics.recordIncident(incident));
    const result = await h.invoke("inertia:send-discord-release-info", { repositoryUrl: "https://github.com/example/project" }) as { incidentId: string };
    expect(result).toMatchObject({ sent: false, code, incidentId: expect.any(String) });
    h.diagnostics.flushIncidents();
    const record = h.diagnostics.queryIncidents({ incidentId: result.incidentId }).records[0];
    expect(record).toMatchObject({ code, outcome, occurrences: 1 });
    if (stage === "reject") expect(record?.metadata.httpStatus).toBe(403);
    expect(posts).toHaveBeenCalledTimes(stage === "reject" || stage === "timeout" ? 1 : 0);
    const disk = readFileSync(join(h.root, "logs", "runtime.log"), "utf8");
    const exported = h.diagnostics.exportIncidents({});
    for (const output of [JSON.stringify(result), JSON.stringify(record), disk, exported]) {
      expect(output).not.toContain("NEVER_PERSIST"); expect(output).not.toContain("api/webhooks");
    }
    const restarted = new RuntimeDiagnostics(join(h.root, "logs"));
    expect(restarted.queryIncidents({}).records[0]?.id).toBe(result.incidentId);
    expect(restarted.queryIncidents({}).runtime).toBe("unavailable");
  });

  it("records credential write failures at the vault boundary, with a safe link but no raw secret", async () => {
    const h = harness();
    registerCredentialVaultIpc(h.ipcMain, () => ({
      setForProfile: async () => { throw new Error("PRIVATE_WEBHOOK_CONTENT"); },
      clearForProfile: async () => null, stateForProfile: async () => null,
    }), h.assertTrusted, (incident) => h.diagnostics.recordIncident(incident));
    await expect(h.invoke("inertia:set-backend-credential", {
      profileId: DISCORD_RELEASE_WEBHOOK_PROFILE_ID, secret: "https://discord.com/api/webhooks/123/token",
    })).rejects.toThrow(/Secure webhook storage is unavailable\. \[incident:/u);
    h.diagnostics.flushIncidents();
    expect(h.diagnostics.queryIncidents({}).records[0]?.code).toBe("discord.credential-unavailable");
    expect(readFileSync(join(h.root, "logs", "runtime.log"), "utf8")).not.toContain("PRIVATE_WEBHOOK_CONTENT");
  });
});
