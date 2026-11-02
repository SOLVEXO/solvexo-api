import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from 'pdf-lib';

// What goes out with a draft-order invoice email: the items as an HTML table in the mail body, and the same invoice as a PDF.

export interface InvoiceLine { name: string; options: { name: string; value: string }[]; sku: string | null; quantity: number; unitPrice: number }
export interface InvoiceDraft {
  id: string;
  customerName: string;
  customerEmail: string | null;
  currency: string;
  items: InvoiceLine[];
  subtotal: number;
  discountAmount: number;
  shippingAmount: number;
  taxAmount: number;
  total: number;
  notes?: string | null;
  dueText?: string;
}

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const invoiceNumber = (id: string) => `#${String(id).slice(-6).toUpperCase()}`;
const money = (symbol: string, n: number) => `${symbol} ${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const optionText = (o: { name: string; value: string }[]) => o.map(x => x.value).filter(Boolean).join(' / ');

/** The items and totals as an email-safe table (inline styles only; every value escaped). */
export function buildInvoiceItemsHtml(d: InvoiceDraft, symbol: string): string {
  const th = 'text-align:left;padding:8px 6px;border-bottom:2px solid #222;font-size:12px;color:#555;';
  const td = 'padding:8px 6px;border-bottom:1px solid #e5e5e5;font-size:13px;vertical-align:top;';
  const rows = d.items.map(i => {
    const opt = optionText(i.options);
    return `<tr><td style="${td}"><strong>${esc(i.name)}</strong>${opt ? `<br><span style="color:#777;font-size:12px;">${esc(opt)}</span>` : ''}</td>`
      + `<td style="${td}text-align:center;">${i.quantity}</td><td style="${td}text-align:right;white-space:nowrap;">${esc(money(symbol, i.unitPrice))}</td>`
      + `<td style="${td}text-align:right;white-space:nowrap;">${esc(money(symbol, i.unitPrice * i.quantity))}</td></tr>`;
  }).join('');
  const total = (label: string, v: string, strong = false) =>
    `<tr><td colspan="3" style="padding:4px 6px;text-align:right;font-size:13px;${strong ? 'font-weight:bold;' : 'color:#555;'}">${esc(label)}</td><td style="padding:4px 6px;text-align:right;font-size:13px;white-space:nowrap;${strong ? 'font-weight:bold;' : ''}">${esc(v)}</td></tr>`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:18px 0 8px;">
<thead><tr><th style="${th}">Item</th><th style="${th}text-align:center;">Qty</th><th style="${th}text-align:right;">Price</th><th style="${th}text-align:right;">Total</th></tr></thead>
<tbody>${rows}</tbody>
<tfoot>${total('Subtotal', money(symbol, d.subtotal))}${d.discountAmount > 0 ? total('Discount', `- ${money(symbol, d.discountAmount)}`) : ''}${d.shippingAmount > 0 ? total('Shipping', money(symbol, d.shippingAmount)) : ''}${d.taxAmount > 0 ? total('Tax', money(symbol, d.taxAmount)) : ''}${total('Total', money(symbol, d.total), true)}</tfoot></table>`;
}

// Helvetica (the built-in PDF font) cannot draw other scripts: they print as "?" instead of failing.
const safe = (s: string) => String(s ?? '').replace(/[^\x20-\x7E -ÿ]/g, '?');

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const M = 42;

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of safe(text).split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) <= width) { line = next; continue; }
    if (line) out.push(line);
    line = word;
  }
  if (line) out.push(line);
  return out.length ? out : [''];
}

