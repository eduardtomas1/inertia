import { Component, type ReactNode } from "react";

export class WatcherErrorBoundary extends Component<
  { children: ReactNode; fallback: ReactNode; resetKey?: unknown },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidUpdate(previous: Readonly<{ resetKey?: unknown }>): void {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) this.setState({ failed: false });
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
