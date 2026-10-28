export class ThreadNotificationActivationBuffer<Activation = string> {
  private readonly listeners = new Set<(activation: Activation) => void>();
  private pendingActivation: Activation | null = null;

  receive(activation: Activation): void {
    if (this.listeners.size === 0) {
      // Navigation is singular: while the renderer boots, the latest click is
      // the exact destination the user most recently requested.
      this.pendingActivation = activation;
      return;
    }
    for (const listener of this.listeners) listener(activation);
  }

  subscribe(listener: (activation: Activation) => void): () => void {
    this.listeners.add(listener);
    const pending = this.pendingActivation;
    this.pendingActivation = null;
    if (pending) listener(pending);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
