import { LoadingMark } from "../ui";

export function SettingsSectionFallback(): React.JSX.Element {
  return (
    <div className="settings-section-loading" aria-busy="true">
      <LoadingMark label="Loading settings section" />
    </div>
  );
}
