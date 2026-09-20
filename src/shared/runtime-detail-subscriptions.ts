export const RUNTIME_DETAIL_SUBSCRIPTION_OWNERS = [
  "primary",
  "secondary",
  "tertiary",
  "quaternary",
] as const;

export type RuntimeDetailSubscriptionOwner =
  (typeof RUNTIME_DETAIL_SUBSCRIPTION_OWNERS)[number];

export interface RuntimePaneSubscription {
  owner: RuntimeDetailSubscriptionOwner;
  conversationId: string;
}
