import { dialog, type BrowserWindow } from "electron";

export function confirmPreviewPageUnload(window: BrowserWindow): boolean {
  return dialog.showMessageBoxSync(window, {
    type: "question",
    buttons: ["Stay", "Leave"],
    defaultId: 0,
    cancelId: 0,
    title: "Leave this page?",
    message: "Leave this page?",
    detail: "The page in Inertia Browser asks to stay open, usually because it has unsaved changes.",
  }) === 1;
}
