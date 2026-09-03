import type { ElectronApplication } from "@playwright/test";

export interface NativePreviewTestSnapshot {
  attachedUrls: string[];
  bounds: { x: number; y: number; width: number; height: number } | null;
  exactUrlAttached: boolean;
  visible: boolean;
}

export async function readNativePreviewSnapshot(
  electronApp: ElectronApplication,
  url: string,
): Promise<NativePreviewTestSnapshot> {
  return await electronApp.evaluate(
    ({ BrowserWindow }, previewUrl) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) {
        return {
          attachedUrls: [],
          bounds: null,
          exactUrlAttached: false,
          visible: false,
        };
      }
      const attachedUrls = window.contentView.children.map((view) =>
        (Reflect.get(view, "webContents") as
          | { getURL: () => string }
          | undefined)?.getURL() ?? "");
      const preview = window.contentView.children.find((view) => {
        const contents = Reflect.get(view, "webContents") as
          | { getURL: () => string }
          | undefined;
        return contents?.getURL() === previewUrl;
      });
      const bounds = preview?.getBounds() ?? null;
      return {
        attachedUrls,
        bounds,
        exactUrlAttached: preview !== undefined,
        visible: Boolean(bounds && bounds.width > 0 && bounds.height > 0),
      };
    },
    url,
  );
}
