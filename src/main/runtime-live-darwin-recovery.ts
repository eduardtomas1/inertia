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
  readonly #platform: NodeJS.Platform;
  readonly #prompt: typeof promptForLiveModernDarwinRuntimeRecovery;
  readonly #reportError: (error: unknown) => void;
  readonly #offeredGenerations = new Set<number>();

  constructor(options: {
    readonly dataDirectory: string;
    readonly systemBootId: string;
    readonly guardianPath: string | null;
    readonly platform?: NodeJS.Platform;
    readonly prompt?: (
      dataDirectory: string,
      systemBootId: string,
      guardianPath: string,
    ) => Promise<ModernDarwinRecoveryAuthorityDescriptor | null>;
    readonly reportError?: (error: unknown) => void;
  }) {
    this.#dataDirectory = options.dataDirectory;
    this.#systemBootId = options.systemBootId;
    this.#guardianPath = options.guardianPath;
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
      this.#platform !== "darwin"
      || snapshot.phase !== "stopped"
      || !this.#guardianPath
      || !supervisor?.canResumeWithModernDarwinRecovery()
      || this.#offeredGenerations.has(snapshot.generation)
    ) return;
    this.#offeredGenerations.add(snapshot.generation);
    void this.#prompt(
      this.#dataDirectory,
      this.#systemBootId,
      this.#guardianPath,
    ).then((authority) => {
      if (authority) supervisor.resumeWithModernDarwinRecovery(authority);
    }).catch(this.#reportError);
  }
}
