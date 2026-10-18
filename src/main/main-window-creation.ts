/** Coalesces window setup and permanently closes admission during shutdown. */
export class MainWindowCreation {
  private admitted = false;
  private allowed = true;
  private pending: Promise<void> | null = null;

  admit(): void { this.admitted = true; }

  allowsCreation(): boolean { return this.admitted && this.allowed; }

  current(): Promise<void> | null { return this.pending; }

  beginShutdown(): void { this.allowed = false; }

  run(create: () => Promise<void>): Promise<void> {
    if (this.pending) return this.pending;
    if (!this.allowsCreation()) return Promise.resolve();
    const creation = create();
    this.pending = creation;
    const clear = (): void => {
      if (this.pending === creation) this.pending = null;
    };
    void creation.then(clear, clear);
    return creation;
  }
}
