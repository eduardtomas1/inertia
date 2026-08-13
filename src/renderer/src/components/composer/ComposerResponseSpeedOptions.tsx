import type { ProviderFastMode } from "@shared/contracts";

export function ComposerResponseSpeedOptions({
  fastMode,
  selectedFastMode,
  pending,
  onUpdate,
  onSelected,
}: {
  fastMode: ProviderFastMode | null;
  selectedFastMode: boolean;
  pending: boolean;
  onUpdate: (enabled: boolean) => Promise<void>;
  onSelected: () => void;
}): React.JSX.Element {
  const update = (enabled: boolean): void => {
    if (enabled && !fastMode) return;
    void onUpdate(enabled).then(onSelected, () => undefined);
  };
  return (
    <>
      {[{
        enabled: false,
        label: "Standard",
        description: "Standard speed",
        disabled: pending,
      }, {
        enabled: true,
        label: "Fast",
        description: fastMode?.description
          ?? "No longer supported",
        disabled: pending || fastMode === null,
      }].map((option) => (
        <button
          type="button"
          role="menuitemradio"
          aria-checked={selectedFastMode === option.enabled}
          key={String(option.enabled)}
          disabled={option.disabled}
          onClick={() => update(option.enabled)}
        >
          <span>
            <strong>{option.label}</strong>
            <small>{option.description}</small>
          </span>
          {selectedFastMode === option.enabled && (
            <span className="option-check" />
          )}
        </button>
      ))}
    </>
  );
}
