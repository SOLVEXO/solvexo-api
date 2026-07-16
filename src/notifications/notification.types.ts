/* eslint-disable prettier/prettier */

/** Notification `type` catalog — keep the app-side switch/icon-mapping in sync with these. */
export const NOTIFICATION_TYPES = {
  ORDER_PLACED: 'order_placed',
  ORDER_SHIPPED: 'order_shipped',
  ORDER_DELIVERED: 'order_delivered',
  ORDER_CANCELLED: 'order_cancelled',
  PAYMENT_SUCCESS: 'payment_success',
  PAYMENT_FAILED: 'payment_failed',
  NEW_MESSAGE: 'new_message',
  LOYALTY_POINTS_EARNED: 'loyalty_points_earned',
  LOYALTY_TIER_UPGRADE: 'loyalty_tier_upgrade',
  NEW_FOLLOWER: 'new_follower',
  LOW_STOCK: 'low_stock',
  SUBSCRIPTION_RENEWAL_REMINDER: 'subscription_renewal_reminder',
  SUBSCRIPTION_PAYMENT_FAILED: 'subscription_payment_failed',
  SUBSCRIPTION_CANCELLED: 'subscription_cancelled',
  PLATFORM_PLAN_RENEWAL_REMINDER: 'platform_plan_renewal_reminder',
  PLATFORM_PLAN_PAYMENT_FAILED: 'platform_plan_payment_failed',
} as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[keyof typeof NOTIFICATION_TYPES];

/** Maps a notification type to the NotificationPreference bucket that gates it. */
export const NOTIFICATION_CATEGORY: Record<string, 'orders' | 'messages' | 'promotions' | 'loyalty' | 'subscriptions'> = {
  [NOTIFICATION_TYPES.ORDER_PLACED]: 'orders',
  [NOTIFICATION_TYPES.ORDER_SHIPPED]: 'orders',
  [NOTIFICATION_TYPES.ORDER_DELIVERED]: 'orders',
  [NOTIFICATION_TYPES.ORDER_CANCELLED]: 'orders',
  [NOTIFICATION_TYPES.PAYMENT_SUCCESS]: 'orders',
  [NOTIFICATION_TYPES.PAYMENT_FAILED]: 'orders',
  [NOTIFICATION_TYPES.NEW_MESSAGE]: 'messages',
  [NOTIFICATION_TYPES.LOYALTY_POINTS_EARNED]: 'loyalty',
  [NOTIFICATION_TYPES.LOYALTY_TIER_UPGRADE]: 'loyalty',
  [NOTIFICATION_TYPES.NEW_FOLLOWER]: 'promotions',
  [NOTIFICATION_TYPES.LOW_STOCK]: 'orders',
  [NOTIFICATION_TYPES.SUBSCRIPTION_RENEWAL_REMINDER]: 'subscriptions',
  [NOTIFICATION_TYPES.SUBSCRIPTION_PAYMENT_FAILED]: 'subscriptions',
  [NOTIFICATION_TYPES.SUBSCRIPTION_CANCELLED]: 'subscriptions',
  [NOTIFICATION_TYPES.PLATFORM_PLAN_RENEWAL_REMINDER]: 'subscriptions',
  [NOTIFICATION_TYPES.PLATFORM_PLAN_PAYMENT_FAILED]: 'subscriptions',
};
