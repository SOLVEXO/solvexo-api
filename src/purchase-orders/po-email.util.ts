/* eslint-disable prettier/prettier */
import { notificationEmailShell } from '../notifications/templates/notification-email.template';
import type { PoPdfBrand, PoPdfData } from './po-pdf.util';

function esc(v: string | number | null | undefined): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function money(n: number, currency: string): string {
  return `${currency} ${(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(d: Date | null): string {
  if (!d) return '—';
  return new Date(d).toISOString().slice(0, 10);
}

/** The supplier-facing mail body for a purchase order. The line items are
 *  repeated here (not only in the attachment) because most suppliers open the
 *  mail on a phone, where a PDF is a download before it is a read. */
export function buildPurchaseOrderEmailHtml(data: PoPdfData, brand: PoPdfBrand): string {
  const rows = data.lines.map((line, i) => {
    const detail = [line.options.join(' / '), line.sku].filter(Boolean).join(' · ');
    return `<tr>
      <td style="padding:9px 8px;border-bottom:1px solid #eee;color:#767676;font-size:13px;">${i + 1}</td>
      <td style="padding:9px 8px;border-bottom:1px solid #eee;font-size:14px;">
        ${esc(line.name)}${detail ? `<div style="color:#9a9a9a;font-size:12px;margin-top:2px;">${esc(detail)}</div>` : ''}
      </td>
      <td style="padding:9px 8px;border-bottom:1px solid #eee;text-align:right;font-size:14px;white-space:nowrap;">${line.quantityOrdered}</td>
      <td style="padding:9px 8px;border-bottom:1px solid #eee;text-align:right;font-size:14px;white-space:nowrap;">${esc(money(line.unitCost, data.currency))}</td>
      <td style="padding:9px 8px;border-bottom:1px solid #eee;text-align:right;font-size:14px;font-weight:600;white-space:nowrap;">${esc(money(line.unitCost * line.quantityOrdered, data.currency))}</td>
    </tr>`;
  }).join('');

  const totalsRow = (label: string, value: string, strong = false) => `<tr>
    <td colspan="4" style="padding:5px 8px;text-align:right;color:${strong ? '#222' : '#767676'};font-size:${strong ? 15 : 14}px;">${label}</td>
    <td style="padding:5px 8px;text-align:right;color:#222;font-size:${strong ? 15 : 14}px;font-weight:${strong ? 700 : 400};white-space:nowrap;">${esc(value)}</td>
  </tr>`;

  const contact = brand.email ? `<a href="mailto:${esc(brand.email)}" style="color:${esc(brand.accentColor)};">${esc(brand.email)}</a>` : '';

  return notificationEmailShell(
    `Purchase order ${data.poNumber}`,
    `<p>Hi ${esc(data.supplierName)},</p>
     <p>${esc(brand.businessName)} is ordering the items below. The full purchase order is attached as a PDF.</p>
     <div class="box" style="padding:12px 14px;">
       <table role="presentation" width="100%" style="border-collapse:collapse;"><tr><td style="padding:6px 0;font-size:14px;color:#767676;text-align:left;">PO number</td><td style="padding:6px 0 6px 16px;font-size:14px;font-weight:600;color:#222;text-align:right;">${esc(data.poNumber)}</td></tr></table>
       <table role="presentation" width="100%" style="border-collapse:collapse;"><tr><td style="padding:6px 0;font-size:14px;color:#767676;text-align:left;">Date issued</td><td style="padding:6px 0 6px 16px;font-size:14px;font-weight:600;color:#222;text-align:right;">${esc(formatDate(data.issuedAt))}</td></tr></table>
       <table role="presentation" width="100%" style="border-collapse:collapse;"><tr><td style="padding:6px 0;font-size:14px;color:#767676;text-align:left;">Expected delivery</td><td style="padding:6px 0 6px 16px;font-size:14px;font-weight:600;color:#222;text-align:right;">${esc(formatDate(data.expectedAt))}</td></tr></table>
     </div>
     <table style="width:100%;border-collapse:collapse;margin:18px 0 6px;">
       <thead><tr>
         <th style="text-align:left;padding:8px;border-bottom:2px solid #ddd;color:#767676;font-size:11px;text-transform:uppercase;">#</th>
         <th style="text-align:left;padding:8px;border-bottom:2px solid #ddd;color:#767676;font-size:11px;text-transform:uppercase;">Item</th>
         <th style="text-align:right;padding:8px;border-bottom:2px solid #ddd;color:#767676;font-size:11px;text-transform:uppercase;">Qty</th>
         <th style="text-align:right;padding:8px;border-bottom:2px solid #ddd;color:#767676;font-size:11px;text-transform:uppercase;">Unit cost</th>
         <th style="text-align:right;padding:8px;border-bottom:2px solid #ddd;color:#767676;font-size:11px;text-transform:uppercase;">Amount</th>
       </tr></thead>
       <tbody>${rows}</tbody>
       <tfoot>
         ${totalsRow('Subtotal', money(data.subtotal, data.currency))}
         ${data.shippingCost ? totalsRow('Shipping', money(data.shippingCost, data.currency)) : ''}
         ${data.taxCost ? totalsRow('Tax', money(data.taxCost, data.currency)) : ''}
         ${totalsRow('Total', money(data.total, data.currency), true)}
       </tfoot>
     </table>
     ${data.notes?.trim() ? `<div class="box"><strong style="font-size:12px;color:#767676;text-transform:uppercase;">Notes</strong><p style="margin:6px 0 0;font-size:14px;">${esc(data.notes)}</p></div>` : ''}
     <p style="font-size:14px;">Please confirm this order${contact ? ` or reply to ${contact}` : ''}.</p>`,
    undefined,
    { name: brand.businessName, logoUrl: brand.logoUrl, accent: brand.accentColor },
  );
}
