/* eslint-disable prettier/prettier */
import { notificationEmailShell } from '../notifications/templates/notification-email.template';

/** Everything the weekly digest shows. A section is null when its data couldn't be loaded (the email says so). */
export interface DigestData {
  periodEnd: Date;
  revenue: {
    mrr: number; payingStores: number; arpu: number;
    /** MRR 7 days ago from the daily snapshot; null until a week of snapshots exists. */
    mrrWeekAgo: number | null;
    newMrr: number | null; churnedMrr: number | null; newPayingStores: number | null; churnedStores: number | null;
  } | null;
  growth: { newSellers: number; newStores: number } | null;
  health: { atRisk: number; attention: number; mrrAtRisk: number; top: { storeName: string; score: number; reason: string; mrr: number }[] } | null;
  activation: { stuckCount: number; top: { name: string; nextStep: string; daysStuck: number }[] } | null;
  alerts: { severity: string; category: string; message: string }[] | null;
}

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: n % 1 ? 2 : 0 });
const signed = (n: number) => `${n >= 0 ? '+' : '−'}${usd(Math.abs(n))}`;
const NEXT_ACTION: Record<string, string> = {
  verified: 'verify their email', store: 'create a store', product: 'add a first product', sale: 'get a first sale', paying: 'choose a plan',
};

const h2 = (t: string) => `<h3 style="margin:22px 0 8px;font-size:15px;color:#141413;">${esc(t)}</h3>`;
const unavailable = '<p style="color:#8c8a82;margin:0;">Couldn\'t be loaded this week.</p>';
const stat = (label: string, value: string, sub = '') =>
  `<td style="padding:10px 12px;border:1px solid #e8e6dc;border-radius:8px;vertical-align:top;">
    <div style="font-size:11px;color:#8c8a82;text-transform:uppercase;letter-spacing:.04em;">${esc(label)}</div>
    <div style="font-size:20px;font-weight:700;color:#141413;">${esc(value)}</div>
    ${sub ? `<div style="font-size:12px;color:#8c8a82;">${esc(sub)}</div>` : ''}</td>`;
const list = (items: string[]) => `<ul style="margin:0;padding-left:18px;">${items.map((i) => `<li style="margin:4px 0;">${i}</li>`).join('')}</ul>`;

/** Subject line: the week's headline numbers, so the inbox preview alone is useful. */
export function digestSubject(d: DigestData): string {
  const parts = ['Solvexo weekly'];
  if (d.revenue) {
    parts.push(`MRR ${usd(d.revenue.mrr)}${d.revenue.mrrWeekAgo !== null ? ` (${signed(d.revenue.mrr - d.revenue.mrrWeekAgo)})` : ''}`);
  }
  if (d.health && d.health.atRisk > 0) parts.push(`${d.health.atRisk} at risk`);
  const urgent = (d.alerts ?? []).filter((a) => a.severity === 'critical').length;
  if (urgent > 0) parts.push(`${urgent} critical alert${urgent === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

export function digestHtml(d: DigestData, appUrl: string): string {
  const link = (path: string, label: string) => `<a href="${esc(appUrl + path)}" style="color:#b95a3a;">${esc(label)}</a>`;
  let body = `<p style="margin:0 0 6px;color:#8c8a82;">Week ending ${esc(d.periodEnd.toUTCString().slice(0, 16))}</p>`;

  body += h2('Subscription revenue');
  if (!d.revenue) body += unavailable;
  else {
    const r = d.revenue;
    const wow = r.mrrWeekAgo !== null ? `${signed(r.mrr - r.mrrWeekAgo)} vs last week` : 'Week-over-week starts once a week of daily records exists';
    body += `<table role="presentation" cellspacing="6" style="width:100%;border-collapse:separate;"><tr>
      ${stat('MRR', usd(r.mrr), wow)}${stat('Paying stores', String(r.payingStores), `ARPU ${usd(r.arpu)}`)}</tr></table>`;
    if (r.newMrr !== null) {
      body += `<p style="margin:6px 0 0;">This week: ${r.newPayingStores} new paying store${r.newPayingStores === 1 ? '' : 's'} (${signed(r.newMrr)}), `
        + `${r.churnedStores} lost (${r.churnedMrr ? `−${usd(r.churnedMrr)}` : usd(0)}). ${link('/admin/saas-metrics', 'SaaS Metrics')}</p>`;
    }
  }

  body += h2('Growth');
  body += d.growth
    ? `<p style="margin:0;">${d.growth.newSellers} new merchant sign-up${d.growth.newSellers === 1 ? '' : 's'} and ${d.growth.newStores} new store${d.growth.newStores === 1 ? '' : 's'} this week.</p>`
    : unavailable;

  body += h2('Merchants at risk');
  if (!d.health) body += unavailable;
  else if (d.health.atRisk === 0) body += `<p style="margin:0;">No store is at risk. ${d.health.attention} need attention. ${link('/admin/clients', 'Clients')}</p>`;
  else {
    body += `<p style="margin:0 0 6px;"><strong>${d.health.atRisk}</strong> at risk (${usd(d.health.mrrAtRisk)} MRR at stake), ${d.health.attention} need attention.</p>`;
    body += list(d.health.top.map((s) => `<strong>${esc(s.storeName)}</strong> · score ${s.score}${s.mrr > 0 ? ` · ${usd(s.mrr)}/mo` : ''}<br><span style="color:#8c8a82;">${esc(s.reason)}</span>`));
    body += `<p style="margin:6px 0 0;">${link('/admin/clients', 'See every store in Clients → Health')}</p>`;
  }

  body += h2('New merchants who need a nudge');
  if (!d.activation) body += unavailable;
  else if (d.activation.stuckCount === 0) body += '<p style="margin:0;">Nobody who signed up recently is stuck.</p>';
  else {
    body += `<p style="margin:0 0 6px;">${d.activation.stuckCount} recent sign-up${d.activation.stuckCount === 1 ? ' is' : 's are'} stuck on a step for 3+ days.</p>`;
    body += list(d.activation.top.map((m) => `<strong>${esc(m.name)}</strong>: needs to ${esc(NEXT_ACTION[m.nextStep] ?? m.nextStep)} (stuck ${m.daysStuck} days)`));
    body += `<p style="margin:6px 0 0;">${link('/admin/saas-metrics', 'Full list in SaaS Metrics → Activation')}</p>`;
  }

  body += h2('Open alerts');
  if (!d.alerts) body += unavailable;
  else if (d.alerts.length === 0) body += '<p style="margin:0;">No critical or warning alerts right now.</p>';
  else body += list(d.alerts.map((a) => `<strong style="color:${a.severity === 'critical' ? '#c13030' : '#c08b1e'};">${esc(a.severity.toUpperCase())}</strong> · ${esc(a.category)}: ${esc(a.message)}`));

  body += `<p style="margin:22px 0 0;color:#8c8a82;font-size:12px;">You get this every Monday. Turn it off in the admin panel under Settings → Notifications.</p>`;
  return notificationEmailShell('Your weekly Solvexo summary', body, { label: 'Open admin panel', url: `${appUrl}/admin` });
}
