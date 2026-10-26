import { lazy, Suspense, useId } from "react";
import { ExternalLink } from "lucide-react";
import type { AppUpdateStatus } from "@shared/desktop";

const UpdateReleaseNotes = lazy(async () => ({
  default: (await import("./UpdateReleaseNotes")).UpdateReleaseNotes,
}));

function Notes({ text }: { text: string }): React.JSX.Element {
  return <Suspense fallback={<p className="update-release-plain">{text}</p>}><UpdateReleaseNotes text={text} /></Suspense>;
}

function ReleaseLink({ label, description, disabled, onOpen }: {
  label: string; description: string; disabled: boolean; onOpen: () => void;
}): React.JSX.Element {
  return <button type="button" className="update-release-link" aria-label={description} disabled={disabled} onClick={onOpen}>
    {label}<ExternalLink size={14} aria-hidden="true" />
  </button>;
}

export function UpdateReleaseSection({ status, notes, opening, onOpenRelease, onOpenReleases }: {
  status: AppUpdateStatus;
  notes: string;
  opening: boolean;
  onOpenRelease: (version: string) => void;
  onOpenReleases: () => void;
}): React.JSX.Element {
  const id = useId();
  const history = status.releaseHistory ?? [];
  const omitted = status.releaseHistoryOmitted ?? 0;
  const heading = `What’s changed${status.latestVersion ? ` in ${status.latestVersion}` : ""}`;
  if (history.length === 0) {
    return <section className="update-release-notes" aria-label="Release notes">
      <h3>{heading}</h3>
      <div className="update-release-body" tabIndex={0} role="region" aria-label="Release changes">
        <Notes text={notes} />
      </div>
    </section>;
  }
  return <section className="update-release-notes" aria-label="Release notes">
    <div className="update-release-body is-stacked" tabIndex={0} role="region" aria-label="Release changes">
      <section className="update-release-group" aria-labelledby={`${id}-latest`}>
        <h3 id={`${id}-latest`}>{heading}</h3>
        <div className="update-release-markdown"><Notes text={notes} /></div>
      </section>
      {history.map((release, index) => {
        const label = release.omittedItems === 0 ? "View release"
          : `${release.omittedItems} more ${release.omittedItems === 1 ? "change" : "changes"}`;
        return <section key={release.version} className="update-release-group" aria-labelledby={`${id}-${index}`}>
          <h3 id={`${id}-${index}`}>Also in {release.version}</h3>
          <div className="update-release-markdown"><Notes text={release.notes} /></div>
          <ReleaseLink label={label} description={`${label} for ${release.version}`} disabled={opening}
            onOpen={() => onOpenRelease(release.version)} />
        </section>;
      })}
      {omitted > 0 && status.releasesUrl && <div className="update-release-more">
        <ReleaseLink label={`${omitted} older ${omitted === 1 ? "release" : "releases"}`}
          description={`${omitted} older ${omitted === 1 ? "release" : "releases"} on the release page`}
          disabled={opening} onOpen={onOpenReleases} />
      </div>}
    </div>
  </section>;
}
