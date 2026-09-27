import { useRef } from "react";

export function useRovingRadios<T extends string>(
  options: readonly T[],
  value: T,
  onPick: (value: T) => void,
): {
  groupProps: { onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void };
  radioProps: (option: T) => {
    role: "radio";
    "aria-checked": boolean;
    tabIndex: number;
    ref: (node: HTMLButtonElement | null) => void;
    onClick: () => void;
  };
} {
  const nodes = useRef(new Map<T, HTMLButtonElement>());
  const focusable = options.includes(value) ? value : options[0];
  return {
    groupProps: {
      onKeyDown: (event) => {
        const current = options.findIndex((option) => nodes.current.get(option) === event.target);
        if (current < 0) return;
        const next = event.key === "ArrowRight" || event.key === "ArrowDown"
          ? (current + 1) % options.length
          : event.key === "ArrowLeft" || event.key === "ArrowUp"
            ? (current - 1 + options.length) % options.length
            : event.key === "Home"
              ? 0
              : event.key === "End"
                ? options.length - 1
                : -1;
        if (next < 0) return;
        event.preventDefault();
        const option = options[next]!;
        nodes.current.get(option)?.focus();
        onPick(option);
      },
    },
    radioProps: (option) => ({
      role: "radio",
      "aria-checked": option === value,
      tabIndex: option === focusable ? 0 : -1,
      ref: (node) => {
        if (node) nodes.current.set(option, node);
        else nodes.current.delete(option);
      },
      onClick: () => onPick(option),
    }),
  };
}
