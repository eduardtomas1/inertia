import { dialog, type BrowserWindow } from "electron";

export function confirmPreviewPageUnload(window: BrowserWindow, pageNumber: number): boolean {
  return dialog.showMessageBoxSync(window, {
    type: "question",
    buttons: ["Stay", "Leave"],
    defaultId: 0,
    cancelId: 0,
    title: `Browser tab ${Math.max(1, Math.trunc(pageNumber))}`,
    message: "Leave this page?",
    detail: "The page in Inertia Browser asks to stay open, usually because it has unsaved changes.",
  }) === 1;
}
