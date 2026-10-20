import { Component, type ReactNode } from "react";

interface WatcherErrorBoundaryProps {
  children: ReactNode;
  fallback: ReactNode;
  resetKey?: unknown;
}

export class WatcherErrorBoundary extends Component<
  WatcherErrorBoundaryProps,
  { failed: boolean; resetKey: unknown }
> {
  state = { failed: false, resetKey: this.props.resetKey };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  static getDerivedStateFromProps(
    props: WatcherErrorBoundaryProps,
    state: { failed: boolean; resetKey: unknown },
  ): { failed: boolean; resetKey: unknown } | null {
    return props.resetKey === state.resetKey ? null : { failed: false, resetKey: props.resetKey };
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
