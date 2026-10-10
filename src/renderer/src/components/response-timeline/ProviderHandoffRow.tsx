import type { ProviderIdentityLabels } from "@shared/provider-identities";
import type { ProviderHandoffItem } from "../../utils/response-timeline/model";
import { PROVIDER_HANDOFF_TITLE, providerHandoffText } from "../../utils/providerHandoff";
import "./ContextCompactionRow.css";
import "./ProviderHandoffRow.css";

/**
 * Marks where a chat continued on another provider. The divider is derived
 * from the two turns' immutable identities; its carried and left-behind
 * counts come from the receiving turn's recorded session recovery.
 */
export function ProviderHandoffRow({
  id,
  handoff,
  providerIdentityLabels,
}: {
  id: string;
  handoff: ProviderHandoffItem;
  providerIdentityLabels?: ProviderIdentityLabels;
}): React.JSX.Element {
  const text = providerHandoffText(handoff, providerIdentityLabels);
  return (
    <section className="context-compaction-row provider-handoff-row" data-response-row-id={id} tabIndex={-1} aria-label={text.label}>
      <div className="context-compaction-separator provider-handoff-separator" role="separator" aria-label={text.label}>
        <span aria-hidden="true" />
        <small className="context-compaction-marker provider-handoff-marker" aria-hidden="true">
          <span>{PROVIDER_HANDOFF_TITLE}</span>
          <i>·</i>
          <span className="provider-handoff-route">{text.from}</span>
          <i>→</i>
          <span className="provider-handoff-route">{text.to}</span>
          {text.detail && <i>·</i>}
          {text.detail && <span>{text.detail}</span>}
        </small>
        <span aria-hidden="true" />
      </div>
    </section>
  );
}
