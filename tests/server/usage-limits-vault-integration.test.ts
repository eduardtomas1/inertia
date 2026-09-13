import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { CredentialVault, FileCredentialVaultPersistence, type CredentialEncryptionBackend } from "../../src/main/credential-vault";
import { backendSecretReferenceForProfile } from "../../src/node/backend-secret-reference";
import { UsageLimitsService } from "../../src/server/usage/limits-service";
import { CliproxyUsageClient } from "../../src/server/usage/cliproxy";
import { UsageLimitsRepository } from "../../src/server/persistence/usage-limits-repository";
import { providerUsageLimitsMigration } from "../../src/server/persistence/migrations/provider-usage-limits";
import { usageAccount } from "../helpers/usage-limits";

it("saves, reopens, resolves and removes a hub key through the real credential vault", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inertia-limits-vault-"));
  const db = new Database(":memory:"); db.exec(providerUsageLimitsMigration.up as string);
  try {
    const encryptionKey = randomBytes(32);
    const encryption: CredentialEncryptionBackend = {
      availability: async () => ({ available: true, provider: "keychain", message: null }),
      encrypt: async (plainText) => {
        const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
        const content = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
        return Buffer.concat([iv, cipher.getAuthTag(), content]);
      },
      decrypt: async (content) => {
        const decipher = createDecipheriv("aes-256-gcm", encryptionKey, content.subarray(0, 12)); decipher.setAuthTag(content.subarray(12, 28));
        return { plainText: Buffer.concat([decipher.update(content.subarray(28)), decipher.final()]).toString("utf8"), shouldReEncrypt: false };
      },
    };
    const path = join(directory, "credentials.json");
    const source = { id: crypto.randomUUID(), label: "Fixture hub", url: "https://hub.example.test", enabled: true };
    const profileId = `usage-source:${source.id}`; const secret = randomBytes(24).toString("hex");
    await new CredentialVault(encryption, new FileCredentialVaultPersistence(path)).setForProfile(profileId, secret);
    const vault = new CredentialVault(encryption, new FileCredentialVaultPersistence(path));
    let reads = 0;
    const hub = new CliproxyUsageClient(async (_url, options) => {
      expect(new Headers(options?.headers).get("Authorization") === `Bearer ${secret}`).toBe(true); reads += 1;
      return new Response(JSON.stringify({ files: [] }));
    });
    const repository = new UsageLimitsRepository(db);
    const service = new UsageLimitsService({ repository, credentials: vault, hub, providers: () => [], customProfiles: () => [], native: { read: async () => usageAccount(), consume: async () => "nothingToReset" }, enabled: true, signal: new AbortController().signal });
    await service.saveSource(source); await service.refresh(); expect(reads).toBe(1);
    expect(JSON.stringify(service.snapshot()).includes(secret)).toBe(false);
    expect((await readFile(path, "utf8")).includes(secret)).toBe(false);
    await service.removeSource(source.id);
    expect(repository.sources()).toEqual([]);
    expect(await vault.status(backendSecretReferenceForProfile(profileId))).toMatchObject({ hasSecret: false });
    await service.refresh(true); expect(reads).toBe(1);
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});
