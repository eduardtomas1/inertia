function ConnectCard({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <main className="connect-card">
      <div className="brand-mark">I</div>
      <h1>{title}</h1>
      {children}
    </main>
  );
}

export function CheckingScreen(): React.JSX.Element {
  return (
    <ConnectCard title="Inertia Private Connect">
      <p>Checking this browser’s connection…</p>
    </ConnectCard>
  );
}

export function PairScreen({ error }: { error: string | null }): React.JSX.Element {
  return (
    <ConnectCard title="Inertia Private Connect">
      <p>Pair this browser with your online Inertia computer through your private Tailscale network.</p>
      {error && <p className="error">{error}</p>}
      <p className="muted">Open a fresh pairing link from Connections &amp; devices on the desktop.</p>
    </ConnectCard>
  );
}

export function WaitingScreen({ comparisonCode }: { comparisonCode: string }): React.JSX.Element {
  return (
    <ConnectCard title="Waiting for approval">
      <p>Approve this browser on the Inertia desktop.</p>
      <div className="comparison-code" aria-label={`Comparison code ${comparisonCode}`}>{comparisonCode}</div>
      <p className="muted">The code must match what your computer displays.</p>
    </ConnectCard>
  );
}

export function OfflineScreen({ onRetry }: { onRetry: () => void }): React.JSX.Element {
  return (
    <ConnectCard title="Your Inertia computer is offline">
      <p>Reconnect this browser to the private Tailscale host, then try again.</p>
      <button type="button" onClick={onRetry}>Try again</button>
      <p className="muted offline-privacy">
        The installed app shell works offline. Conversations and API responses are never stored in its offline cache.
      </p>
    </ConnectCard>
  );
}
