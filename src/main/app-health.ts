import type {
  AppHealthSnapshot,
  AppHealthWarning,
  AppHealthWarningCode,
  AppProcessHealth,
  AppRuntimePhase,
} from "../shared/desktop.js";

export interface HealthSession {
  clearCache(): Promise<void>;
  getCacheSize(): Promise<number>;
}

export interface HealthRenderer {
  readonly session: HealthSession;
  getOSProcessId(): number;
  isDestroyed(): boolean;
}

export interface HealthProcessMetric {
  pid: number;
  cpu: { percentCPUUsage: number };
  memory: { workingSetSize: number };
}

export type HealthProcessRole = "main" | "renderer" | "runtime";

interface ProcessRegistration {
  role: HealthProcessRole;
  pid(): number | null;
}

const MAX_WARNINGS = 8;
const WARNING_MESSAGES: Readonly<Record<AppHealthWarningCode, string>> = {
  processes: "Some Inertia process measurements are unavailable.",
  runtime: "The local service state could not be measured.",
  database: "Database storage could not be measured.",
  cache: "Browser cache storage could not be measured.",
  "cache-clear": "Some Inertia browser caches could not be cleared.",
  attachments: "Temporary attachment storage could not be measured.",
};

export class InertiaHealthRegistry {
  readonly #sessions = new Map<HealthSession, number>();
  readonly #processes = new Set<ProcessRegistration>();

  registerProcess(
    role: HealthProcessRole,
    pid: () => number | null,
  ): () => void {
    const registration = { role, pid };
    this.#processes.add(registration);
    let registered = true;
    return () => {
      if (!registered) return;
      registered = false;
      this.#processes.delete(registration);
    };
  }

