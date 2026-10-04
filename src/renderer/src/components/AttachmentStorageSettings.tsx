import { useEffect, useRef, useState } from "react";
import type { AppSettings, ServerEvent } from "@shared/contracts";
import { ATTACHMENT_CLEANUP_BATCH_RECORDS, ATTACHMENT_STORAGE_GIB_OPTIONS, type AttachmentStorageGiB, type AttachmentStorageStatus } from "@shared/attachment-storage";
import type { CommandWithoutId } from "../lib/runtimeCommands";
import { INTERFACE_LOCALE } from "../lib/locale";
import { formatBytes } from "../utils/formatBytes";
import { Switch } from "./ui";
import { SettingSelect } from "./settings/SettingControls";
import { SettingActionRow, SettingRow } from "./settings/SettingsLayout";
import { useSettingAction } from "./settings/useSettingAction";

const STORAGE_OPERATION_FAILED = "Storage operation did not finish. Refresh usage before trying again.";
const LIMIT_OPTIONS = ATTACHMENT_STORAGE_GIB_OPTIONS.map((gib) => ({ value: String(gib), label: `${gib} GiB${gib === 16 ? " (default)" : ""}` }));

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
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const refreshRef = useRef<HTMLButtonElement>(null);
  const autoRemoveRef = useRef<HTMLSpanElement>(null);
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
  return <div className="attachment-storage-setting">
    <SettingActionRow
      id="attachment-storage"
      className="runtime-log-setting"
      title="Attachment storage"
      description="Original images and documents kept on this device."
      details={<>
        <small role="status" className="data-facts">{storage?.state === "ready"
          ? `${formatBytes(storage.bytes!)} used · ${storage.records!.toLocaleString(INTERFACE_LOCALE)} of ${storage.maxRecords.toLocaleString(INTERFACE_LOCALE)} files · ${storage.availableDiskBytes === null ? "free disk space unavailable" : `${formatBytes(storage.availableDiskBytes)} free`}`
          : storage?.state === "reconciling" ? "Checking stored attachments after restart…" : !storage && !readFailed ? "Checking attachment usage…" : "Attachment usage unavailable. Refresh to check again."}</small>
        {readFailed && !action.notice && <small role="status">Storage usage could not be read. Refresh to try again.</small>}
      </>}
      actions={<button ref={refreshRef} type="button" className="secondary-button" disabled={blocked} onClick={() => { setConfirm(null); setRevision((value) => value + 1); }}>Refresh storage</button>}
    />
    <SettingSelect
      id="attachment-storage-limit"
      title="Attachment storage limit"
      description="Lowering it keeps existing files."
      value={String(settings.attachmentStorageGiB)}
      options={LIMIT_OPTIONS}
      disabled={blocked}
      onChange={(value) => onUpdate({ attachmentStorageGiB: Number(value) as AttachmentStorageGiB })}
    />
    <SettingRow
      id="attachment-auto-remove"
      title="Free space automatically when full"
      description="Removes old attachments from finished chats when new ones need space. Running chats are protected."
    >
      <span ref={autoRemoveRef}>
        <Switch
          label="Free space automatically when full"
          checked={settings.autoRemoveOldAttachments}
          disabled={blocked}
          onChange={(next) => {
            triggerRef.current = autoRemoveRef.current?.querySelector("button") ?? null;
            if (next) setConfirm("automatic");
            else void perform(() => onUpdate({ autoRemoveOldAttachments: false }));
          }}
        />
      </span>
    </SettingRow>
    <SettingActionRow
      id="attachment-remove-oldest"
      className="runtime-log-setting"
      title="Remove oldest files"
      description="Deleting a chat also releases its unshared files."
      notice={action.notice}
      actions={<button type="button" className="secondary-button" disabled={blocked || storage?.state !== "ready" || !storage.removableRecords} onClick={(event) => { triggerRef.current = event.currentTarget; setConfirm("cleanup"); }}>Remove oldest files{storage?.removableRecords ? ` (${storage.removableRecords} · ${formatBytes(storage.removableBytes)})` : ""}</button>}
    />
    {confirm && <div
      className="attachment-storage-confirm"
      ref={confirmationRef}
      tabIndex={-1}
      role="group"
      aria-label="Confirm attachment deletion"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || busy) return;
        event.preventDefault();
        setConfirm(null);
        triggerRef.current?.focus();
      }}
    >
      <strong>{confirm === "cleanup" ? `Permanently remove up to ${ATTACHMENT_CLEANUP_BATCH_RECORDS} oldest files?` : "Allow automatic removal of old files?"}</strong>
      <small>This removes original images and documents from finished chats across the app, including archived chats. Messages remain, but those attachments will no longer open. Running chats are protected.</small>
      <div>
        <button type="button" className="secondary-button" disabled={busy} onClick={() => { setConfirm(null); triggerRef.current?.focus(); }}>Cancel</button>
        <button type="button" className="secondary-button is-danger" disabled={blocked} onClick={() => {
          restoreFocusRef.current = true;
          void (confirm === "cleanup"
            ? perform(cleanup, (message) => message ?? null)
            : perform(() => onUpdate({ autoRemoveOldAttachments: true })));
        }}>{confirm === "cleanup" ? "Remove stored files" : "Allow automatic removal"}</button>
      </div>
    </div>}
  </div>;
}
