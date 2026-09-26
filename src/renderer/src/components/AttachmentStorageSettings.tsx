import { useEffect, useRef, useState } from "react";
import type { AppSettings, ServerEvent } from "@shared/contracts";
import { ATTACHMENT_CLEANUP_BATCH_RECORDS, ATTACHMENT_STORAGE_GIB_OPTIONS, type AttachmentStorageGiB, type AttachmentStorageStatus } from "@shared/attachment-storage";
import type { CommandWithoutId } from "../lib/runtimeCommands";

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GiB` : `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}

export function AttachmentStorageSettings({ settings, disabled, request, onUpdate }: {
  settings: AppSettings;
  disabled: boolean;
  request(command: CommandWithoutId): Promise<ServerEvent>;
  onUpdate(update: Partial<AppSettings>): Promise<void>;
}): React.JSX.Element {
  const [storage, setStorage] = useState<AttachmentStorageStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<"cleanup" | "automatic" | null>(null);
  const [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0);
  const requestRef = useRef(request);
  requestRef.current = request;
  const mounted = useRef(true);
  const busyRef = useRef(false);
  const triggerRef = useRef<HTMLElement | null>(null);
  const confirmationRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (confirm) confirmationRef.current?.focus(); }, [confirm]);
  useEffect(() => {
    mounted.current = true;
    let active = true;
    void requestRef.current({ type: "attachment.storage.get" }).then((event) => {
      if (active && event.type === "request.result" && event.result.kind === "attachment.storage") setStorage(event.result.storage);
    }).catch(() => { if (active) setNotice("Storage usage could not be read. Refresh to try again."); });
    return () => { active = false; mounted.current = false; };
  }, [revision, settings.attachmentStorageGiB, settings.autoRemoveOldAttachments]);

  const perform = async (operation: () => Promise<void>): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setNotice("");
    try { await operation(); }
    catch { if (mounted.current) setNotice("Storage operation did not finish. Refresh usage before trying again."); }
    finally {
      busyRef.current = false;
      if (mounted.current) { setBusy(false); setConfirm(null); setRevision((value) => value + 1); }
    }
  };
  const cleanup = async (): Promise<void> => {
    const event = await requestRef.current({ type: "attachment.storage.cleanup" });
    if (event.type !== "request.result" || event.result.kind !== "attachment.storage") throw new Error("Storage result unavailable.");
    if (mounted.current) {
      setStorage(event.result.storage);
      setNotice(`Removed ${event.result.removed?.records ?? 0} files and freed ${size(event.result.removed?.bytes ?? 0)}.`);
    }
  };
  const blocked = disabled || busy;
  return <div className="codex-binary-path runtime-log-setting attachment-storage-setting">
    <span>
      <strong>Attachment storage · all chats</strong>
      <small>Original images and documents kept on this device. This disk budget does not reserve RAM.</small>
      <small role="status">{storage?.state === "ready"
        ? `${size(storage.bytes!)} used · ${storage.records!.toLocaleString()} of ${storage.maxRecords.toLocaleString()} files · ${storage.availableDiskBytes === null ? "free disk space unavailable" : `${size(storage.availableDiskBytes)} free on disk`}`
        : storage?.state === "reconciling" ? "Checking stored attachments after restart…" : "Attachment usage unavailable. Refresh to check again."}</small>
      <label>Global attachment disk budget <select aria-label="Global attachment disk budget" value={settings.attachmentStorageGiB} disabled={blocked} onChange={(event) => {
        const attachmentStorageGiB = Number(event.target.value) as AttachmentStorageGiB;
        void perform(() => onUpdate({ attachmentStorageGiB }));
      }}>{ATTACHMENT_STORAGE_GIB_OPTIONS.map((gib) => <option key={gib} value={gib}>{gib} GiB{gib === 16 ? " (default)" : ""}</option>)}</select></label>
      <small>Changes apply immediately. Lowering the budget keeps existing files. New attachments need at least 512 MiB left free on disk.</small>
      <label><input type="checkbox" checked={settings.autoRemoveOldAttachments} disabled={blocked} onChange={(event) => {
        if (event.target.checked) { triggerRef.current = event.currentTarget; setConfirm("automatic"); }
        else void perform(() => onUpdate({ autoRemoveOldAttachments: false }));
      }} /> Automatically remove oldest stored files when full</label>
      <small>{settings.autoRemoveOldAttachments ? "Old attachments in finished chats can be removed when new ones need space." : "Existing attachments are kept when storage fills. Increase the budget or explicitly remove old files to make room."} Files used by running chats are protected. Deleting a chat also releases its unshared files.</small>
      <small>Unsent attachments use a separate temporary disk budget of 1 GiB and 1,024 files. Removing a draft attachment frees it; abandoned temporary files are cleaned up after restart.</small>
      <small>Per message: 8 attachments, 20 MiB total, 10 MiB per file. Images: 40 megapixels, 8,192 pixels per side, 256 frames within the same 40-megapixel decode budget. Your provider may impose lower limits.</small>
      {confirm && <div ref={confirmationRef} tabIndex={-1} role="group" aria-label="Confirm attachment deletion">
        <strong>{confirm === "cleanup" ? `Permanently remove up to ${ATTACHMENT_CLEANUP_BATCH_RECORDS} oldest files?` : "Allow automatic removal of old files?"}</strong>
        <small>This removes original images and documents from finished chats across the app, including archived chats. Messages remain, but those attachments will no longer open. Running chats are protected.</small>
        <button type="button" className="secondary-button" disabled={blocked} onClick={() => void perform(confirm === "cleanup" ? cleanup : () => onUpdate({ autoRemoveOldAttachments: true }))}>{confirm === "cleanup" ? "Remove stored files" : "Allow automatic removal"}</button>
        <button type="button" className="secondary-button" disabled={busy} onClick={() => { setConfirm(null); triggerRef.current?.focus(); }}>Cancel</button>
      </div>}
      {notice && <small role="status">{notice}</small>}
    </span>
    <div>
      <button type="button" className="secondary-button" disabled={blocked} onClick={() => { setConfirm(null); setRevision((value) => value + 1); }}>Refresh storage</button>
      <button type="button" className="secondary-button" disabled={blocked || storage?.state !== "ready" || !storage.removableRecords} onClick={(event) => { triggerRef.current = event.currentTarget; setConfirm("cleanup"); }}>Remove oldest files{storage?.removableRecords ? ` (${storage.removableRecords} · ${size(storage.removableBytes)})` : ""}</button>
    </div>
  </div>;
}
