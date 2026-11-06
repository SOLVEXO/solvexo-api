/* eslint-disable prettier/prettier */
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { DatabaseService } from '@/database/databaseservice';
import { API_PUBLIC_ORIGIN } from '@/common/api-origin';
import { PosService } from './pos.service';

const esc = (v: unknown): string => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
const METHOD_LABEL: Record<string, string> = { cash: 'Cash', card: 'Card', other: 'Bank / other', raast_qr: 'Raast' };

/**
 * G2.4 digital receipt. A sale gets an unguessable token (192 random bits) the first time its link is asked for; the PUBLIC page
 * `GET /r/:token` renders a read-only receipt from the sale. It shows what a paper receipt shows — the store, items, totals, how it was
 * paid (method + amount only), refund status — and NOTHING about the customer (no name, phone, e-mail, id), no cashier, no payment
 * references, no internal ids. A manager can revoke a link; a revoked, unknown or malformed token gives the SAME plain 404 page.
 */
@Injectable()
export class PosReceiptService {
  constructor(private readonly db: DatabaseService, private readonly pos: PosService) {}
  private get r() { return this.db.repositories; }

  linkOf(token: string) { return { path: `/r/${token}`, url: `${API_PUBLIC_ORIGIN}/r/${token}` }; }

  /** The sale's receipt link — created on first use, the same link afterwards (until a manager revokes it; then a NEW one is made). */
  async getLink(sellerId: string, saleId: string) {
    const sale: any = await this.r.saleModel.findById(saleId).select('storeId status receipt saleNumber').lean();
    if (!sale) throw new NotFoundException('Sale not found');
    await this.pos.verifyStoreOwnership(sale.storeId, sellerId);
    if (sale.status === 'held' || sale.status === 'discarded') throw new NotFoundException('This sale has no receipt');
    if (sale.receipt?.token && !sale.receipt.revokedAt) return { success: true, data: { ...this.linkOf(sale.receipt.token), createdAt: sale.receipt.createdAt } };
    const token = randomBytes(24).toString('base64url'); // 192 bits
    const receipt = { token, createdAt: new Date(), revokedAt: null };
    // only set it if nobody else did / the old one is revoked: two taps cannot make two links
    const res: any = await this.r.saleModel.findOneAndUpdate(
      { _id: saleId, $or: [{ receipt: null }, { 'receipt.revokedAt': { $ne: null } }] }, { $set: { receipt } }, { new: true },
    ).select('receipt').lean();
    const final = res?.receipt ?? (await this.r.saleModel.findById(saleId).select('receipt').lean() as any)?.receipt;
    return { success: true, data: { ...this.linkOf(final.token), createdAt: final.createdAt } };
  }

  /** Manager only (the route demands a manager PIN session): the link stops working at once. */
  async revoke(sellerId: string, saleId: string, managerEmployeeId: string) {
    const sale: any = await this.r.saleModel.findById(saleId).select('storeId receipt').lean();
    if (!sale) throw new NotFoundException('Sale not found');
    await this.pos.verifyStoreOwnership(sale.storeId, sellerId);
    if (!sale.receipt?.token || sale.receipt.revokedAt) return { success: true, data: { revoked: false } };
    await this.r.saleModel.updateOne({ _id: saleId, 'receipt.token': sale.receipt.token }, { $set: { 'receipt.revokedAt': new Date(), 'receipt.revokedBy': managerEmployeeId } });
    await this.r.posAuditLogModel.create([{ storeId: sale.storeId, employeeId: managerEmployeeId, action: 'receipt_link_revoked', targetId: saleId, targetType: 'sale', metadata: null }]);
    return { success: true, data: { revoked: true } };
  }

