import { useEffect, useRef, useState } from "react";
import type { AppSettings, ServerEvent } from "@shared/contracts";
import { ATTACHMENT_CLEANUP_BATCH_RECORDS, ATTACHMENT_STORAGE_GIB_OPTIONS, type AttachmentStorageGiB, type AttachmentStorageStatus } from "@shared/attachment-storage";
import type { CommandWithoutId } from "../lib/runtimeCommands";
import { INTERFACE_LOCALE } from "../lib/locale";
import { formatBytes } from "../utils/formatBytes";
import { SettingActionRow } from "./settings/SettingsLayout";
import { useSettingAction } from "./settings/useSettingAction";

const STORAGE_OPERATION_FAILED = "Storage operation did not finish. Refresh usage before trying again.";

export function AttachmentStorageSettings({ settings, disabled, request, onUpdate }: {
  settings: AppSettings;
  disabled: boolean;
  request(command: CommandWithoutId): Promise<ServerEvent>;
  onUpdate(update: Partial<AppSettings>): Promise<void>;
}): React.JSX.Element {
  const action = useSettingAction();
  const [storage, setStorage] = useState<AttachmentStorageStatus | null>(null);
  const [confirm, setConfirm] = useState<"cleanup" | "automatic" | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  const requestRef = useRef(request);
  requestRef.current = request;
  const triggerRef = useRef<HTMLButtonElement | HTMLInputElement | null>(null);
  const refreshRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef(false);
  const confirmationRef = useRef<HTMLDivElement>(null);
  const busy = action.busy;
  useEffect(() => { if (confirm) confirmationRef.current?.focus(); }, [confirm]);
  useEffect(() => {
    if (busy || confirm || !restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    const trigger = triggerRef.current;
    (trigger && !trigger.disabled ? trigger : refreshRef.current)?.focus();
  }, [busy, confirm]);
  useEffect(() => {
    let active = true;
    void requestRef.current({ type: "attachment.storage.get" }).then((event) => {
      if (active && event.type === "request.result" && event.result.kind === "attachment.storage") {
        setStorage(event.result.storage);
        setReadFailed(false);
      }
    }).catch(() => { if (active) setReadFailed(true); });
    return () => { active = false; };
  }, [revision, settings.attachmentStorageGiB, settings.autoRemoveOldAttachments]);

  const perform = async (operation: () => Promise<string | null | void>, success?: (message: string | null | void) => string | null): Promise<void> => {
    await action.run(operation, { exclusive: true, success, failure: STORAGE_OPERATION_FAILED });
    setConfirm(null);
    setRevision((value) => value + 1);
  };
  const cleanup = async (): Promise<string> => {
    const event = await requestRef.current({ type: "attachment.storage.cleanup" });
    if (event.type !== "request.result" || event.result.kind !== "attachment.storage") throw new Error("Storage result unavailable.");
    setStorage(event.result.storage);
    return `Removed ${event.result.removed?.records ?? 0} files and freed ${formatBytes(event.result.removed?.bytes ?? 0)}.`;
  };
  const blocked = disabled || busy;
  return <SettingActionRow
    id="attachment-storage"
    className="runtime-log-setting attachment-storage-setting"
    title="Attachment storage · all chats"
    description="Original images and documents kept on this device. This disk budget does not reserve RAM."
    details={<>
      <small role="status">{storage?.state === "ready"
        ? `${formatBytes(storage.bytes!)} used · ${storage.records!.toLocaleString(INTERFACE_LOCALE)} of ${storage.maxRecords.toLocaleString(INTERFACE_LOCALE)} files · ${storage.availableDiskBytes === null ? "free disk space unavailable" : `${formatBytes(storage.availableDiskBytes)} free on disk`}`
        : storage?.state === "reconciling" ? "Checking stored attachments after restart…" : !storage && !readFailed ? "Checking attachment usage…" : "Attachment usage unavailable. Refresh to check again."}</small>
      <label>Global attachment disk budget <select className="setting-select" aria-label="Global attachment disk budget" value={settings.attachmentStorageGiB} disabled={blocked} onChange={(event) => {
        const attachmentStorageGiB = Number(event.target.value) as AttachmentStorageGiB;
        void perform(() => onUpdate({ attachmentStorageGiB }));
      }}>{ATTACHMENT_STORAGE_GIB_OPTIONS.map((gib) => <option key={gib} value={gib}>{gib} GiB{gib === 16 ? " (default)" : ""}</option>)}</select></label>
      <small>Changes apply immediately. Lowering the budget keeps existing files. New attachments need at least 512 MiB left free on disk.</small>
      <label><input type="checkbox" checked={settings.autoRemoveOldAttachments} disabled={blocked} onChange={(event) => {
        if (event.target.checked) { triggerRef.current = event.currentTarget; setConfirm("automatic"); }
        else void perform(() => onUpdate({ autoRemoveOldAttachments: false }));
      }} /> Automatically remove oldest stored files when full</label>
      <small>{settings.autoRemoveOldAttachments ? "Old attachments in finished chats can be removed when new ones need space." : "Existing attachments are kept when storage fills. Increase the budget or explicitly remove old files to make room."} Files used by running chats are protected. Deleting a chat also releases its unshared files.</small>
      <small>Unsent attachments use a separate temporary disk budget of 16 GiB and 1,024 files. Removing a draft attachment frees it; abandoned temporary files are cleaned up after restart.</small>
      <small>Per message: 100 files, 50 MiB each. Images up to 50 MiB, 40 megapixels and 8,192 pixels per side are resized to 10 MiB each, 80 MiB combined; animated images share the 40-megapixel decode budget across at most 256 frames. Your provider may impose lower limits.</small>
      {confirm && <div ref={confirmationRef} tabIndex={-1} role="group" aria-label="Confirm attachment deletion">
        <strong>{confirm === "cleanup" ? `Permanently remove up to ${ATTACHMENT_CLEANUP_BATCH_RECORDS} oldest files?` : "Allow automatic removal of old files?"}</strong>
        <small>This removes original images and documents from finished chats across the app, including archived chats. Messages remain, but those attachments will no longer open. Running chats are protected.</small>
        <button type="button" className="secondary-button" disabled={blocked} onClick={() => {
          restoreFocusRef.current = true;
          void (confirm === "cleanup"
            ? perform(cleanup, (message) => message ?? null)
            : perform(() => onUpdate({ autoRemoveOldAttachments: true })));
        }}>{confirm === "cleanup" ? "Remove stored files" : "Allow automatic removal"}</button>
        <button type="button" className="secondary-button" disabled={busy} onClick={() => { setConfirm(null); triggerRef.current?.focus(); }}>Cancel</button>
      </div>}
      {readFailed && !action.notice && <small role="status">Storage usage could not be read. Refresh to try again.</small>}
    </>}
    notice={action.notice}
    actions={<>
      <button ref={refreshRef} type="button" className="secondary-button" disabled={blocked} onClick={() => { setConfirm(null); setRevision((value) => value + 1); }}>Refresh storage</button>
      <button type="button" className="secondary-button" disabled={blocked || storage?.state !== "ready" || !storage.removableRecords} onClick={(event) => { triggerRef.current = event.currentTarget; setConfirm("cleanup"); }}>Remove oldest files{storage?.removableRecords ? ` (${storage.removableRecords} · ${formatBytes(storage.removableBytes)})` : ""}</button>
    </>}
  />;
}
