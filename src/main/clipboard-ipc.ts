import { clipboard, ipcMain, type IpcMainInvokeEvent } from "electron";

const MAX_COPY_TEXT_CHARACTERS = 2 * 1024 * 1024;

export type TrustedIpcAssertion = (
  event: IpcMainInvokeEvent,
  argumentCount: number,
  expectedArguments?: number,
) => void;

export function registerClipboardIpc(
  channel: string,
  assertTrusted: TrustedIpcAssertion,
): void {
  ipcMain.handle(channel, (event, ...args) => {
    assertTrusted(event, args.length, 1);
    const [text] = args;
    if (typeof text !== "string" || text.length > MAX_COPY_TEXT_CHARACTERS) {
      return false;
    }
    clipboard.writeText(text);
    return true;
  });
}
