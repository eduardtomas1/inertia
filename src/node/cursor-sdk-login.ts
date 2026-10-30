import type { SdkLoginOptions, SdkLoginResult } from "@cursor/sdk";
import { isBackendCredentialSecret } from "../shared/backend-credentials";
import type { BackendCredentialStatus } from "../shared/backend-credentials";

export interface CursorSdkLoginDependencies {
  login(options: SdkLoginOptions): Promise<SdkLoginResult>;
  save(secret: string, signal: AbortSignal): Promise<BackendCredentialStatus>;
  showUrl(url: string): void;
}

export async function loginCursorSdk(
  dependencies: CursorSdkLoginDependencies,
  signal: AbortSignal,
): Promise<{ expiresAt: number }> {
  signal.throwIfAborted();
  try {
    const result = await dependencies.login({
      store: null,
      openBrowser: false,
      signal,
      onLoginUrl: (value) => {
        signal.throwIfAborted();
        const url = new URL(value);
        if (url.origin !== "https://cursor.com" || url.username || url.password || value.length > 8192) {
          throw new Error("Cursor SDK login URL is invalid.");
        }
        dependencies.showUrl(value);
      },
    });
    signal.throwIfAborted();
    if (!isBackendCredentialSecret(result.apiKey) || !Number.isSafeInteger(result.apiKeyExpiresAtMs)
      || result.apiKeyExpiresAtMs <= Date.now()) throw new Error("Cursor SDK login result is invalid.");
    const saved = await dependencies.save(result.apiKey, signal);
    if (!saved.hasSecret || !saved.credentialGeneration) throw new Error("Cursor SDK credential was not saved.");
    return { expiresAt: result.apiKeyExpiresAtMs };
  } catch {
    throw new Error(signal.aborted ? "Cursor SDK login was cancelled." : "Cursor SDK login failed.");
  }
}
