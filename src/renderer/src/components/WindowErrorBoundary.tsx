import { Component, type ReactNode } from "react";

/** Keep a renderer failure visible and let the user explicitly retry loading. */
export class WindowErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="renderer-startup-error" role="alert">
        <h1>This window could not finish loading.</h1>
        <p>Reload the window to try again.</p>
        <button type="button" onClick={() => window.location.reload()}>Reload window</button>
      </main>
    );
  }
}
