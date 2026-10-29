import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { ArrowDown, ArrowUp, Check, ImageUp, Plus, Sparkles, X } from "lucide-react";

import {
  compileCustomAgentInstructions,
  CUSTOM_AGENT_BLOCK_HINTS,
  CUSTOM_AGENT_BLOCK_KINDS,
  CUSTOM_AGENT_BLOCK_LABELS,
  CUSTOM_AGENT_ICON_NAMES,
  customAgentHandleFromName,
  customAgentSkillNameSchema,
  MAX_CUSTOM_AGENT_BLOCK_CHARS,
  MAX_CUSTOM_AGENT_BLOCKS,
  MAX_CUSTOM_AGENT_COMPILED_CHARS,
  MAX_CUSTOM_AGENT_DESCRIPTION_CHARS,
  MAX_CUSTOM_AGENT_HANDLE_CHARS,
  MAX_CUSTOM_AGENT_NAME_CHARS,
  MAX_CUSTOM_AGENT_SKILL_NAME_CHARS,
  MAX_CUSTOM_AGENT_SKILLS,
  uniqueCustomAgentHandle,
  type CustomAgentAccent,
  type CustomAgentBlockKind,
  type CustomAgentDraft,
  type CustomAgentIconName,
} from "@shared/custom-agents";
import { CUSTOM_AGENT_PRESETS } from "@shared/custom-agent-presets";
import { PROJECT_COLOR_NAMES, PROJECT_COLOR_PALETTE, type ProjectColorName } from "@shared/project-colors";
import { IconButton } from "../ui";
import { SettingDisclosure, SettingNoteStatus } from "../settings/SettingsLayout";
import { useSettingAction } from "../settings/useSettingAction";
import { CUSTOM_AGENT_SYMBOLS, CustomAgentAvatar, customAgentTintStyle } from "./CustomAgentAvatar";
import { CustomAgentMenu, CustomAgentRadioGroup, type CustomAgentRadioOption } from "./CustomAgentControls";
import {
  appendCustomAgentPreset,
  cleanCustomAgentDraft,
  customAgentHandleProblem,
  formatCount,
  newCustomAgentBlock,
  saveFailureMessage,
  validateCustomAgentDraft,
} from "./customAgentDraft";
import { CUSTOM_AGENT_IMAGE_ACCEPT, readCustomAgentIcon } from "./customAgentImage";

type AccentChoice = ProjectColorName | "none";

export interface CustomAgentEditorProps {
  label: string;
  initial: CustomAgentDraft;
  linkHandle: boolean;
  otherHandles: readonly string[];
  skills: readonly string[];
  disabled: boolean;
  onCancel: () => void;
  onSave: (agent: CustomAgentDraft) => Promise<void>;
}

const SYMBOL_LABELS: Readonly<Record<CustomAgentIconName, string>> = {
  bot: "Bot",
  sparkles: "Sparkles",
  shield: "Shield",
  search: "Search",
  wrench: "Wrench",
  flask: "Flask",
  pen: "Pen",
  book: "Book",
  bug: "Bug",
  compass: "Compass",
  eye: "Eye",
  brush: "Brush",
  rocket: "Rocket",
  scale: "Scale",
  zap: "Lightning",
  braces: "Braces",
};

function lowercaseHandle(value: string): string {
  return value.toLowerCase().replace(/\s+/gu, "-").slice(0, MAX_CUSTOM_AGENT_HANDLE_CHARS);
}

