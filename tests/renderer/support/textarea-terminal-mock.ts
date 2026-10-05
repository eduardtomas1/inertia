export interface TextareaTerminalState {
  textarea: HTMLTextAreaElement | null;
  onData: ((data: string) => void) | null;
  writes: string[];
}

export function createTextareaTerminalModule(state: TextareaTerminalState) {
  return {
    Terminal: class {
      cols = 80;
      rows = 24;
      options = {
        fontSize: 13,
        theme: {},
      };

      loadAddon(): void {}
      attachCustomKeyEventHandler(): void {}

      open(container: HTMLElement): void {
        const textarea = document.createElement("textarea");
        textarea.setAttribute("aria-label", "Terminal input");
        container.append(textarea);
        state.textarea = textarea;
      }

      focus(): void {
        state.textarea?.focus();
      }

      onData(callback: (data: string) => void): { dispose: () => void } {
        state.onData = callback;
        return { dispose: () => undefined };
      }

      clear(): void {
        state.writes = [];
      }
      writeln(data: string): void {
        state.writes.push(data);
      }
      write(data: string): void {
        state.writes.push(data);
      }
      dispose(): void {}
    },
  };
}
