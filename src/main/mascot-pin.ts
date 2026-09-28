export const MASCOT_PIN_TIMEOUT_MS = 10_000;

interface MascotPinSelection {
  id: string;
  request: number;
  confirmed: boolean;
}

export class MascotPin {
  private selection: MascotPinSelection | null = null;
  private requests = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ready = false;

  constructor(
    private readonly send: (conversationId: string | null, request: number) => void,
    private readonly released: () => void,
  ) {}

  get id(): string | null {
    return this.selection?.id ?? null;
  }

  select(conversationId: string | null): void {
    this.requests += 1;
    this.stopTimer();
    this.selection = conversationId === null ? null : { id: conversationId, request: this.requests, confirmed: false };
    if (this.selection) this.timer = setTimeout(() => this.expire(), MASCOT_PIN_TIMEOUT_MS);
    this.send(conversationId, this.requests);
  }

  answer(focus: string | null, request: number | null | undefined): void {
    const selection = this.selection;
    if (!selection || (request !== undefined && request !== selection.request)) return;
    if (focus === selection.id) {
      selection.confirmed = true;
      this.stopTimer();
      return;
    }
    if (request === undefined && !selection.confirmed) return;
    this.selection = null;
    this.stopTimer();
  }

  runtime(ready: boolean): void {
    const resumed = ready && !this.ready;
    this.ready = ready;
    if (resumed && this.selection) this.select(this.selection.id);
    if (ready) return;
    this.stopTimer();
    if (this.selection) this.selection.confirmed = false;
  }

  private expire(): void {
    this.timer = null;
    if (!this.selection || this.selection.confirmed) return;
    this.select(null);
    this.released();
  }

  private stopTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
