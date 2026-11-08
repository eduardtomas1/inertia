import { cursorSdkModelsSchema, type CursorSdkModel } from "../../node/cursor-sdk-models";
import { mkdir, realpath } from "node:fs/promises";
import type { BackendCredentialStatus } from "../../shared/backend-credentials";
import { CURSOR_SDK_SECRET_REFERENCE } from "../../node/runtime-credential-protocol";
import { loginCursorSdk } from "../../node/cursor-sdk-login";
import { openCursorSdkWorker } from "./cursor-sdk-process";
import { isProcessTreeTerminationUnconfirmed } from "../process-lifecycle";
import type { SdkLoginResult } from "@cursor/sdk";

export interface CursorSdkConfiguration {
  stateRoot: string;
  credentials?: {
    resolve(reference: string, signal?: AbortSignal): Promise<string | null>;
    status(reference: string, signal?: AbortSignal): Promise<BackendCredentialStatus>;
    saveCursorSdk?(secret: string, signal?: AbortSignal): Promise<BackendCredentialStatus>;
  };
}

export interface CursorSdkStatus {
  available: boolean;
  hasCredential: boolean;
  sdkVersion: "1.0.38";
  message?: string;
}

export async function cursorSdkStateRoot(configuration: CursorSdkConfiguration): Promise<string> {
  if (process.platform !== "linux") throw new Error("Cursor SDK durable storage is unavailable on this platform.");
  await mkdir(configuration.stateRoot, { recursive: true, mode: 0o700 });
  const root = await realpath(configuration.stateRoot);
  if (root !== configuration.stateRoot) throw new Error("Cursor SDK state root must be canonical.");
  return root;
}

export async function cursorSdkStatus(configuration: CursorSdkConfiguration | undefined, environment: NodeJS.ProcessEnv, signal: AbortSignal): Promise<CursorSdkStatus> {
  if (!configuration?.credentials) return { available: false, hasCredential: false, sdkVersion: "1.0.38", message: "Cursor SDK vault is unavailable." };
  const status = await configuration.credentials.status(CURSOR_SDK_SECRET_REFERENCE, signal);
  try {
    const cwd = await cursorSdkStateRoot(configuration);
    const worker = await openCursorSdkWorker({ cwd, environment, signal, handle: async () => { throw new Error("Unexpected worker request."); } });
    try {
      const inspected = await worker.channel.request("inspect", null, 30_000) as {
        sdkVersion?: unknown; nativeStore?: unknown; storeKind?: unknown;
      } | null;
      if (inspected?.sdkVersion !== "1.0.38" || inspected.nativeStore !== true || inspected.storeKind !== "inertia-journal-v1") {
        throw new Error("Cursor SDK package verification failed.");
      }
    } finally { await worker.close(); }
    return { available: true, hasCredential: status.hasSecret, sdkVersion: "1.0.38" };
  } catch (error) {
    if (isProcessTreeTerminationUnconfirmed(error)) throw error;
    return { available: false, hasCredential: status.hasSecret, sdkVersion: "1.0.38", message: "Cursor SDK requires Linux, the owned worker and external Node 22.13+." };
  }
}

export async function cursorSdkLogin(configuration: CursorSdkConfiguration | undefined, environment: NodeJS.ProcessEnv, onUrl: (url: string) => void, signal: AbortSignal): Promise<{ expiresAt: number }> {
  if (!configuration?.credentials?.saveCursorSdk) throw new Error("Cursor SDK vault login is unavailable.");
  const cwd = await cursorSdkStateRoot(configuration);
  const worker = await openCursorSdkWorker({ cwd, environment, signal, handle: async (method, value) => {
    if (method !== "login-url" || typeof value !== "string") throw new Error("Invalid login notification.");
    const url = new URL(value);
    if (value.length > 8192 || url.origin !== "https://cursor.com" || url.username || url.password) throw new Error("Invalid login URL.");
    onUrl(value); return null;
  } });
  try {
    return await loginCursorSdk({
      login: async () => await worker.channel.request("login", null, 10 * 60_000) as SdkLoginResult,
      save: (secret, cancellation) => configuration.credentials!.saveCursorSdk!(secret, cancellation),
      showUrl: onUrl,
    }, signal);
  } finally { await worker.close(); }
}

export async function cursorSdkModels(configuration: CursorSdkConfiguration, environment: NodeJS.ProcessEnv, signal: AbortSignal): Promise<CursorSdkModel[]> {
  const secret = await configuration.credentials?.resolve(CURSOR_SDK_SECRET_REFERENCE, signal);
  if (!secret) throw new Error("Cursor SDK login is required.");
  const cwd = await cursorSdkStateRoot(configuration);
  const worker = await openCursorSdkWorker({ cwd, environment, signal, handle: async () => { throw new Error("Unexpected catalog notification."); } });
  try {
    const models = cursorSdkModelsSchema.parse(await worker.channel.request("models", secret, 30_000));
    if (models.some(({ id, displayName }) => id.includes(secret) || displayName.includes(secret))) throw new Error("Invalid Cursor SDK catalog.");
    return models;
  }
  finally { await worker.close(); }
}
