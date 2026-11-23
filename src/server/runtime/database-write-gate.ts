export const DATABASE_VACUUM_REFUSAL = "Database compaction is in progress. Try again after it finishes.";

export type DatabaseWriteRunner = Pick<DatabaseWriteGate, "run">;

export function runDatabaseWrite<T>(writes: DatabaseWriteRunner | undefined, operation: () => Promise<T>): Promise<T> {
  return writes ? writes.run(operation) : operation();
}

export interface DatabaseWritability {
  isDatabaseVacuuming(): boolean;
  whenDatabaseWritable(): Promise<void>;
}

export class DatabaseWriteGate {
  #active = 0;

  constructor(private readonly database: DatabaseWritability) {}

  activeWrites(): number {
    return this.#active;
  }

  async whenWritable(): Promise<void> {
    while (this.database.isDatabaseVacuuming()) await this.database.whenDatabaseWritable();
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    while (this.database.isDatabaseVacuuming()) await this.database.whenDatabaseWritable();
    this.#active += 1;
    try {
      return await operation();
    } finally {
      this.#active -= 1;
    }
  }
}
