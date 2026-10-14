/** Every permission a TEAM admin (an admin who is not the platform owner) can be granted. The owner / any
 *  Super Admin is never permission-checked. Keep in sync with solvexo-web `api/services/adminTeam.ts`. */
export const ADMIN_PERMISSIONS = [
  'analytics.view', // platform overview + analytics
  'clients.view', // stores, sellers, buyers (read)
  'clients.manage', // suspend / activate / delete, moderation, refund requests
  'finance.view', // finance dashboards, ledger, reports
  'finance.payouts', // approve / reverse / create manual payouts (money out)
  'billing.manage', // platform plans, subscriptions, POS plans
  'commission.manage', // commission rules + FX settings
  'seo.manage',
  'ai.manage', // admin AI Studio
  'content.manage', // announcements, FAQs, testimonials, contact messages, newsletter, onboarding slides
  'marketing.manage', // platform coupons, promotions, banners
  'marketplace.manage',
  'themes.manage', // theme catalog
  'apps.manage', // store app requests
  'config.manage', // platform config + email health
  'activity.view', // activity log
  'audit.view', // admin audit trail + sessions of other admins
  'team.manage', // roles, admins, approvals
] as const;
export type AdminPermission = (typeof ADMIN_PERMISSIONS)[number];

/** Seeded (non-deletable) starter roles, created lazily the first time roles are listed. */
export const ADMIN_PRESET_ROLES: { key: string; name: string; description: string; readOnly: boolean; permissions: AdminPermission[] }[] = [
  {
    key: 'support', name: 'Support', readOnly: false,
    description: 'Look up stores and sellers, handle moderation and customer issues.',
    permissions: ['analytics.view', 'clients.view', 'clients.manage', 'activity.view', 'content.manage'],
  },
  {
    key: 'finance', name: 'Finance', readOnly: false,
    description: 'See finance, analytics and clients. Cannot move money (payouts stay with the Super Admin).',
    permissions: ['analytics.view', 'finance.view', 'clients.view', 'activity.view'],
  },
  {
    key: 'content_seo', name: 'Content & SEO', readOnly: false,
    description: 'Site content, SEO, newsletter, platform coupons and the theme catalog.',
    permissions: ['analytics.view', 'seo.manage', 'content.manage', 'marketing.manage', 'themes.manage'],
  },
  {
    key: 'auditor', name: 'Auditor (read-only)', readOnly: true,
    description: 'Can look at everything it is allowed to see but can change nothing.',
    permissions: ['analytics.view', 'clients.view', 'finance.view', 'activity.view', 'audit.view'],
  },
];
