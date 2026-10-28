import type { BrowserWindow } from "electron";

import type { ModernDarwinRecoveryAuthorityDescriptor } from
  "../node/runtime-modern-recovery-authorities.js";
import { promptForLiveModernDarwinRuntimeRecovery } from
  "./runtime-bootstrap-recovery.js";
import type { RuntimeSupervisor } from "./runtime-supervisor.js";
import type { RuntimeSupervisorSnapshot } from
  "./runtime-supervisor-types.js";

export class RuntimeLiveDarwinRecoveryCoordinator {
  readonly #dataDirectory: string;
  readonly #systemBootId: string;
  readonly #guardianPath: string | null;
  readonly #getWindow: () => BrowserWindow | null;
  readonly #platform: NodeJS.Platform;
  readonly #prompt: typeof promptForLiveModernDarwinRuntimeRecovery;
  readonly #reportError: (error: unknown) => void;
  readonly #offeredGenerations = new Set<number>();
  #prompting = false;

  constructor(options: {
    readonly dataDirectory: string;
    readonly systemBootId: string;
    readonly guardianPath: string | null;
    readonly getWindow: () => BrowserWindow | null;
    readonly platform?: NodeJS.Platform;
    readonly prompt?: (
      dataDirectory: string,
      systemBootId: string,
      guardianPath: string,
      window: BrowserWindow,
    ) => Promise<ModernDarwinRecoveryAuthorityDescriptor | null>;
    readonly reportError?: (error: unknown) => void;
  }) {
    this.#dataDirectory = options.dataDirectory;
    this.#systemBootId = options.systemBootId;
    this.#guardianPath = options.guardianPath;
    this.#getWindow = options.getWindow;
    this.#platform = options.platform ?? process.platform;
    this.#prompt = options.prompt ?? promptForLiveModernDarwinRuntimeRecovery;
    this.#reportError = options.reportError ?? ((error) => console.error(
      "Failed to prepare explicit macOS runtime recovery",
      error,
    ));
  }

  observe(
    snapshot: RuntimeSupervisorSnapshot,
    supervisor: RuntimeSupervisor | null,
  ): void {
    if (
      snapshot.phase !== "stopped"
      || !supervisor
      || this.#offeredGenerations.has(snapshot.generation)
    ) return;
    const target = this.#eligibleTarget(supervisor);
    if (!target) return;
    this.#offeredGenerations.add(snapshot.generation);
    this.#offer(target, supervisor);
  }

  request(supervisor: RuntimeSupervisor): boolean {
    const target = this.#eligibleTarget(supervisor);
    if (!target) return false;
    this.#offer(target, supervisor);
    return true;
  }

  #eligibleTarget(
    supervisor: RuntimeSupervisor,
  ): { readonly window: BrowserWindow; readonly guardianPath: string } | null {
    const guardianPath = this.#guardianPath;
    if (
      this.#platform !== "darwin"
      || !guardianPath
      || this.#prompting
      || !supervisor.canResumeWithModernDarwinRecovery()
    ) return null;
    const window = this.#getWindow();
    return window && !window.isDestroyed() ? { window, guardianPath } : null;
  }

  #offer(
    { window, guardianPath }: { readonly window: BrowserWindow; readonly guardianPath: string },
    supervisor: RuntimeSupervisor,
  ): void {
    this.#prompting = true;
    void this.#prompt(
      this.#dataDirectory,
      this.#systemBootId,
      guardianPath,
      window,
    ).then((authority) => {
      if (authority && !window.isDestroyed()) {
        supervisor.resumeWithModernDarwinRecovery(authority);
      }
    }).catch(this.#reportError).finally(() => {
      this.#prompting = false;
    });
  }
}
