import "./DailyWorkMark.css";

interface DailyWorkMarkProps {
  size: number;
}

/**
 * A decorative day-ledger mark shared by every Daily work entry point.
 * Adjacent visible text owns the accessible name, so the SVG never creates a
 * duplicate announcement or keyboard stop.
 */
export function DailyWorkMark({ size }: DailyWorkMarkProps): React.JSX.Element {
  return (
    <svg
      className="daily-work-mark"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      focusable="false"
      aria-hidden="true"
    >
      <path
        d="M7 4h10a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3ZM4 8h16M8 3v3M16 3v3"
      />
      <path
        className="daily-work-mark-time"
        d="M12 11a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm0 1.5v2l1.5.8"
      />
    </svg>
  );
}
