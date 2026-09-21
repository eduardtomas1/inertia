export const RUNTIME_DETAIL_SUBSCRIPTION_OWNERS = [
  "primary",
  "secondary",
  "tertiary",
  "quaternary",
] as const;

export const MAX_RUNTIME_DETAIL_SUBSCRIPTIONS:
  (typeof RUNTIME_DETAIL_SUBSCRIPTION_OWNERS)["length"] = 4;

export type RuntimeDetailSubscriptionOwner =
  (typeof RUNTIME_DETAIL_SUBSCRIPTION_OWNERS)[number];

export interface RuntimePaneSubscription {
  owner: RuntimeDetailSubscriptionOwner;
  conversationId: string;
}
