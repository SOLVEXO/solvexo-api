import { repairMojibake } from '@/common/repair-mojibake.util';
import { PDFDocument, PDFFont, PDFPage, PDFString, StandardFonts, rgb } from 'pdf-lib';

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
  /** Marked paid: the PDF says PAID and has no Pay now button. */
  paid?: boolean;
  paidAt?: string | Date | null;
  customerPhone?: string | null;
  /** Delivery address lines, in the order they should print. */
  address?: string[];
}

const esc = (s: unknown) => repairMojibake(String(s ?? '')).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const invoiceNumber = (id: string) => `#${String(id).slice(-6).toUpperCase()}`;
const money = (symbol: string, n: number) => `${symbol} ${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const optionText = (o: { name: string; value: string }[]) => o.map(x => x.value).filter(Boolean).join(' / ');

/** The items and totals as an email-safe table (inline styles only; every value escaped). */
export interface InvoiceLabels { invItem: string; invQty: string; invPrice: string; invTotal: string; invSubtotal: string; invDiscount: string; invShipping: string; invTax: string; invGrandTotal: string }
const EN_LABELS: InvoiceLabels = { invItem: 'Item', invQty: 'Qty', invPrice: 'Price', invTotal: 'Total', invSubtotal: 'Subtotal', invDiscount: 'Discount', invShipping: 'Shipping', invTax: 'Tax', invGrandTotal: 'Total' };

export function buildInvoiceItemsHtml(d: InvoiceDraft, symbol: string, labels: InvoiceLabels = EN_LABELS, rtl = false): string {
  const start = rtl ? 'right' : 'left';
  const end = rtl ? 'left' : 'right';
  const th = `text-align:${start};padding:8px 6px;border-bottom:2px solid #222;font-size:12px;color:#555;`;
  const td = 'padding:8px 6px;border-bottom:1px solid #e5e5e5;font-size:13px;vertical-align:top;';
  const rows = d.items.map(i => {
    const opt = optionText(i.options);
    return `<tr><td style="${td}"><strong>${esc(i.name)}</strong>${opt ? `<br><span style="color:#777;font-size:12px;">${esc(opt)}</span>` : ''}</td>`
      + `<td style="${td}text-align:center;">${i.quantity}</td><td style="${td}text-align:${end};white-space:nowrap;">${esc(money(symbol, i.unitPrice))}</td>`
      + `<td style="${td}text-align:${end};white-space:nowrap;">${esc(money(symbol, i.unitPrice * i.quantity))}</td></tr>`;
  }).join('');
  const total = (label: string, v: string, strong = false) =>
    `<tr><td colspan="3" style="padding:4px 6px;text-align:${end};font-size:13px;${strong ? 'font-weight:bold;' : 'color:#555;'}">${esc(label)}</td><td style="padding:4px 6px;text-align:${end};font-size:13px;white-space:nowrap;${strong ? 'font-weight:bold;' : ''}">${esc(v)}</td></tr>`;
  return `<table role="presentation" dir="${rtl ? 'rtl' : 'ltr'}" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:18px 0 8px;">
<thead><tr><th style="${th}">${esc(labels.invItem)}</th><th style="${th}text-align:center;">${esc(labels.invQty)}</th><th style="${th}text-align:${end};">${esc(labels.invPrice)}</th><th style="${th}text-align:${end};">${esc(labels.invTotal)}</th></tr></thead>
<tbody>${rows}</tbody>
<tfoot>${total(labels.invSubtotal, money(symbol, d.subtotal))}${d.discountAmount > 0 ? total(labels.invDiscount, `- ${money(symbol, d.discountAmount)}`) : ''}${d.shippingAmount > 0 ? total(labels.invShipping, money(symbol, d.shippingAmount)) : ''}${d.taxAmount > 0 ? total(labels.invTax, money(symbol, d.taxAmount)) : ''}${total(labels.invGrandTotal, money(symbol, d.total), true)}</tfoot></table>`;
}

// Helvetica (the built-in PDF font) cannot draw other scripts: they print as "?" instead of failing.
const safe = (s: string) => repairMojibake(String(s ?? '')).replace(/[^\x20-\x7E -ÿ]/g, '?');

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

/** What the PDF shows about the store: its name, brand colour, logo (already downloaded) and contact line. */
export interface InvoiceStore {
  name: string;
  accent?: string | null;
  logo?: { bytes: Uint8Array; kind: 'png' | 'jpg' } | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
}

const MAX_LOGO_BYTES = 1_500_000;
// A logo address must be a public https site: never a local / private network address.
const PRIVATE_HOST = /^(localhost|0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|\d{1,3}(\.\d{1,3}){3}$)/i;

/** Downloads the store logo for the PDF. Only PNG / JPEG can go into a PDF, so a Cloudinary image is asked for as PNG.
 *  Never throws: no logo (or a slow / odd one) simply means the invoice shows the store name only. */
