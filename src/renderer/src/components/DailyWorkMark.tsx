import "./DailyWorkMark.css";

interface DailyWorkMarkProps {
  size: number;
}

/**
 * A decorative day-ledger mark shared by every Daily work entry point.
 *
 * The geometry follows the Lucide grid the neighbouring destinations use, so
 * the footer trio reads as one set: a day card carrying a single marked day.
 * Usage already owns columns and Settings owns the gear, so this mark stays
 * rectangular and keeps exactly one element inside the frame to survive the
 * 16px sidebar size.
 *
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
      <path d="M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z" />
      <path d="M8 2v4M16 2v4M3 10h18" />
      <path className="daily-work-mark-today" d="M12 16h.01" />
    </svg>
  );
}
