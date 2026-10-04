import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { Play, Trash2, Upload } from "lucide-react";
import type { AppSettings } from "@shared/contracts/app";
import {
  BUILT_IN_COMPLETION_SOUNDS,
  COMPLETION_SOUND_LIBRARY_MAX,
  COMPLETION_SOUND_MAX_PLAY_SECONDS,
  COMPLETION_SOUND_NAME_MAX_LENGTH,
  completionSoundName,
  isBuiltInCompletionSound,
  parseCompletionSoundSettings,
  type BuiltInCompletionSound,
  type CompletionSoundChoice,
  type CompletionSoundSettings as SoundSettings,
  type CustomCompletionSound,
} from "@shared/completion-sound";
import { useRovingRadios } from "../../hooks/useRovingRadios";
import {
  decodeCustomCompletionSound,
  forgetCustomCompletionSound,
  playCompletionSound,
} from "../../utils/completionSoundPlayer";
import { IconButton, Switch } from "../ui";
import { SettingSelect, type SettingOption } from "../settings/SettingControls";
import { SettingRow } from "../settings/SettingsLayout";
import "./CompletionSoundSettings.css";

const SOUND_LABELS: Readonly<Record<BuiltInCompletionSound, { label: string; detail: string }>> = {
  chime: { label: "Chime", detail: "Two bright notes" },
  glass: { label: "Glass", detail: "A clear, high ping" },
  marimba: { label: "Marimba", detail: "Three soft wooden notes" },
  bloom: { label: "Bloom", detail: "A warm, slow chord" },
  pop: { label: "Pop", detail: "Bubbles and a soft ring" },
  bell: { label: "Bell", detail: "A long ringing bell" },
};

export const LONG_RUN_THRESHOLDS = [30, 60, 120, 300, 600, 900] as const;

export function longRunLabel(seconds: number): string {
  return seconds < 60 ? `${seconds} s` : `${seconds / 60} min`;
}

const EVERY_TASK = "every";

const PLAY_AFTER_OPTIONS: readonly SettingOption<string>[] = [
  { value: EVERY_TASK, label: "After every task" },
  ...LONG_RUN_THRESHOLDS.map((seconds) => ({ value: String(seconds), label: `After tasks longer than ${longRunLabel(seconds)}` })),
];

function sameSettings(a: SoundSettings, b: SoundSettings): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function SoundName({ sound, disabled, focusRequest, onRename }: {
  sound: CustomCompletionSound;
  disabled: boolean;
  focusRequest: boolean;
  onRename: (name: string) => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    if (!focusRequest) return;
    input.current?.focus();
    input.current?.select();
  }, [focusRequest]);
  const save = (): void => {
    if (draft === null) return;
    setDraft(null);
    const name = completionSoundName(draft);
    if (name !== sound.name) onRename(name);
  };
  return (
    <input ref={input} className="completion-sound-name" value={draft ?? sound.name} disabled={disabled}
      maxLength={COMPLETION_SOUND_NAME_MAX_LENGTH} aria-label={`Name for ${sound.name}`} spellCheck={false}
      onChange={(event) => setDraft(event.target.value)} onBlur={save}
      onKeyDown={(event) => {
        if (event.key === "Enter") { event.preventDefault(); save(); event.currentTarget.blur(); }
        if (event.key === "Escape" && draft !== null) { event.preventDefault(); event.stopPropagation(); setDraft(null); }
      }} />
  );
}

