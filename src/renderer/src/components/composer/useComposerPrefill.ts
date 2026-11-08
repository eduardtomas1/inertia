import {
  useEffect,
  useEffectEvent,
  type Dispatch,
  type SetStateAction,
} from "react";

import { registerComposerPrefillTarget } from "../../utils/composerPrefill";
import { insertComposerSkillToken } from "../../utils/composerSkillToken";

interface CurrentValue<T> {
  current: T;
}

interface ComposerPrefillOptions {
  conversationIdRef: CurrentValue<string>;
  draftValueRef: CurrentValue<string>;
  markEditorChanged: (conversationId: string) => void;
  persistDraftChange: (
    conversationId: string,
    previous: string,
    next: string,
  ) => void;
  setMessage: Dispatch<SetStateAction<string>>;
  textareaRef: CurrentValue<HTMLTextAreaElement | null>;
}

function mergeComposerPrefill(current: string, text: string): string {
  const skillPrefill = /^\$([A-Za-z0-9][A-Za-z0-9._:-]{0,159})\s*$/u.exec(text);
  if (skillPrefill?.[1]) {
    return insertComposerSkillToken(
      current,
      skillPrefill[1],
      current.length,
      current.length,
    ).value;
  }
  return current.trim() ? `${current.trim()}\n\n${text}` : text;
}

export function useComposerPrefill({
  conversationIdRef,
  draftValueRef,
  markEditorChanged,
  persistDraftChange,
  setMessage,
  textareaRef,
}: ComposerPrefillOptions): void {
  const applyPrefill = useEffectEvent((text: string): void => {
    setMessage((current) => {
      const next = mergeComposerPrefill(current, text);
      if (next !== current) {
        markEditorChanged(conversationIdRef.current);
        draftValueRef.current = next;
        persistDraftChange(conversationIdRef.current, current, next);
      }
      return next;
    });
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  });

  useEffect(() => registerComposerPrefillTarget({
    conversationId: () => conversationIdRef.current,
    receive: (text) => applyPrefill(text),
  }), [conversationIdRef]);
}