  /** The public page. Returns null for anything that is not a live token (the caller answers one generic 404). */
  async renderPublic(token: string): Promise<string | null> {
    if (!/^[A-Za-z0-9_-]{30,40}$/.test(token ?? '')) return null;
    const sale: any = await this.r.saleModel.findOne({ 'receipt.token': token, 'receipt.revokedAt': null }).lean();
    if (!sale || sale.status === 'held' || sale.status === 'discarded') return null;
    const [store, settings]: any[] = await Promise.all([
      this.r.storeModel.findById(sale.storeId).select('name logo').lean(),
      this.r.posSettingsModel.findOne({ storeId: sale.storeId }).select('businessName businessAddress businessTaxId receiptHeader receiptFooter').lean(),
    ]);
    const exp: number = sale.currencyExponent ?? 2; const cur = sale.currency ?? '';
    const m = (v: number) => `${esc(cur)} ${Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: exp, maximumFractionDigits: exp })}`;
    const when = new Date(sale.createdAt).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
    const name = settings?.businessName || store?.name || 'Receipt';
    const status = sale.status === 'voided' ? 'Voided' : sale.status === 'refunded' ? 'Fully refunded' : sale.status === 'partially_refunded' ? `Partially refunded — ${m(sale.refundedAmount || 0)} returned` : 'Paid';
    const rows = (sale.items ?? []).map((i: any) => `<tr><td>${esc(i.name)}<div class="sub">${esc(i.qty)} × ${m(i.price)}</div></td><td class="r">${m(i.lineTotal)}</td></tr>`).join('');
    const pays = (sale.payments?.length ? sale.payments : [{ method: sale.paymentMethod, amount: sale.total }]).map((p: any) => `<tr><td>${esc(METHOD_LABEL[p.method] ?? p.method)}</td><td class="r">${m(p.amount)}</td></tr>`).join('');
    const logo = store?.logo && /^https:\/\//.test(store.logo) ? `<img class="logo" src="${esc(store.logo)}" alt="">` : '';
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><title>Receipt ${esc(sale.saleNumber)} — ${esc(name)}</title><style>
body{margin:0;background:#f4f1ee;font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#1b1d21}main{max-width:440px;margin:0 auto;padding:24px 16px}.card{background:#fff;border-radius:16px;padding:20px;box-shadow:0 1px 3px rgba(0,0,0,.08)}h1{font-size:20px;margin:8px 0 2px}.muted{color:#5b616b;font-size:14px}.logo{max-height:48px;max-width:160px;display:block;margin-bottom:8px}table{width:100%;border-collapse:collapse;margin:12px 0}td{padding:6px 0;vertical-align:top}.r{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}.sub{color:#5b616b;font-size:13px}.tot td{border-top:1px solid #e5e1dc;font-weight:700;font-size:18px;padding-top:10px}.badge{display:inline-block;border-radius:999px;padding:4px 12px;font-size:13px;font-weight:600;background:#e7f4ea;color:#1d6b34}.badge.warn{background:#fff1d6;color:#8a5a00}hr{border:0;border-top:1px solid #e5e1dc;margin:12px 0}</style></head><body><main><div class="card">${logo}<h1>${esc(name)}</h1><div class="muted">${esc(settings?.businessAddress || '')}${settings?.businessTaxId ? `<br>Tax ID ${esc(settings.businessTaxId)}` : ''}</div><hr><div class="muted">Receipt ${esc(sale.saleNumber)} · ${esc(when)}</div><p><span class="badge${sale.status === 'completed' ? '' : ' warn'}">${esc(status)}</span></p><table>${rows}</table><table>${sale.discount > 0 ? `<tr><td>Discount${sale.couponCode ? ` (${esc(sale.couponCode)})` : ''}</td><td class="r">− ${m(sale.discount)}</td></tr>` : ''}<tr><td>Subtotal</td><td class="r">${m(sale.subtotal)}</td></tr>${sale.tax > 0 ? `<tr><td>Tax</td><td class="r">${m(sale.tax)}</td></tr>` : ''}<tr class="tot"><td>Total</td><td class="r">${m(sale.total)}</td></tr></table><div class="muted">Paid with</div><table>${pays}${sale.changeGiven > 0 ? `<tr><td class="sub">Change</td><td class="r sub">${m(sale.changeGiven)}</td></tr>` : ''}</table>${settings?.receiptFooter ? `<hr><div class="muted">${esc(settings.receiptFooter)}</div>` : ''}</div><p class="muted" style="text-align:center">Thank you</p></main></body></html>`;
  }

  // ── G2.5: the tax invoice view and credit notes of the same public link ───────────────────────────────────────────────

  private pageShell(title: string, name: string, logo: string, body: string): string {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><title>${esc(title)}</title><style>
body{margin:0;background:#f4f1ee;font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#1b1d21}main{max-width:520px;margin:0 auto;padding:24px 16px}.card{background:#fff;border-radius:16px;padding:20px;box-shadow:0 1px 3px rgba(0,0,0,.08)}h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:18px 0 6px}.sub{color:#6b6f76;font-size:13px}table{width:100%;border-collapse:collapse}td,th{padding:6px 0;vertical-align:top;text-align:left}th{font-size:12px;color:#6b6f76;font-weight:600}.r{text-align:right}.tot td{border-top:1px solid #e4e1dd;font-weight:700}.logo{max-height:48px;max-width:160px;display:block;margin-bottom:8px}.badge{display:inline-block;background:#f3e0d8;color:#8a2f13;border-radius:999px;padding:2px 10px;font-size:12px;font-weight:600}.fiscal{margin-top:16px;min-height:0}a{color:#8a2f13}
</style></head><body><main><div class="card">${logo}<h1>${esc(name)}</h1>${body}</div></main></body></html>`;
  }

  private docMoneyFmt(cur: string, exp: number) {
    return (minor: number) => `${esc(cur)} ${(Number(minor || 0) / 10 ** exp).toLocaleString('en-US', { minimumFractionDigits: exp, maximumFractionDigits: exp })}`;
  }

  private async docContext(sale: any) {
    const [store, settings]: any[] = await Promise.all([
      this.r.storeModel.findById(sale.storeId).select('name logo').lean(),
      this.r.posSettingsModel.findOne({ storeId: sale.storeId }).select('businessName').lean(),
    ]);
    const logo = store?.logo && /^https:\/\//.test(store.logo) ? `<img class="logo" src="${esc(store.logo)}" alt="">` : '';
    return { name: settings?.businessName || store?.name || 'Invoice', logo };
  }

  private sellerBlock(seller: any): string {
    if (!seller) return '';
    const bits = [seller.legalName && `<div>${esc(seller.legalName)}</div>`, seller.address && `<div class="sub">${esc(seller.address)}</div>`, seller.ntn && `<div class="sub">NTN ${esc(seller.ntn)}</div>`, seller.strn && `<div class="sub">STRN ${esc(seller.strn)}</div>`].filter(Boolean);
    return bits.length ? `<div>${bits.join('')}</div>` : '';
  }

  /** `/r/:token/invoice` — the TAX INVOICE: its number, the seller as registered, every line with tax, totals, how it was paid, credit notes issued against it. */
  async renderPublicInvoice(token: string): Promise<string | null> {
    if (!/^[A-Za-z0-9_-]{30,40}$/.test(token ?? '')) return null;
    const sale: any = await this.r.saleModel.findOne({ 'receipt.token': token, 'receipt.revokedAt': null }).lean();
    if (!sale || sale.status === 'held' || sale.status === 'discarded' || !sale.invoice) return null;
    const exp: number = sale.currencyExponent ?? 2; const cur = sale.currency ?? '';
    const m = this.docMoneyFmt(cur, exp);
    const { name, logo } = await this.docContext(sale);
    const cns: any[] = await this.r.posCreditNoteModel.find({ saleId: String(sale._id) }).sort({ seq: 1 }).lean();
    const rows = (sale.items ?? []).map((i: any) => `<tr><td>${esc(i.name)}${i.hsCode ? `<div class="sub">HS ${esc(i.hsCode)}</div>` : ''}<div class="sub">${esc(i.qty)} × ${m(i.priceMinor ?? Math.round(i.price * 10 ** exp))}</div></td><td class="r">${m(i.netMinor ?? i.lineTotalMinor)}</td><td class="r">${m(i.taxMinor ?? 0)}</td></tr>`).join('');
    const pays = (sale.payments?.length ? sale.payments : [{ method: sale.paymentMethod, amountMinor: sale.totalMinor }]).map((p: any) => `<tr><td>${esc(METHOD_LABEL[p.method] ?? p.method)}</td><td class="r">${m(p.amountMinor ?? Math.round((p.amount ?? 0) * 10 ** exp))}</td></tr>`).join('');
    const when = new Date(sale.invoice.issuedAt).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
    const notes = cns.length ? `<h2>Credit notes</h2><table>${cns.map((c) => `<tr><td><a href="/r/${esc(token)}/credit-note/${esc(c.number)}">${esc(c.number)}</a><div class="sub">${esc(new Date(c.createdAt).toISOString().slice(0, 10))}</div></td><td class="r">−${m(c.totalMinor)}</td></tr>`).join('')}</table>` : '';
    const body = `${this.sellerBlock(sale.invoice.seller)}<h2>Tax invoice <span class="badge">${esc(sale.invoice.number)}</span></h2><div class="sub">${esc(when)}${sale.invoice.offlineRef ? ` · offline ref ${esc(sale.invoice.offlineRef)}` : ''}</div>
<table><tr><th>Item</th><th class="r">Value excl. tax</th><th class="r">Tax</th></tr>${rows}</table>
<table><tr><td>Subtotal</td><td class="r">${m(sale.subtotalMinor)}</td></tr>${Number(sale.discountMinor) > 0 ? `<tr><td>Discount</td><td class="r">−${m(sale.discountMinor)}</td></tr>` : ''}<tr><td>Sales tax</td><td class="r">${m(sale.taxMinor)}</td></tr><tr class="tot"><td>Total</td><td class="r">${m(sale.totalMinor)}</td></tr></table>
<h2>Paid by</h2><table>${pays}</table>${notes}
<!-- fiscal block (FBR invoice number, QR, logo) is reserved here: rendered only once a fiscal number exists -->${sale.invoice.fiscal?.externalInvoiceNumber ? `<div class="fiscal sub">FBR invoice no. ${esc(sale.invoice.fiscal.externalInvoiceNumber)}</div>` : ''}`;
    return this.pageShell(`Tax invoice ${sale.invoice.number}`, name, logo, body);
  }

  /** `/r/:token/credit-note/:number` */
  async renderPublicCreditNote(token: string, number: string): Promise<string | null> {
    if (!/^[A-Za-z0-9_-]{30,40}$/.test(token ?? '') || !/^[A-Z]{2,4}-\d{4,10}$/.test(number ?? '')) return null;
    const sale: any = await this.r.saleModel.findOne({ 'receipt.token': token, 'receipt.revokedAt': null }).lean();
    if (!sale || sale.status === 'held' || sale.status === 'discarded') return null;
    const cn: any = await this.r.posCreditNoteModel.findOne({ saleId: String(sale._id), number }).lean();
    if (!cn) return null;
    const m = this.docMoneyFmt(cn.currency, cn.currencyExponent);
    const { name, logo } = await this.docContext(sale);
    const rows = cn.lines.map((l: any) => `<tr><td>${esc(l.name)}${l.hsCode ? `<div class="sub">HS ${esc(l.hsCode)}</div>` : ''}<div class="sub">${esc(l.qty)} returned</div></td><td class="r">${m(l.netMinor)}</td><td class="r">${m(l.taxMinor)}</td></tr>`).join('');
    const pays = cn.tenders.map((t: any) => `<tr><td>${esc(METHOD_LABEL[t.method] ?? t.method)}</td><td class="r">${m(t.amountMinor)}</td></tr>`).join('');
    const when = new Date(cn.createdAt).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
    const body = `${this.sellerBlock(cn.seller)}<h2>Credit note <span class="badge">${esc(cn.number)}</span></h2><div class="sub">${esc(when)} · against invoice ${esc(cn.invoiceNumber ?? sale.saleNumber)}</div>
<table><tr><th>Item</th><th class="r">Value excl. tax</th><th class="r">Tax reversed</th></tr>${rows}</table>
<table><tr><td>Value excl. tax</td><td class="r">${m(cn.netMinor)}</td></tr><tr><td>Tax reversed</td><td class="r">${m(cn.taxMinor)}</td></tr><tr class="tot"><td>Credited</td><td class="r">${m(cn.totalMinor)}</td></tr></table>
<h2>Refunded to</h2><table>${pays}</table>`;
    return this.pageShell(`Credit note ${cn.number}`, name, logo, body);
  }

  /** The invoice and every credit note of a sale, for the till (print / share). */
  async documentsOf(sellerId: string, saleId: string) {
    const sale: any = await this.r.saleModel.findById(saleId).select('storeId invoice saleNumber status').lean();
    if (!sale) throw new NotFoundException('Sale not found');
    await this.pos.verifyStoreOwnership(sale.storeId, sellerId);
    const creditNotes = await this.r.posCreditNoteModel.find({ saleId }).sort({ seq: 1 }).lean();
    return { success: true, data: { saleNumber: sale.saleNumber, status: sale.status, invoice: sale.invoice ?? null, creditNotes } };
  }
}
