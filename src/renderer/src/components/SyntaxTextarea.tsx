import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { sourceLanguageForFile } from "@shared/source-language";
import { highlightedSourceHtml } from "../utils/sourceHighlighting";
import "./SyntaxTextarea.css";

/** Colors are a non-interactive mirror. The native textarea owns all edits,
 * selection, clipboard, IME and undo; highlighted HTML is never read back. */
export function SyntaxTextarea({ path, value, disabled, editorRef, onChange }: {
  path: string; value: string; disabled: boolean;
  editorRef: RefObject<HTMLTextAreaElement | null>;
  onChange: (value: string) => void;
}): React.JSX.Element {
  const mirror = useRef<HTMLPreElement>(null);
  const [composition, setComposition] = useState(false);
  const [highlight, setHighlight] = useState<{ value: string; path: string; html: string | null } | null>(null);
  useEffect(() => {
    if (composition) return;
    // Reuse the preview's character/line bounds. While typing or composing,
    // show native text instead of stale colors at the wrong character positions.
    const timer = setTimeout(() => setHighlight({ value, path,
      html: highlightedSourceHtml(value, sourceLanguageForFile(path, value)),
    }), 120);
    return () => clearTimeout(timer);
  }, [path, value, composition]);
  const colored = !composition && highlight?.value === value && highlight.path === path && highlight.html !== null;
  const synchronizeScroll = (): void => {
    if (!mirror.current || !editorRef.current) return;
    mirror.current.scrollTop = editorRef.current.scrollTop;
    mirror.current.scrollLeft = editorRef.current.scrollLeft;
  };
  useLayoutEffect(synchronizeScroll, [colored, highlight, editorRef]);
  return <div className={`syntax-textarea${colored ? " is-highlighted" : ""}`}>
    <pre ref={mirror} aria-hidden="true" className="syntax-textarea-mirror">
      {colored && <code dangerouslySetInnerHTML={{ __html: `${highlight.html}\n` }} />}
    </pre>
    <textarea ref={editorRef} value={value} disabled={disabled} wrap="off" spellCheck={false}
      aria-label={`Edit contents of ${path}`} onScroll={synchronizeScroll}
      onCompositionStart={() => setComposition(true)} onCompositionEnd={() => setComposition(false)}
      onChange={(event) => onChange(event.currentTarget.value)} />
    {highlight?.value === value && highlight.html === null && <span className="syntax-textarea-mode">Plain text · highlighting unavailable or file exceeds preview limits</span>}
  </div>;
}
