import type { AppSettings, AppSettingsUpdate } from "../../shared/contracts";
import type { PersistenceContext } from "./context";
import type { SettingsRepository } from "./settings-repository";

/**
 * The runtime store's settings surface: the current settings, plain updates,
 * and the update that also clears the global backend default in one
 * transaction.
 */
export class RuntimeSettingsStore {
  constructor(private readonly context: Pick<PersistenceContext, "database"> & {
    repository: SettingsRepository;
    clearGlobalBackendDefault(): void;
  }) {}

  current(): AppSettings {
    return this.context.repository.current();
  }

  update(update: AppSettingsUpdate): void {
    this.context.repository.update(update);
  }

  updateClearingGlobalDefault(update: AppSettingsUpdate): void {
    this.context.database.transaction(() => {
      this.context.repository.update(update);
      this.context.clearGlobalBackendDefault();
    })();
  }
}
