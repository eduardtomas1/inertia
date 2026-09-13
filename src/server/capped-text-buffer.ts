/** A UTF-16 size bound that never cuts a retained surrogate pair in half. */
export class CappedTextBuffer {
  private value = "";
  truncated = false;

  constructor(private readonly maxChars: number) {}

  append(text: string): void {
    if (!text || this.truncated) return;
    const remaining = this.maxChars - this.value.length;
    this.value += text.slice(0, Math.max(0, remaining));
    if (text.length <= remaining) return;
    this.truncated = true;
    // The high surrogate may have arrived in the preceding chunk at the cap.
    const last = this.value.charCodeAt(this.value.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) this.value = this.value.slice(0, -1);
  }

  toString(): string {
    return this.value;
  }
}
