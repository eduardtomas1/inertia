import { useId } from "react";

import type { PromptCacheTtl } from "@shared/compact-on-return";

export const PROMPT_CACHE_NOTE = "A 1-hour cache costs more to write and less to resume after a break; worth it when you return to a chat after 5 to 60 minutes.";

const CHOICES: readonly { value: PromptCacheTtl; label: string }[] = [
  { value: "5m", label: "5 minutes (default)" },
  { value: "1h", label: "1 hour" },
];

export function promptCacheSummary(ttl: PromptCacheTtl | null | undefined): string {
  return ttl === "1h" ? "1-hour prompt cache" : "5-minute prompt cache";
}

export function PromptCacheChoice({
  value,
  disabled = false,
  onChange,
}: {
  value: PromptCacheTtl;
  disabled?: boolean;
  onChange: (value: PromptCacheTtl) => void;
}): React.JSX.Element {
  const name = useId();
  const noteId = useId();
  return (
    <fieldset className="backend-model-choice backend-prompt-cache" aria-describedby={noteId} disabled={disabled}>
      <legend>Prompt cache</legend>
      {CHOICES.map((choice) => (
        <label key={choice.value}>
          <input
            type="radio"
            name={name}
            value={choice.value}
            checked={value === choice.value}
            onChange={() => onChange(choice.value)}
          />
          <span><strong>{choice.label}</strong></span>
        </label>
      ))}
      <p id={noteId} className="backend-field-hint">{PROMPT_CACHE_NOTE}</p>
    </fieldset>
  );
}