/** A simple A4 invoice: store, customer, items (several pages when long), totals, notes. */
export async function buildInvoicePdf(d: InvoiceDraft, store: { name: string; accent?: string | null }, symbol: string, payUrl: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const hex = /^#?([0-9a-f]{6})$/i.exec(store.accent ?? '')?.[1] ?? 'D97757';
  const accent = rgb(parseInt(hex.slice(0, 2), 16) / 255, parseInt(hex.slice(2, 4), 16) / 255, parseInt(hex.slice(4, 6), 16) / 255);
  const ink = rgb(0.1, 0.1, 0.1);
  const muted = rgb(0.4, 0.4, 0.4);
  const rule = rgb(0.85, 0.85, 0.85);

  let page: PDFPage = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - M;
  const text = (t: string, x: number, size: number, f: PDFFont = font, color = ink, right = false) => {
    const s = safe(t);
    page.drawText(s, { x: right ? x - f.widthOfTextAtSize(s, size) : x, y, size, font: f, color });
  };
  const colName = M, colQty = 360, colPrice = 450, colTotal = PAGE_W - M;
  const header = () => {
    text('Item', colName, 9, bold, muted); text('Qty', colQty, 9, bold, muted, true); text('Price', colPrice, 9, bold, muted, true); text('Total', colTotal, 9, bold, muted, true);
    y -= 6; page.drawLine({ start: { x: M, y }, end: { x: PAGE_W - M, y }, thickness: 1, color: ink }); y -= 14;
  };
  const room = (h: number) => { if (y - h < M + 30) { page = doc.addPage([PAGE_W, PAGE_H]); y = PAGE_H - M; header(); } };

  text(store.name, M, 20, bold, accent); y -= 26;
  text('Invoice', M, 13, bold); text(invoiceNumber(d.id), M + 52, 13, font, muted); y -= 18;
  text(`Billed to: ${d.customerName}${d.customerEmail ? ` <${d.customerEmail}>` : ''}`, M, 10); y -= 14;
  text(`Date: ${new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}`, M, 10, font, muted); y -= 14;
  if (d.dueText) { text(d.dueText, M, 10, font, muted); y -= 14; }
  y -= 12;
  header();

  for (const i of d.items) {
    const opt = optionText(i.options);
    const nameLines = wrap(i.name, bold, 10, colQty - 60 - colName);
    room(nameLines.length * 13 + (opt ? 13 : 0) + 10);
    const top = y;
    for (const l of nameLines) { text(l, colName, 10, bold); y -= 13; }
    if (opt) { text(opt, colName, 9, font, muted); y -= 12; }
    const after = y;
    y = top;
    text(String(i.quantity), colQty, 10, font, ink, true); text(money(symbol, i.unitPrice), colPrice, 10, font, ink, true); text(money(symbol, i.unitPrice * i.quantity), colTotal, 10, font, ink, true);
    y = after - 6;
    page.drawLine({ start: { x: M, y: y + 3 }, end: { x: PAGE_W - M, y: y + 3 }, thickness: 0.5, color: rule });
  }

  const totals: [string, string, boolean][] = [['Subtotal', money(symbol, d.subtotal), false]];
  if (d.discountAmount > 0) totals.push(['Discount', `- ${money(symbol, d.discountAmount)}`, false]);
  if (d.shippingAmount > 0) totals.push(['Shipping', money(symbol, d.shippingAmount), false]);
  if (d.taxAmount > 0) totals.push(['Tax', money(symbol, d.taxAmount), false]);
  totals.push(['Total', money(symbol, d.total), true]);
  room(totals.length * 16 + 60);
  y -= 8;
  for (const [label, value, strong] of totals) {
    text(label, colPrice, strong ? 11 : 10, strong ? bold : font, strong ? ink : muted, true);
    text(value, colTotal, strong ? 11 : 10, strong ? bold : font, ink, true);
    y -= 16;
  }
  if (d.notes?.trim()) {
    y -= 10; room(40);
    text('Notes', M, 9, bold, muted); y -= 13;
    for (const l of wrap(d.notes, font, 10, PAGE_W - 2 * M)) { room(14); text(l, M, 10); y -= 13; }
  }
  y -= 14; room(40);
  text('Pay this invoice securely online:', M, 10, bold); y -= 13;
  for (const l of wrap(payUrl, font, 9, PAGE_W - 2 * M)) { text(l, M, 9, font, accent); y -= 12; }

  return Buffer.from(await doc.save());
}
