/* eslint-disable prettier/prettier */
import { type DigestData, digestHtml, digestSubject } from './digest-email.util';

const full: DigestData = {
  periodEnd: new Date('2026-11-02T03:05:00Z'),
  revenue: { mrr: 1200, payingStores: 20, arpu: 60, mrrWeekAgo: 1100, newMrr: 150, churnedMrr: 50, newPayingStores: 3, churnedStores: 1 },
  growth: { newSellers: 12, newStores: 9 },
  health: { atRisk: 2, attention: 4, mrrAtRisk: 78, top: [{ storeName: 'Quiet <Books>', score: 22, reason: 'Payment failed (3 attempts)', mrr: 29 }] },
  activation: { stuckCount: 5, top: [{ name: 'Hamza Mart', nextStep: 'product', daysStuck: 12 }] },
  alerts: [{ severity: 'critical', category: 'Infrastructure', message: 'Redis is down' }],
};

describe('weekly digest email', () => {
  it('puts the headline numbers in the subject', () => {
    expect(digestSubject(full)).toBe('Solvexo weekly · MRR $1,200 (+$100) · 2 at risk · 1 critical alert');
    expect(digestSubject({ ...full, revenue: { ...full.revenue!, mrrWeekAgo: null }, health: { ...full.health!, atRisk: 0 }, alerts: [] })).toBe('Solvexo weekly · MRR $1,200');
  });

  it('shows every section, escapes merchant-entered text, and links into the panel', () => {
    const html = digestHtml(full, 'https://solvexo.store');
    expect(html).toContain('+$100 vs last week');
    expect(html).toContain('3 new paying stores (+$150), 1 lost (−$50)');
    expect(html).toContain('12 new merchant sign-ups and 9 new stores');
    expect(html).toContain('Quiet &lt;Books&gt;');
    expect(html).not.toContain('Quiet <Books>');
    expect(html).toContain('needs to add a first product (stuck 12 days)');
    expect(html).toContain('Redis is down');
    expect(html).toContain('https://solvexo.store/admin/clients');
  });

  it('says when a section could not be loaded instead of dropping it', () => {
    const html = digestHtml({ ...full, revenue: null, health: null, activation: null, alerts: null, growth: null }, 'https://x.test');
    expect(html.match(/Couldn't be loaded this week/g)).toHaveLength(5);
  });
});
