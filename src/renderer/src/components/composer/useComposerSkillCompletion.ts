import { useEffect, useId, useState } from "react";

import type { AgentSkillSummary } from "@shared/contracts";
import {
  nextSidebarNavigationIndex,
  type SidebarNavigationKey,
} from "../../utils/sidebarModel";

export function useComposerSkillCompletion(
  skills: readonly AgentSkillSummary[],
  message: string,
  menuOpen: boolean,
) {
  const [selection, setSelection] = useState<{ value: string; start: number; end: number } | null>(null);
  const caret = selection?.value === message ? selection.start : message.length;
  const selectedText = selection?.value === message && selection.start !== selection.end;
  const skillQuery = selectedText ? null : /(?:^|\s)\$([\w.:-]*)$/u
    .exec(message.slice(0, caret))?.[1].toLowerCase() ?? null;
  const onSkillSelectionChange = (editor: HTMLTextAreaElement): void => {
    setSelection({ value: editor.value, start: editor.selectionStart, end: editor.selectionEnd });
  };
  const skillListboxId = `${useId()}-skills`;
  const [highlightedSkillId, setHighlightedSkillId] = useState<string | null>(null);
  const skillMatches = skillQuery === null
    ? []
    : skills.filter((skill) => skill.enabled && skill.name
      .toLowerCase().startsWith(skillQuery));
  const activeSkill = skillMatches.find((skill) => skill.id === highlightedSkillId)
    ?? skillMatches[0]
    ?? null;
  useEffect(() => setHighlightedSkillId(null), [skillQuery]);
  const moveSkill = (key: SidebarNavigationKey): void => {
    if (skillMatches.length === 0) return;
    const activeIndex = skillMatches.findIndex((skill) => skill.id === activeSkill?.id);
    const nextIndex = nextSidebarNavigationIndex(
      activeIndex,
      key,
      skillMatches.length,
    );
    setHighlightedSkillId(skillMatches[nextIndex]!.id);
  };
  return {
    skillQuery,
    skillListboxId,
    skillOpen: menuOpen,
    onSkillSelectionChange,
    activeSkill,
    moveSkill,
  };
}