export function CustomAgentEditor({ label, initial, linkHandle, otherHandles, skills, disabled, onCancel, onSave }: CustomAgentEditorProps): React.JSX.Element {
  const ids = useId();
  const action = useSettingAction();
  const [draft, setDraft] = useState(initial);
  const [linked, setLinked] = useState(linkHandle);
  const [lastSymbol, setLastSymbol] = useState<CustomAgentIconName>(initial.icon.kind === "symbol" ? initial.icon.name : "bot");
  const [imageError, setImageError] = useState<string | null>(null);
  const [skillDraft, setSkillDraft] = useState("");
  const [skillError, setSkillError] = useState<string | null>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const addBlockAnchor = useRef<HTMLDivElement>(null);
  const blockFields = useRef(new Map<string, HTMLTextAreaElement>());
  const pendingFocus = useRef<string | null>(null);

  useEffect(() => {
    nameInput.current?.focus({ preventScroll: true });
  }, []);
  useLayoutEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    pendingFocus.current = null;
    if (target === "add") addBlockAnchor.current?.querySelector("button")?.focus();
    else blockFields.current.get(target)?.focus();
  });

  const validation = useMemo(() => validateCustomAgentDraft(draft, otherHandles), [draft, otherHandles]);
  const compiled = useMemo(() => compileCustomAgentInstructions(cleanCustomAgentDraft(draft)), [draft]);
  const handleProblem = draft.handle ? customAgentHandleProblem(draft.handle, otherHandles) : null;
  const busy = action.busy;
  const update = (patch: Partial<CustomAgentDraft>): void => setDraft((current) => ({ ...current, ...patch }));
  const setName = (name: string): void => {
    setDraft((current) => ({
      ...current,
      name,
      handle: linked ? (name.trim() ? uniqueCustomAgentHandle(customAgentHandleFromName(name), otherHandles) : "") : current.handle,
    }));
  };
  const setBlocks = (blocks: CustomAgentDraft["blocks"]): void => update({ blocks });
  const moveBlock = (index: number, offset: number): void => {
    const target = index + offset;
    if (target < 0 || target >= draft.blocks.length) return;
    const blocks = [...draft.blocks];
    const [moved] = blocks.splice(index, 1);
    blocks.splice(target, 0, moved!);
    setBlocks(blocks);
  };
  const removeBlock = (index: number): void => {
    const blocks = draft.blocks.filter((_, position) => position !== index);
    pendingFocus.current = blocks[Math.min(index, blocks.length - 1)]?.id ?? "add";
    setBlocks(blocks);
  };
  const addBlock = (kind: CustomAgentBlockKind): void => {
    if (draft.blocks.length >= MAX_CUSTOM_AGENT_BLOCKS) return;
    const block = newCustomAgentBlock(kind);
    pendingFocus.current = block.id;
    setBlocks([...draft.blocks, block]);
  };
  const addPreset = (presetId: string): void => {
    const preset = CUSTOM_AGENT_PRESETS.find(({ id }) => id === presetId);
    if (preset) setDraft((current) => appendCustomAgentPreset(current, preset));
  };
  const toggleSkill = (skill: string): void => {
    setSkillError(null);
    update({ skills: draft.skills.includes(skill) ? draft.skills.filter((name) => name !== skill) : [...draft.skills, skill] });
  };
  const addSkill = (): void => {
    const parsed = customAgentSkillNameSchema.safeParse(skillDraft);
    if (!parsed.success) {
      setSkillError("Enter a skill name on one line.");
      return;
    }
    if (draft.skills.includes(parsed.data)) {
      setSkillDraft("");
      setSkillError(null);
      return;
    }
    if (draft.skills.length >= MAX_CUSTOM_AGENT_SKILLS) {
      setSkillError(`Attach up to ${MAX_CUSTOM_AGENT_SKILLS} skills.`);
      return;
    }
    update({ skills: [...draft.skills, parsed.data] });
    setSkillDraft("");
    setSkillError(null);
  };
  const save = (): void => {
    if (disabled || busy || !validation.agent) return;
    const agent = validation.agent;
    void action.run(() => onSave(agent), { success: null, failure: saveFailureMessage });
  };

  const skillNames = useMemo(() => [...new Set([...skills, ...draft.skills])], [draft.skills, skills]);
  const skillsFull = draft.skills.length >= MAX_CUSTOM_AGENT_SKILLS;
  const compiledLength = compiled.length;
  const over = compiledLength > MAX_CUSTOM_AGENT_COMPILED_CHARS;
  const image = draft.icon.kind === "image" ? draft.icon.data : null;
  const accentOptions: CustomAgentRadioOption<AccentChoice>[] = [
    { id: "none", label: "No accent", className: "custom-agent-swatch is-none", content: <span className="custom-agent-swatch-dot" aria-hidden="true" /> },
    ...PROJECT_COLOR_NAMES.map((name) => ({
      id: name,
      label: PROJECT_COLOR_PALETTE[name].label,
      className: "custom-agent-swatch",
      style: customAgentTintStyle(name),
      content: <span className="custom-agent-swatch-dot" aria-hidden="true"><Check size={12} /></span>,
    })),
  ];

  return (
    <form
      className="custom-agent-panel"
      aria-label={label}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <section className="custom-agent-group" aria-labelledby={`${ids}-identity`}>
        <h4 id={`${ids}-identity`} className="custom-agent-group-title">Identity</h4>
        <div className="custom-agent-identity">
          <CustomAgentAvatar agent={draft} size={56} className="custom-agent-identity-preview" />
          <div className="custom-agent-identity-controls">
            <CustomAgentRadioGroup
              label="Symbol"
              className="custom-agent-symbols"
              value={draft.icon.kind === "symbol" ? draft.icon.name : null}
              disabled={disabled}
              options={CUSTOM_AGENT_ICON_NAMES.map((name) => {
                const Symbol = CUSTOM_AGENT_SYMBOLS[name];
                return { id: name, label: SYMBOL_LABELS[name], className: "custom-agent-symbol", content: <Symbol size={16} aria-hidden="true" /> };
              })}
              onChange={(name) => {
                setLastSymbol(name);
                update({ icon: { kind: "symbol", name } });
              }}
            />
            <div className="custom-agent-image-actions">
              <button type="button" className="secondary-button" disabled={disabled} onClick={() => fileInput.current?.click()}>
                <ImageUp size={14} aria-hidden="true" />Upload PNG
              </button>
              {image && (
                <button type="button" className="secondary-button" disabled={disabled} onClick={() => update({ icon: { kind: "symbol", name: lastSymbol } })}>
                  Remove image
                </button>
              )}
              <input
                ref={fileInput}
                type="file"
                hidden
                accept={CUSTOM_AGENT_IMAGE_ACCEPT}
                aria-label="Agent image"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = "";
                  if (!file) return;
                  setImageError(null);
                  void readCustomAgentIcon(file).then(
                    (data) => update({ icon: { kind: "image", data } }),
                    (error: unknown) => setImageError(error instanceof Error ? error.message : "The image could not be read."),
                  );
                }}
              />
              {imageError && <small className="custom-agent-field-error" role="alert">{imageError}</small>}
            </div>
            <CustomAgentRadioGroup<AccentChoice>
              label="Accent"
              className="custom-agent-swatches"
              value={draft.accent ?? "none"}
              disabled={disabled}
              options={accentOptions}
              onChange={(choice) => update({ accent: (choice === "none" ? null : choice) as CustomAgentAccent })}
            />
          </div>
        </div>
        <div className="custom-agent-fields">
          <div className="custom-agent-field">
            <label htmlFor={`${ids}-name`}>Name</label>
            <input
              ref={nameInput}
              id={`${ids}-name`}
              className="setting-input"
              value={draft.name}
              maxLength={MAX_CUSTOM_AGENT_NAME_CHARS}
              autoComplete="off"
              disabled={disabled}
              placeholder="Reviewer"
              onChange={(event) => setName(event.currentTarget.value)}
            />
          </div>
          <div className="custom-agent-field">
            <label htmlFor={`${ids}-handle`}>Handle</label>
            <input
              id={`${ids}-handle`}
              className="setting-input custom-agent-handle-input"
              value={draft.handle}
              maxLength={MAX_CUSTOM_AGENT_HANDLE_CHARS}
              autoComplete="off"
              spellCheck={false}
              disabled={disabled}
              placeholder="reviewer"
              aria-invalid={handleProblem ? true : undefined}
              aria-describedby={`${ids}-handle-help`}
              onChange={(event) => {
                setLinked(false);
                update({ handle: lowercaseHandle(event.currentTarget.value) });
              }}
            />
            <small id={`${ids}-handle-help`} className={clsx("custom-agent-field-help", handleProblem && "is-error")}>
              {handleProblem ?? `Call it with /calling ${draft.handle || "handle"}`}
            </small>
          </div>
          <div className="custom-agent-field is-wide">
            <label htmlFor={`${ids}-description`}>Description</label>
            <input
              id={`${ids}-description`}
              className="setting-input"
              value={draft.description}
              maxLength={MAX_CUSTOM_AGENT_DESCRIPTION_CHARS}
              autoComplete="off"
              disabled={disabled}
              placeholder="What it is for, in one line."
              onChange={(event) => update({ description: event.currentTarget.value.replace(/[\r\n]+/gu, " ") })}
            />
          </div>
        </div>
      </section>

      <section className="custom-agent-group" aria-labelledby={`${ids}-instructions`}>
        <div className="custom-agent-group-heading">
          <h4 id={`${ids}-instructions`} className="custom-agent-group-title">Instructions</h4>
          <span className={clsx("custom-agent-budget", over && "is-over")}>
            {formatCount(compiledLength)} of {formatCount(MAX_CUSTOM_AGENT_COMPILED_CHARS)}
          </span>
        </div>
        {draft.blocks.length > 0 && (
          <ol className="custom-agent-blocks">
            {draft.blocks.map((block, index) => {
              const kindLabel = CUSTOM_AGENT_BLOCK_LABELS[block.kind];
              const name = `${kindLabel} block ${index + 1}`;
              return (
                <li key={block.id} className="custom-agent-block" data-kind={block.kind}>
                  <div className="custom-agent-block-head">
                    <span className="custom-agent-block-kind">{kindLabel}</span>
                    <div className="custom-agent-block-actions" role="group" aria-label={`${name} actions`}>
                      <IconButton label={`Move ${name} up`} aria-disabled={index === 0 || undefined} disabled={disabled} onClick={() => moveBlock(index, -1)}>
                        <ArrowUp size={14} aria-hidden="true" />
                      </IconButton>
                      <IconButton label={`Move ${name} down`} aria-disabled={index === draft.blocks.length - 1 || undefined} disabled={disabled} onClick={() => moveBlock(index, 1)}>
                        <ArrowDown size={14} aria-hidden="true" />
                      </IconButton>
                      <IconButton label={`Remove ${name}`} disabled={disabled} onClick={() => removeBlock(index)}>
                        <X size={14} aria-hidden="true" />
                      </IconButton>
                    </div>
                  </div>
                  <textarea
                    ref={(node) => {
                      if (node) blockFields.current.set(block.id, node);
                      else blockFields.current.delete(block.id);
                    }}
                    className="setting-input custom-agent-block-body"
                    aria-label={name}
                    rows={2}
                    value={block.body}
                    maxLength={MAX_CUSTOM_AGENT_BLOCK_CHARS}
                    placeholder={CUSTOM_AGENT_BLOCK_HINTS[block.kind]}
                    disabled={disabled}
                    onChange={(event) => {
                      const body = event.currentTarget.value;
                      setDraft((current) => ({
                        ...current,
                        blocks: current.blocks.map((item) => (item.id === block.id ? { ...item, body } : item)),
                      }));
                    }}
                  />
                </li>
              );
            })}
          </ol>
        )}
        <div className="custom-agent-block-tools" ref={addBlockAnchor}>
          <CustomAgentMenu<CustomAgentBlockKind>
            label="Add block"
            icon={<Plus size={14} aria-hidden="true" />}
            disabled={disabled || draft.blocks.length >= MAX_CUSTOM_AGENT_BLOCKS}
            items={CUSTOM_AGENT_BLOCK_KINDS.map((kind) => ({ id: kind, label: CUSTOM_AGENT_BLOCK_LABELS[kind], hint: CUSTOM_AGENT_BLOCK_HINTS[kind] }))}
            onPick={addBlock}
          />
          <CustomAgentMenu<string>
            label="Add from preset"
            icon={<Sparkles size={14} aria-hidden="true" />}
            disabled={disabled}
            items={CUSTOM_AGENT_PRESETS.map((preset) => ({
              id: preset.id,
              label: preset.name,
              hint: preset.summary,
              leading: <CustomAgentAvatar agent={preset} size={20} />,
            }))}
            onPick={addPreset}
          />
        </div>
      </section>

      <section className="custom-agent-group" aria-labelledby={`${ids}-skills`}>
        <h4 id={`${ids}-skills`} className="custom-agent-group-title">Skills</h4>
        {skillNames.length > 0 && (
          <div className="custom-agent-skills" role="group" aria-label="Skills">
            {skillNames.map((skill) => {
              const selected = draft.skills.includes(skill);
              return (
                <button
                  key={skill}
                  type="button"
                  className="custom-agent-skill"
                  aria-pressed={selected}
                  aria-disabled={(!selected && skillsFull) || undefined}
                  disabled={disabled}
                  onClick={() => { if (selected || !skillsFull) toggleSkill(skill); }}
                >
                  {selected && <Check size={12} aria-hidden="true" />}
                  {skill}
                </button>
              );
            })}
          </div>
        )}
        <div className="custom-agent-skill-entry">
          <input
            className="setting-input"
            value={skillDraft}
            maxLength={MAX_CUSTOM_AGENT_SKILL_NAME_CHARS}
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
            placeholder="Skill name"
            aria-label="Add a skill by name"
            aria-invalid={skillError ? true : undefined}
            aria-describedby={skillError ? `${ids}-skill-error` : undefined}
            onChange={(event) => {
              setSkillDraft(event.currentTarget.value);
              setSkillError(null);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              addSkill();
            }}
          />
          <button type="button" className="secondary-button" disabled={disabled || !skillDraft.trim()} onClick={addSkill}>Add skill</button>
        </div>
        {skillError && <small id={`${ids}-skill-error`} className="custom-agent-field-error" role="alert">{skillError}</small>}
        <small className="custom-agent-note">Skills are attached natively for Claude and listed in the instructions for other providers.</small>
      </section>

      <SettingDisclosure summary="What the agent receives" className="custom-agent-preview-disclosure">
        <pre className="custom-agent-preview">{compiled}</pre>
      </SettingDisclosure>

      <div className="custom-agent-panel-footer">
        <span className="custom-agent-panel-status">
          {validation.message && <small className="custom-agent-validation">{validation.message}</small>}
          <SettingNoteStatus notice={action.notice} />
        </span>
        <button type="button" className="secondary-button" onClick={onCancel}>Cancel</button>
        <button
          type="submit"
          className="primary-button"
          disabled={disabled || !validation.agent}
          aria-disabled={busy || undefined}
        >
          Save
        </button>
      </div>
    </form>
  );
}
