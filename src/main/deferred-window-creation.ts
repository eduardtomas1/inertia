export const WINDOW_DEFERRAL_LIMIT_MS = 100;

export class DeferredWindowCreation {
  private creation: Promise<void> | null = null;
  private readonly timer: ReturnType<typeof setTimeout>;

  constructor(
    private readonly createWindow: () => Promise<void>,
    limitMs = WINDOW_DEFERRAL_LIMIT_MS,
  ) {
    this.timer = setTimeout(() => {
      this.start().catch(() => undefined);
    }, limitMs);
  }

  start(): Promise<void> {
    clearTimeout(this.timer);
    this.creation ??= this.createWindow();
    return this.creation;
  }
}
