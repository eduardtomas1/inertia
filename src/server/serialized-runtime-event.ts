import type { ServerEvent } from "../shared/contracts";

export interface EncodedRuntimeEvent {
  text: string;
  bytes: number;
}

export class SerializedRuntimeEvent<Event extends ServerEvent = ServerEvent> {
  private encoded: EncodedRuntimeEvent | null = null;

  constructor(readonly event: Event) {}

  encode(): EncodedRuntimeEvent {
    if (!this.encoded) {
      const text = JSON.stringify(this.event);
      this.encoded = { text, bytes: Buffer.byteLength(text, "utf8") };
    }
    return this.encoded;
  }
}