  registerRenderer(renderer: HealthRenderer): () => void {
    const references = this.#sessions.get(renderer.session) ?? 0;
    this.#sessions.set(renderer.session, references + 1);
    const unregisterProcess = this.registerProcess("renderer", () => (
      renderer.isDestroyed() ? null : renderer.getOSProcessId()
    ));
    let registered = true;
    return () => {
      if (!registered) return;
      registered = false;
      unregisterProcess();
      const remaining = (this.#sessions.get(renderer.session) ?? 1) - 1;
      if (remaining <= 0) this.#sessions.delete(renderer.session);
      else this.#sessions.set(renderer.session, remaining);
    };
  }

  sessions(): readonly HealthSession[] {
    return [...this.#sessions.keys()];
  }

  processes(): readonly ProcessRegistration[] {
    return [...this.#processes];
  }
}

export interface AppHealthCollectorOptions {
  registry: InertiaHealthRegistry;
  getProcessMetrics(): readonly HealthProcessMetric[];
  getRuntimePhase(): AppRuntimePhase;
  readDatabaseBytes(): Promise<number>;
  readTemporaryAttachmentBytes(): number;
  now?: () => Date;
}

interface ProcessSnapshot {
  totalMemoryBytes: number | null;
  mainProcess: AppProcessHealth | null;
  rendererProcesses: AppProcessHealth[] | null;
  runtimeProcess: AppProcessHealth | null;
  warning: boolean;
}

function safeBytes(value: number): number | null {
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;
}

function processHealth(metric: HealthProcessMetric): AppProcessHealth | null {
  const cpuPercent = Number.isFinite(metric.cpu.percentCPUUsage)
    && metric.cpu.percentCPUUsage >= 0
    ? metric.cpu.percentCPUUsage
    : null;
  const memoryBytes = safeBytes(metric.memory.workingSetSize * 1_024);
  return cpuPercent === null || memoryBytes === null
    ? null
    : { pid: metric.pid, cpuPercent, memoryBytes };
}

function warnings(codes: readonly AppHealthWarningCode[]): AppHealthWarning[] {
  return [...new Set(codes)].slice(0, MAX_WARNINGS).map((code) => ({
    code,
    message: WARNING_MESSAGES[code],
  }));
}

export class AppHealthCollector {
  readonly #options: AppHealthCollectorOptions;

  constructor(options: AppHealthCollectorOptions) {
    this.#options = options;
  }

  async collect(
    initialWarnings: readonly AppHealthWarningCode[] = [],
  ): Promise<AppHealthSnapshot> {
    const warningCodes = [...initialWarnings];
    const processes = this.#processSnapshot();
    if (processes.warning) warningCodes.push("processes");

    let runtimePhase: AppRuntimePhase | null = null;
    try {
      runtimePhase = this.#options.getRuntimePhase();
    } catch {
      warningCodes.push("runtime");
    }

    const [database, cache] = await Promise.all([
      this.#measureDatabase(),
      this.#measureCache(),
    ]);
    if (database.warning) warningCodes.push("database");
    if (cache.warning) warningCodes.push("cache");

    let temporaryAttachmentBytes: number | null = null;
    try {
      temporaryAttachmentBytes = safeBytes(
        this.#options.readTemporaryAttachmentBytes(),
      );
      if (temporaryAttachmentBytes === null) warningCodes.push("attachments");
    } catch {
      warningCodes.push("attachments");
    }

    return {
      sampledAt: (this.#options.now ?? (() => new Date()))().toISOString(),
      totalMemoryBytes: processes.totalMemoryBytes,
      mainProcess: processes.mainProcess,
      rendererProcesses: processes.rendererProcesses,
      runtimeProcess: processes.runtimeProcess,
      runtimePhase,
      databaseBytes: database.value,
      cacheBytes: cache.value,
      temporaryAttachmentBytes,
      warnings: warnings(warningCodes),
    };
  }

  async clearCache(): Promise<AppHealthSnapshot> {
    const results = await Promise.allSettled(
      this.#options.registry.sessions().map(async (session) => {
        await session.clearCache();
      }),
    );
    return await this.collect(
      results.some((result) => result.status === "rejected")
        ? ["cache-clear"]
        : [],
    );
  }

  #processSnapshot(): ProcessSnapshot {
    let metrics: readonly HealthProcessMetric[];
    try {
      metrics = this.#options.getProcessMetrics();
    } catch {
      return {
        totalMemoryBytes: null,
        mainProcess: null,
        rendererProcesses: null,
        runtimeProcess: null,
        warning: true,
      };
    }
    const byPid = new Map(metrics.map((metric) => [metric.pid, metric]));
    const registered = new Map<number, HealthProcessRole>();
    let incomplete = false;
    for (const process of this.#options.registry.processes()) {
      try {
        const pid = process.pid();
        if (pid === null) continue;
        if (!Number.isSafeInteger(pid) || pid <= 0) {
          incomplete = true;
          continue;
        }
        registered.set(pid, process.role);
      } catch {
        incomplete = true;
      }
    }

    const main: AppProcessHealth[] = [];
    const renderers: AppProcessHealth[] = [];
    const runtime: AppProcessHealth[] = [];
    const measuredByPid = new Map<number, AppProcessHealth>();
    for (const [pid, role] of registered) {
      const metric = byPid.get(pid);
      const health = metric ? processHealth(metric) : null;
      if (!health) {
        incomplete = true;
        continue;
      }
      measuredByPid.set(pid, health);
      if (role === "main") main.push(health);
      else if (role === "renderer") renderers.push(health);
      else runtime.push(health);
    }
    if (main.length !== 1 || runtime.length > 1) incomplete = true;
    return {
      totalMemoryBytes: incomplete
        ? null
        : [...measuredByPid.values()].reduce(
            (total, process) => total + process.memoryBytes,
            0,
          ),
      mainProcess: main[0] ?? null,
      rendererProcesses: renderers,
      runtimeProcess: runtime[0] ?? null,
      warning: incomplete,
    };
  }

  async #measureDatabase(): Promise<{ value: number | null; warning: boolean }> {
    try {
      const value = safeBytes(await this.#options.readDatabaseBytes());
      return { value, warning: value === null };
    } catch {
      return { value: null, warning: true };
    }
  }

  async #measureCache(): Promise<{ value: number | null; warning: boolean }> {
    const results = await Promise.allSettled(
      this.#options.registry.sessions().map(async (session) => (
        await session.getCacheSize()
      )),
    );
    if (results.some((result) => result.status === "rejected")) {
      return { value: null, warning: true };
    }
    let total = 0;
    for (const result of results) {
      if (result.status !== "fulfilled") continue;
      const value = safeBytes(result.value);
      if (value === null) return { value: null, warning: true };
      total += value;
    }
    return { value: total, warning: false };
  }
}
