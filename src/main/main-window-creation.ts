/** Coalesces window setup and permanently closes admission during shutdown. */
export class MainWindowCreation {
  private allowed = true;
  private pending: Promise<void> | null = null;

  allowsCreation(): boolean { return this.allowed; }

  current(): Promise<void> | null { return this.pending; }

  beginShutdown(): void { this.allowed = false; }

  run(create: () => Promise<void>): Promise<void> {
    if (this.pending) return this.pending;
    if (!this.allowed) return Promise.resolve();
    const creation = create();
    this.pending = creation;
    const clear = (): void => {
      if (this.pending === creation) this.pending = null;
    };
    void creation.then(clear, clear);
    return creation;
  }
}
