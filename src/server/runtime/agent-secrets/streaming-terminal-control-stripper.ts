import { stripTerminalControlSequences } from "../../provider/activity-detail";

const MAX_PENDING_ESCAPE_CHARS = 256;
const TERMINAL_CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/u;

function isStrippedControlCode(code: number): boolean {
  return code <= 0x08
    || code === 0x0b
    || code === 0x0c
    || (code >= 0x0e && code <= 0x1f)
    || (code >= 0x7f && code <= 0x9f);
}

/**
 * Strips terminal escape sequences (CSI, OSC, 2-byte ESC) and C0/C1 control
 * characters across streamed chunks so an ANSI escape split over chunk
 * boundaries cannot evade downstream secret matching.
 */
export class StreamingTerminalControlStripper {
  private pending = "";

  push(chunk: string): string {
    if (!chunk) return "";
    if (!this.pending && !TERMINAL_CONTROL.test(chunk)) return chunk;
    const text = this.pending ? this.pending + chunk : chunk;
    this.pending = "";
    return this.drain(text, false);
  }

  finish(): string {
    if (!this.pending) return "";
    const text = this.pending;
    this.pending = "";
    return this.drain(text, true);
  }

  discard(): void {
    this.pending = "";
  }

  private drain(text: string, final: boolean): string {
    let output = "";
    let plainStart = 0;
    let index = 0;
    const length = text.length;

    while (index < length) {
      const code = text.charCodeAt(index);

      if (code === 0x0d) {
        if (index > plainStart) output += text.slice(plainStart, index);
        if (index + 1 === length && !final) {
          this.pending = "\r";
          return output;
        }
        output += "\n";
        index += index + 1 < length && text.charCodeAt(index + 1) === 0x0a ? 2 : 1;
        plainStart = index;
        continue;
      }

      if (code === 0x1b) {
        if (index > plainStart) output += text.slice(plainStart, index);
        if (index + 1 === length) {
          if (!final) this.pending = "\u001b";
          return output;
        }
        const next = text.charCodeAt(index + 1);
        if (next === 0x5b) {
          // CSI: ESC [ [0-?]* [ -/]* [@-~]
          let scan = index + 2;
          while (scan < length && text.charCodeAt(scan) >= 0x30 && text.charCodeAt(scan) <= 0x3f) {
            scan += 1;
          }
          while (scan < length && text.charCodeAt(scan) >= 0x20 && text.charCodeAt(scan) <= 0x2f) {
            scan += 1;
          }
          if (scan === length) {
            if (!final && length - index < MAX_PENDING_ESCAPE_CHARS) {
              this.pending = text.slice(index);
              return output;
            }
            output += stripTerminalControlSequences(text.slice(index + 1));
            return output;
          }
          const finalByte = text.charCodeAt(scan);
          if (finalByte >= 0x40 && finalByte <= 0x7e) {
            index = scan + 1;
            plainStart = index;
            continue;
          }
          // Malformed CSI: drop only ESC so ordinary text still reaches the redactor.
          index += 1;
          plainStart = index;
          continue;
        }
        if (next === 0x5d) {
          // OSC: ESC ] [^\x07\x1b]* (\x07 | ESC \)
          let scan = index + 2;
          while (scan < length) {
            const c = text.charCodeAt(scan);
            if (c === 0x07 || c === 0x1b) break;
            scan += 1;
          }
          if (scan === length) {
            if (!final && length - index < MAX_PENDING_ESCAPE_CHARS) {
              this.pending = text.slice(index);
              return output;
            }
            output += stripTerminalControlSequences(text.slice(index + 1));
            return output;
          }
          if (text.charCodeAt(scan) === 0x07) {
            index = scan + 1;
            plainStart = index;
            continue;
          }
          // Found ESC inside OSC: check for ST (ESC \)
          if (scan + 1 === length) {
            if (!final && length - index < MAX_PENDING_ESCAPE_CHARS) {
              this.pending = text.slice(index);
              return output;
            }
            output += stripTerminalControlSequences(text.slice(index + 1));
            return output;
          }
          if (text.charCodeAt(scan + 1) === 0x5c) {
            index = scan + 2;
            plainStart = index;
            continue;
          }
          // Unterminated OSC followed by another ESC: drop the first ESC.
          index += 1;
          plainStart = index;
          continue;
        }
        if (next >= 0x40 && next <= 0x5f) {
          index += 2;
          plainStart = index;
          continue;
        }
        index += 1;
        plainStart = index;
        continue;
      }

      if (isStrippedControlCode(code)) {
        if (index > plainStart) output += text.slice(plainStart, index);
        index += 1;
        plainStart = index;
        continue;
      }

      index += 1;
    }

    if (plainStart < length) output += text.slice(plainStart);
    return output;
  }
}
