import "./ContextCompactionIcon.css";

export function ContextCompactionIcon(): React.JSX.Element {
  return (
    <svg className="context-compaction-icon" width="18" height="18" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 5.5V18a3 3 0 0 0 3 3h8M10 3h7a3 3 0 0 1 3 3v12.5" />
      <circle cx="4" cy="3.5" r="1.75" fill="currentColor" stroke="none" />
      <circle cx="20" cy="20.5" r="1.75" fill="currentColor" stroke="none" />
      <g><path d="M8.5 8h7M8.5 12h4M8.5 16h6" /></g>
    </svg>
  );
}