export function CompletionSoundSettings({
  settings,
  disabled,
  onUpdate,
}: {
  settings: unknown;
  disabled: boolean;
  onUpdate: (settings: Partial<AppSettings>) => Promise<void> | void;
}): React.JSX.Element {
  const serialized = JSON.stringify(settings ?? null);
  const saved = useMemo(() => parseCompletionSoundSettings(JSON.parse(serialized)), [serialized]);
  const [pending, setPending] = useState<SoundSettings | null>(null);
  const [importing, setImporting] = useState(false);
  const [removing, setRemoving] = useState(0);
  const [named, setNamed] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "error" | "info"; text: string } | null>(null);
  const latest = useRef<SoundSettings>(saved);
  const importRef = useRef<HTMLButtonElement>(null);
  const removeButtons = useRef(new Map<string, HTMLButtonElement>());
  const removalFocus = useRef<string | null | undefined>(undefined);
  const value = pending ?? saved;
  latest.current = value;
  const canImport = Boolean(window.inertia?.importCompletionSound);
  const full = value.library.length >= COMPLETION_SOUND_LIBRARY_MAX;

  useEffect(() => {
    if (pending && sameSettings(pending, saved)) setPending(null);
  }, [pending, saved]);

  useLayoutEffect(() => {
    const target = removalFocus.current;
    if (target === undefined) return;
    removalFocus.current = undefined;
    (target === null ? importRef.current : removeButtons.current.get(target))?.focus();
  }, [value.library]);

  const commit = (patch: Partial<SoundSettings>, report = true): Promise<boolean> => {
    const next = { ...latest.current, ...patch };
    if (sameSettings(next, latest.current)) return Promise.resolve(true);
    latest.current = next;
    setPending(next);
    return Promise.resolve(onUpdate({ completionSound: next })).then(() => true, (cause: unknown) => {
      setPending((current) => (current === next ? null : current));
      if (!report) throw cause;
      setNotice({ tone: "error", text: "The sound setting could not be saved. Try again." });
      return false;
    });
  };

  const preview = (sound: CompletionSoundChoice, library = latest.current.library): void => {
    void playCompletionSound({ sound, library }).catch(() => undefined);
  };

  const choices: CompletionSoundChoice[] = [...BUILT_IN_COMPLETION_SOUNDS, ...value.library.map(({ file }) => file)];
  const sounds = useRovingRadios(choices, value.sound, (sound) => {
    void commit({ sound });
    preview(sound);
  });

  const importSound = async (): Promise<void> => {
    const bridge = window.inertia;
    if (!bridge?.importCompletionSound || importing || removing) return;
    setImporting(true);
    setNotice(null);
    try {
      const result = await bridge.importCompletionSound(latest.current.library.map(({ file }) => file));
      if (result.status === "cancelled") return;
      if (result.status === "rejected") {
        setNotice({ tone: "error", text: result.message });
        return;
      }
      const existing = latest.current.library.find(({ file }) => file === result.sound.file);
      if (existing) {
        void commit({ sound: existing.file });
        preview(existing.file);
        setNotice({ tone: "info", text: `That clip is already in your sounds as “${existing.name}”.` });
        return;
      }
      forgetCustomCompletionSound(result.sound.file);
      const decoded = await decodeCustomCompletionSound(result.sound.file);
      if (!decoded) {
        forgetCustomCompletionSound(result.sound.file);
        await bridge.removeCompletionSound?.(result.sound.file).catch(() => undefined);
        setNotice({ tone: "error", text: "That file could not be played. Try a WAV or MP3 file." });
        return;
      }
      const library = [...latest.current.library, result.sound];
      void commit({ sound: result.sound.file, library });
      preview(result.sound.file, library);
      setNamed(result.sound.file);
      if (decoded.duration > COMPLETION_SOUND_MAX_PLAY_SECONDS + 0.05) {
        setNotice({ tone: "info", text: `This clip is ${decoded.duration.toFixed(1)} s long, so only the first ${COMPLETION_SOUND_MAX_PLAY_SECONDS} seconds will play.` });
      }
    } catch {
      setNotice({ tone: "error", text: "The sound could not be imported. Try again." });
    } finally {
      setImporting(false);
    }
  };

  const rename = (file: string, name: string): void => {
    void commit({ library: latest.current.library.map((sound) => (sound.file === file ? { ...sound, name } : sound)) });
  };

  const removeSound = async (sound: CustomCompletionSound, focused: boolean): Promise<void> => {
    setNotice(null);
    setRemoving((count) => count + 1);
    const index = latest.current.library.findIndex(({ file }) => file === sound.file);
    const library = latest.current.library.filter(({ file }) => file !== sound.file);
    if (focused) removalFocus.current = (library[index] ?? library[index - 1])?.file ?? null;
    const saved = await commit({ library, sound: latest.current.sound === sound.file ? "chime" : latest.current.sound });
    if (saved) {
      forgetCustomCompletionSound(sound.file);
      await window.inertia?.removeCompletionSound?.(sound.file).catch(() => undefined);
    }
    setRemoving((count) => count - 1);
  };

  return (
    <div className="completion-sound-settings" data-setting-id="completion-sound">
      <SettingRow id="completion-sound-enabled" title="Sound when a task ends" description="Play a short sound when an agent finishes or stops with an error. Desktop notifications are unchanged.">
        <Switch label="Sound when a task ends" checked={value.enabled} disabled={disabled} onChange={(enabled) => {
          void commit({ enabled });
          if (enabled) preview(latest.current.sound);
        }} />
      </SettingRow>
      <SettingSelect
        id="completion-sound-when"
        title="Play sound"
        value={value.longRunsOnly ? String(value.longRunSeconds) : EVERY_TASK}
        options={PLAY_AFTER_OPTIONS}
        disabled={disabled}
        inactive={!value.enabled}
        onChange={(choice) => commit(
          choice === EVERY_TASK ? { longRunsOnly: false } : { longRunsOnly: true, longRunSeconds: Number(choice) },
          false,
        ).then(() => undefined)}
      />
      {value.enabled && (
        <div className="completion-sound-options">
          <div className="completion-sound-heading">
            <span id="completion-sound-label">Sound</span>
            <button type="button" className="completion-sound-button" disabled={disabled} onClick={() => preview(value.sound)}>
              <Play size={12} aria-hidden="true" />Preview
            </button>
          </div>
          <div className="completion-sound-choices" role="radiogroup" aria-labelledby="completion-sound-label" {...sounds.groupProps}>
            {choices.map((sound) => {
              const radio = sounds.radioProps(sound);
              const custom = value.library.find(({ file }) => file === sound);
              return (
                <button type="button" key={sound} {...radio} disabled={disabled}
                  className={clsx("completion-sound-choice", radio["aria-checked"] && "is-active")}>
                  <strong>{isBuiltInCompletionSound(sound) ? SOUND_LABELS[sound].label : custom?.name}</strong>
                  <small>{isBuiltInCompletionSound(sound) ? SOUND_LABELS[sound].detail : "Your sound"}</small>
                </button>
              );
            })}
          </div>
          {canImport && (
            <div className="completion-sound-library">
              <div className="completion-sound-heading">
                <span id="completion-sound-library-label">Your sounds</span>
                <button ref={importRef} type="button" className="completion-sound-button" disabled={disabled || full}
                  aria-disabled={importing || removing > 0 || undefined} onClick={() => void importSound()}>
                  <Upload size={12} aria-hidden="true" />{importing ? "Importing…" : "Import sound…"}
                </button>
              </div>
              {value.library.length > 0 && (
                <ul aria-labelledby="completion-sound-library-label">
                  {value.library.map((sound) => (
                    <li key={sound.file}>
                      <SoundName sound={sound} disabled={disabled} focusRequest={named === sound.file}
                        onRename={(name) => rename(sound.file, name)} />
                      <IconButton label={`Preview ${sound.name}`} disabled={disabled} onClick={() => preview(sound.file)}><Play size={13} /></IconButton>
                      <IconButton label={`Remove ${sound.name}`} disabled={disabled || importing}
                        ref={(node) => {
                          if (node) removeButtons.current.set(sound.file, node);
                          else removeButtons.current.delete(sound.file);
                        }}
                        onClick={(event) => void removeSound(sound, document.activeElement === event.currentTarget)}><Trash2 size={13} /></IconButton>
                    </li>
                  ))}
                </ul>
              )}
              <small>
                {full
                  ? `You can keep up to ${COMPLETION_SOUND_LIBRARY_MAX} sounds. Remove one to import another.`
                  : "Import short clips and give each a name. WAV, MP3, OGG, FLAC or M4A up to 1 MB; the first 3 seconds play."}
              </small>
            </div>
          )}
          {notice && <p className={clsx("completion-sound-notice", notice.tone === "error" && "is-error")} role={notice.tone === "error" ? "alert" : "status"}>{notice.text}</p>}
        </div>
      )}
    </div>
  );
}
