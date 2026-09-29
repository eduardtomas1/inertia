export class DatabaseRecoveryImportAdmission {
  private active = false;
  private idle: Promise<void> = Promise.resolve();
  private releaseIdle = (): void => undefined;
  private readonly admitted = new Set<Promise<unknown>>();

  isActive(): boolean {
    return this.active;
  }

  async admit<T>(operation: () => Promise<T>): Promise<T> {
    while (this.active) await this.idle;
    const running = operation();
    this.admitted.add(running);
    try {
      return await running;
    } finally {
      this.admitted.delete(running);
    }
  }

  begin(): void {
    if (this.active) throw new Error("A database recovery import is already active.");
    this.active = true;
    this.idle = new Promise<void>((resolve) => { this.releaseIdle = resolve; });
  }

  async drain(): Promise<void> {
    while (this.admitted.size > 0) await Promise.allSettled(this.admitted);
  }

  end(): void {
    this.active = false;
    this.releaseIdle();
  }
}
