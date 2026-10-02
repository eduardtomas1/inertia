import { describe, expect, it, vi } from "vitest";
import { USAGE_ACCOUNT_IDENTITY_SECRET_REFERENCE } from "../../src/node/backend-secret-reference";
import type { CredentialVault } from "../../src/main/credential-vault";
import { runtimeCredentialBroker } from "../../src/main/runtime-credential-broker";

describe("runtime credential broker", () => {
  it("creates only the usage identity key on demand and resolves other references unchanged", async () => {
    const vault = {
      resolve: vi.fn(async () => null), resolveOrCreate: vi.fn(async () => "identity-key"),
      status: vi.fn(), clear: vi.fn(), forget: vi.fn(),
    };
    const broker = runtimeCredentialBroker(() => vault as unknown as CredentialVault);
    expect(await broker.resolve(USAGE_ACCOUNT_IDENTITY_SECRET_REFERENCE)).toBe("identity-key");
    expect(await broker.resolve("secret:backend:profile")).toBeNull();
    expect(vault.resolveOrCreate).toHaveBeenCalledExactlyOnceWith(USAGE_ACCOUNT_IDENTITY_SECRET_REFERENCE);
    expect(vault.resolve).toHaveBeenCalledExactlyOnceWith("secret:backend:profile");
  });
});
