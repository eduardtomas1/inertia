import { useEffect, useRef, useState } from "react";
import { COPY_FAILURE_MESSAGE, writeClipboardText } from "../utils/clipboard";

export interface ClipboardControlState {
  copied: boolean;
  pending: boolean;
  error: string | null;
  copy: (text: string) => Promise<void>;
}

export function useCopiedState(): ClipboardControlState {
  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  const operation = useRef(0);
  useEffect(() => () => {
    operation.current += 1;
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);
  const copy = async (text: string): Promise<void> => {
    const sequence = operation.current + 1;
    operation.current = sequence;
    setPending(true);
    setCopied(false);
    setError(null);
    const succeeded = await writeClipboardText(text);
    if (operation.current !== sequence) return;
    setPending(false);
    if (!succeeded) {
      setError(COPY_FAILURE_MESSAGE);
      return;
    }
    setCopied(true);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1_500);
  };
  return { copied, pending, error, copy };
}
