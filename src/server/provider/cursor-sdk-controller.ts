import { inspectCursorSdkInstallation, type CursorSdkInstallation } from "./cursor-sdk-installation";
import { CURSOR_SDK_SECRET_REFERENCE } from "../../node/runtime-credential-protocol";
import { cursorSdkModels, cursorSdkLogin, cursorSdkStatus, type CursorSdkConfiguration, type CursorSdkStatus } from "./cursor-sdk-service";
import { isProcessTreeTerminationUnconfirmed, ProcessTreeTerminationError } from "../process-lifecycle";

export class CursorSdkController {
  private cursorSdkLoginPending = false;
  private models = new Set<string>();
  private sdkInstallation: CursorSdkInstallation | undefined;
  private sdkCredentialGeneration: string | null = null;
  private cleanupUnconfirmed = false;
  constructor(private readonly cursorSdk: CursorSdkConfiguration | undefined, private readonly environment: () => NodeJS.ProcessEnv) {}

  async status(signal: AbortSignal): Promise<CursorSdkStatus> {
    return this.accountOperation(() => this.readStatus(signal));
  }

  private async readStatus(signal: AbortSignal): Promise<CursorSdkStatus> {
    this.sdkInstallation = undefined;
    this.models.clear();
    const credentials = await this.cursorSdk?.credentials?.status(CURSOR_SDK_SECRET_REFERENCE, signal);
    this.sdkCredentialGeneration = credentials?.credentialGeneration ?? null;
    let before: CursorSdkInstallation;
    try { before = inspectCursorSdkInstallation(this.environment(), this.sdkCredentialGeneration); }
    catch { return { available: false, hasCredential: credentials?.hasSecret ?? false, sdkVersion: "1.0.38", message: "Cursor SDK runtime or platform assets are unavailable." }; }
    const status = await cursorSdkStatus(this.cursorSdk, this.environment(), signal);
    if (status.available) {
      const after = inspectCursorSdkInstallation(this.environment(), this.sdkCredentialGeneration);
      if (before.fingerprint !== after.fingerprint) throw new Error("Cursor SDK installation changed during discovery.");
      this.sdkInstallation = after;
    }
    return status;
  }

  async discoverModels(signal: AbortSignal) {
    return this.accountOperation(() => this.readModels(signal));
  }

  private async readModels(signal: AbortSignal) {
    if (!this.cursorSdk || this.cursorSdkLoginPending) throw new Error("Cursor SDK catalog is unavailable.");
    const installation = this.requireInstallation();
    const models = await cursorSdkModels(this.cursorSdk, this.environment(), signal);
    if (this.requireInstallation().fingerprint !== installation.fingerprint) throw new Error("Cursor SDK catalog installation changed.");
    this.models = new Set(models.map(({ id }) => id));
    return models;
  }

  requireModel(id: string): void {
    this.requireInstallation();
    if (!this.models.has(id)) throw new Error("Refresh the Cursor SDK model catalog before selecting this model.");
  }

  invalidate(): void { this.sdkInstallation = undefined; this.models.clear(); }

  currentInstallation(): CursorSdkInstallation | undefined {
    if (this.cleanupUnconfirmed || !this.sdkInstallation) return undefined;
    try {
      const current = inspectCursorSdkInstallation(this.environment(), this.sdkCredentialGeneration);
      return current.fingerprint === this.sdkInstallation.fingerprint ? current : undefined;
    } catch { return undefined; }
  }

  requireInstallation(): CursorSdkInstallation {
    const installation = this.currentInstallation();
    if (!installation) throw new Error("Refresh Cursor SDK discovery before launching this route.");
    return installation;
  }

  async login(onUrl: (url: string) => void, signal: AbortSignal): Promise<{ expiresAt: number }> {
    if (this.cursorSdkLoginPending) throw new Error("Cursor SDK login is already active.");
    this.cursorSdkLoginPending = true;
    this.sdkInstallation = undefined;
    this.models.clear();
    try { return await this.accountOperation(() => cursorSdkLogin(this.cursorSdk, this.environment(), onUrl, signal)); }
    finally { this.cursorSdkLoginPending = false; }
  }

  private async accountOperation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.cleanupUnconfirmed) throw new ProcessTreeTerminationError("Cursor SDK account worker");
    try {
      return await operation();
    } catch (error) {
      if (isProcessTreeTerminationUnconfirmed(error)) {
        this.cleanupUnconfirmed = true;
        this.invalidate();
      }
      throw error;
    }
  }
}
