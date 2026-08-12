import { CircleHelp } from "lucide-react";
import type { CSSProperties } from "react";

import { providerIconDefinition } from "../utils/providerIcons";

type ProviderBrandIconProps = {
  providerId: string | null | undefined;
  label?: string;
  decorative?: boolean;
  size?: number;
  className?: string;
};

export function ProviderBrandIcon({
  providerId,
  label,
  decorative = false,
  size = 16,
  className,
}: ProviderBrandIconProps): React.JSX.Element {
  const definition = providerIconDefinition(providerId);
  const accessibleLabel = label
    ?? `${definition?.label ?? "Custom provider"} icon`;
  const style = { "--provider-icon-size": `${size}px` } as CSSProperties;
  const classes = [
    "provider-brand-icon",
    definition ? "is-official" : "is-fallback",
    definition?.darkSrc ? "has-dark-source" : null,
    definition?.invertInDark ? "is-dark-invert" : null,
    className,
  ].filter(Boolean).join(" ");

  return (
    <span
      className={classes}
      style={style}
      data-provider-id={definition?.providerId ?? providerId ?? "unknown"}
      data-provider-brand={definition?.brand ?? "custom"}
      data-provider-icon-kind={definition ? "official" : "fallback"}
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : accessibleLabel}
      aria-hidden={decorative ? "true" : undefined}
    >
      {definition ? (
        <>
          <img
            className="provider-brand-icon-source is-light"
            src={definition.lightSrc}
            alt=""
            aria-hidden="true"
            draggable="false"
          />
          {definition.darkSrc && (
            <img
              className="provider-brand-icon-source is-dark"
              src={definition.darkSrc}
              alt=""
              aria-hidden="true"
              draggable="false"
            />
          )}
        </>
      ) : (
        <CircleHelp
          data-provider-icon-fallback
          size={size}
          strokeWidth={1.8}
          aria-hidden="true"
        />
      )}
    </span>
  );
}