export async function fetchInvoiceLogo(url: string | null | undefined): Promise<InvoiceStore['logo']> {
  try {
    let u = String(url ?? '').trim();
    if (!/^https:\/\//i.test(u)) return null;
    const parsed = new URL(u);
    if (PRIVATE_HOST.test(parsed.hostname)) return null;
    if (/(^|\.)res\.cloudinary\.com$/i.test(parsed.hostname) && /\/image\/upload\//.test(parsed.pathname) && !/\/upload\/[^/]*f_/.test(parsed.pathname)) {
      u = u.replace('/image/upload/', '/image/upload/f_png,w_400/');
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    try {
      const res = await fetch(u, { signal: ctrl.signal, redirect: 'error' });
      if (!res.ok) return null;
      if (Number(res.headers.get('content-length') ?? 0) > MAX_LOGO_BYTES) return null;
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length < 8 || bytes.length > MAX_LOGO_BYTES) return null;
      if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return { bytes, kind: 'png' };
      if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { bytes, kind: 'jpg' };
      return null;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

/** White or dark text, whichever reads better on the given fill. */
function inkOn(hex: string): { r: number; g: number; b: number } {
  const n = parseInt(hex, 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  const lum = 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  return lum < 0.5 ? { r: 1, g: 1, b: 1 } : { r: 0.07, g: 0.07, b: 0.07 };
}

/** An A4 invoice: store brand (logo, colour, contact), status (Paid / Unpaid), customer and delivery address, items (several
 *  pages when long), totals, notes and a "Pay now" button that opens the secure pay page. */
export async function buildInvoicePdf(d: InvoiceDraft, store: InvoiceStore, symbol: string, payUrl: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const hex = /^#?([0-9a-f]{6})$/i.exec(store.accent ?? '')?.[1] ?? 'D97757';
  const accent = rgb(parseInt(hex.slice(0, 2), 16) / 255, parseInt(hex.slice(2, 4), 16) / 255, parseInt(hex.slice(4, 6), 16) / 255);
  const onAccent = inkOn(hex);
  const ink = rgb(0.1, 0.1, 0.1);
  const muted = rgb(0.4, 0.4, 0.4);
  const rule = rgb(0.85, 0.85, 0.85);
  const green = rgb(0.09, 0.5, 0.24);

  let page: PDFPage = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - M;
  const right = PAGE_W - M;
  const text = (t: string, x: number, size: number, f: PDFFont = font, color = ink, alignRight = false) => {
    const s = safe(t);
    page.drawText(s, { x: alignRight ? x - f.widthOfTextAtSize(s, size) : x, y, size, font: f, color });
  };
  const colName = M, colQty = 360, colPrice = 450, colTotal = right;
  const header = () => {
    text('Item', colName, 9, bold, muted); text('Qty', colQty, 9, bold, muted, true); text('Price', colPrice, 9, bold, muted, true); text('Total', colTotal, 9, bold, muted, true);
    y -= 6; page.drawLine({ start: { x: M, y }, end: { x: right, y }, thickness: 1, color: ink }); y -= 14;
  };
  const room = (h: number) => { if (y - h < M + 30) { page = doc.addPage([PAGE_W, PAGE_H]); y = PAGE_H - M; header(); } };

  // ── brand header: logo + name (left), invoice number / date / status (right) ──
  const top = y;
  let nameX = M;
  if (store.logo) {
    try {
      const img = store.logo.kind === 'png' ? await doc.embedPng(store.logo.bytes) : await doc.embedJpg(store.logo.bytes);
      const k = Math.min(150 / img.width, 40 / img.height, 1);
      const w = img.width * k; const h = img.height * k;
      page.drawImage(img, { x: M, y: top - h, width: w, height: h });
      nameX = M + w + 12;
    } catch { nameX = M; /* an image the PDF cannot read: name only */ }
  }
  y = top - 22;
  text(store.name, nameX, 20, bold, accent);
  const contact = [store.contactEmail, store.contactPhone].filter(Boolean).join('  |  ');
  if (contact) { y -= 14; text(contact, nameX, 9, font, muted); }

  y = top - 16; text('INVOICE', right, 18, bold, ink, true);
  y -= 15; text(invoiceNumber(d.id), right, 11, font, muted, true);
  y -= 14; text(new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }), right, 9, font, muted, true);
  const label = d.paid ? 'PAID' : 'UNPAID';
  const bw = bold.widthOfTextAtSize(label, 9) + 16;
  y -= 22;
  page.drawRectangle({ x: right - bw, y: y - 4, width: bw, height: 17, color: d.paid ? green : accent });
  page.drawText(label, { x: right - bw + 8, y, size: 9, font: bold, color: d.paid ? rgb(1, 1, 1) : rgb(onAccent.r, onAccent.g, onAccent.b) });

  y = Math.min(y, top - 62) - 14;
  page.drawLine({ start: { x: M, y }, end: { x: right, y }, thickness: 2, color: accent });
  y -= 22;

  // ── billed to / deliver to ──
  const billed = [d.customerName, d.customerEmail ?? '', d.customerPhone ?? ''].filter(Boolean);
  const deliver = (d.address ?? []).filter(Boolean);
  const startY = y;
  text('BILLED TO', M, 8, bold, muted); y -= 13;
  billed.forEach((l, i) => { text(l, M, i === 0 ? 11 : 10, i === 0 ? bold : font, i === 0 ? ink : muted); y -= 13; });
  const afterBilled = y;
  if (deliver.length) {
    y = startY;
    text('DELIVER TO', 320, 8, bold, muted); y -= 13;
    for (const l of deliver.flatMap((x) => wrap(x, font, 10, right - 320))) { text(l, 320, 10, font, ink); y -= 13; }
  }
  y = Math.min(y, afterBilled) - 6;
  if (d.dueText && !d.paid) { text(d.dueText, M, 10, font, muted); y -= 14; }
  y -= 10;
  header();

  // ── items ──
  for (const i of d.items) {
    const opt = optionText(i.options);
    const nameLines = wrap(i.name, bold, 10, colQty - 60 - colName);
    room(nameLines.length * 13 + (opt ? 13 : 0) + 14);
    const rowTop = y;
    for (const l of nameLines) { text(l, colName, 10, bold); y -= 13; }
    if (opt) { text(opt, colName, 9, font, muted); y -= 12; }
    const after = y;
    y = rowTop;
    text(String(i.quantity), colQty, 10, font, ink, true); text(money(symbol, i.unitPrice), colPrice, 10, font, ink, true); text(money(symbol, i.unitPrice * i.quantity), colTotal, 10, font, ink, true);
    // the thin rule goes BELOW the row with room for the next row's text (it used to cut through it)
    y = after - 2;
    page.drawLine({ start: { x: M, y }, end: { x: right, y }, thickness: 0.5, color: rule });
    y -= 16;
  }

  // ── totals ──
  const totals: [string, string, boolean][] = [['Subtotal', money(symbol, d.subtotal), false]];
  if (d.discountAmount > 0) totals.push(['Discount', `- ${money(symbol, d.discountAmount)}`, false]);
  if (d.shippingAmount > 0) totals.push(['Shipping', money(symbol, d.shippingAmount), false]);
  if (d.taxAmount > 0) totals.push(['Tax', money(symbol, d.taxAmount), false]);
  totals.push(['Total', money(symbol, d.total), true]);
  room(totals.length * 16 + 90);
  y -= 4;
  for (const [lbl, value, strong] of totals) {
    text(lbl, colPrice, strong ? 11 : 10, strong ? bold : font, strong ? ink : muted, true);
    text(value, colTotal, strong ? 11 : 10, strong ? bold : font, ink, true);
    y -= 16;
  }
  if (d.paid) {
    const when = d.paidAt ? new Date(d.paidAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
    text(`Paid in full${when ? ` on ${when}` : ''}`, colTotal, 10, bold, green, true); y -= 16;
  }
  if (d.notes?.trim()) {
    y -= 10; room(40);
    text('Notes', M, 9, bold, muted); y -= 13;
    for (const l of wrap(d.notes, font, 10, PAGE_W - 2 * M)) { room(14); text(l, M, 10); y -= 13; }
  }

  // ── pay now ──
  y -= 14; room(d.paid ? 30 : 90);
  if (!d.paid) {
    const bwid = 140; const bh = 30;
    const by = y - bh + 10;
    page.drawRectangle({ x: M, y: by, width: bwid, height: bh, color: accent });
    const label2 = 'Pay now';
    const lw = bold.widthOfTextAtSize(label2, 12);
    page.drawText(label2, { x: M + (bwid - lw) / 2, y: by + 10, size: 12, font: bold, color: rgb(onAccent.r, onAccent.g, onAccent.b) });
    try {
      const annot = doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [M, by, M + bwid, by + bh], Border: [0, 0, 0], A: { Type: 'Action', S: 'URI', URI: PDFString.of(payUrl) } }));
      page.node.addAnnot(annot);
    } catch { /* the plain link below still works */ }
    y = by - 14;
    text('Or copy this secure link into your browser:', M, 9, font, muted); y -= 12;
    for (const l of wrap(payUrl, font, 8.5, PAGE_W - 2 * M)) { text(l, M, 8.5, font, accent); y -= 11; }
  } else {
    text(`Thank you for your order from ${store.name}.`, M, 10, font, muted);
  }

  return Buffer.from(await doc.save());
}
