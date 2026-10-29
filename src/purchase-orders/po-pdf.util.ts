/* eslint-disable prettier/prettier */
import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb, PDFImage } from 'pdf-lib';

/** The store's own identity, as printed on the document. Resolved from
 *  `OrderDocumentSettings` (Settings → Order documents) with the store record
 *  as the fallback — the same precedence the printable invoice/slip HTML uses,
 *  so a PO PDF and an order invoice of one store always look like they came
 *  from the same business. */
export interface PoPdfBrand {
  businessName: string;
  addressText: string | null;
  phone: string | null;
  email: string | null;
  /** e.g. "NTN 1234567-8" — label + value already joined, or null. */
  taxLine: string | null;
  /** #rrggbb */
  accentColor: string;
  logoUrl: string | null;
  showLogo: boolean;
  showNameWithLogo: boolean;
  /** Where the logo sits in the masthead — the same setting the invoice header uses. */
  logoAlign: 'left' | 'center' | 'right';
}

export interface PoPdfLine {
  name: string;
  /** variant options, e.g. ["Dusty Rose", "M"] — printed as a sub-line */
  options: string[];
  sku: string | null;
  quantityOrdered: number;
  unitCost: number;
}

export interface PoPdfData {
  poNumber: string;
  status: string;
  issuedAt: Date;
  expectedAt: Date | null;
  orderedAt: Date | null;
  currency: string;
  supplierName: string;
  supplierEmail: string | null;
  supplierPhone: string | null;
  supplierAddress: string | null;
  lines: PoPdfLine[];
  subtotal: number;
  shippingCost: number;
  taxCost: number;
  total: number;
  notes: string | null;
}

const PAGE_W = 595.28; // A4 portrait, points
const PAGE_H = 841.89;
const MARGIN = 42;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? '');
  if (!m) return [0.851, 0.467, 0.341]; // the platform's own terracotta, same fallback as the email shell
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** `amount` 0..1 of white mixed into the accent — used for flat fills, never a shadow. */
function tint(accent: [number, number, number], amount: number) {
  return rgb(
    accent[0] + (1 - accent[0]) * amount,
    accent[1] + (1 - accent[1]) * amount,
    accent[2] + (1 - accent[2]) * amount,
  );
}

function formatDate(d: Date | null): string {
  if (!d || Number.isNaN(new Date(d).getTime())) return '—';
  const x = new Date(d);
  return `${String(x.getUTCDate()).padStart(2, '0')} ${MONTHS[x.getUTCMonth()]} ${x.getUTCFullYear()}`;
}

/** Standard Helvetica can only encode WinAnsi characters — a product named in
 *  Urdu or carrying an emoji would otherwise throw mid-draw, so anything it
 *  cannot represent becomes "?" (same rule as the analytics PDF builder). */
function safe(text: string): string {
  let out = '';
  for (const ch of String(text ?? '').replace(/\s+/g, ' ').trim()) {
    out += ch.codePointAt(0)! <= 0xff ? ch : '?';
  }
  return out;
}

function money(n: number, currency: string): string {
  return `${currency} ${(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Cloudinary serves any format on request, so ask for the two `pdf-lib` can
 *  embed directly. A non-Cloudinary URL is tried as-is. */
function logoCandidates(url: string): string[] {
  if (!/^res\.cloudinary\.com\//i.test(url.replace(/^https?:\/\//i, '').split('/')[0] ?? '')) return [url];
  if (!url.includes('/upload/')) return [url];
  return ['/upload/f_png/', '/upload/f_jpg/'].map(seg => url.replace('/upload/', seg));
}

async function embedLogo(doc: PDFDocument, url: string | null): Promise<PDFImage | null> {
  if (!url || !/^https:\/\//i.test(url)) return null;
  for (const candidate of logoCandidates(url)) {
    try {
      const res = await fetch(candidate, { signal: AbortSignal.timeout(6000), redirect: 'follow' });
      if (!res.ok) continue;
      const bytes = Buffer.from(await res.arrayBuffer());
      const type = (res.headers.get('content-type') ?? '').toLowerCase();
      try {
        return type.includes('png') || candidate.includes('f_png') ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
      } catch {
        // Cloudinary sometimes answers with webp despite the requested format — that one image is simply dropped.
      }
    } catch {
      // unreachable logo host: the document prints without it rather than failing the download.
    }
  }
  return null;
}

/** Draws one Purchase Order as a branded, print-ready A4 PDF. */
export async function buildPurchaseOrderPdf(data: PoPdfData, brand: PoPdfBrand): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Purchase order ${data.poNumber}`);
  doc.setProducer(brand.businessName || 'Solvexo');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const accent = hexToRgb(brand.accentColor);
  const accentRgb = rgb(accent[0], accent[1], accent[2]);
  const ink = rgb(0.09, 0.09, 0.09);
  const mid = rgb(0.42, 0.42, 0.42);
  const soft = rgb(0.62, 0.62, 0.62);
  const hairline = tint(accent, 0.86);

  const logo = brand.showLogo ? await embedLogo(doc, brand.logoUrl) : null;
  const showHeaderName = !logo || brand.showNameWithLogo;

  const innerW = PAGE_W - MARGIN * 2;
  const COL = {
    idx: MARGIN + 4,
    name: MARGIN + 26,
    qty: MARGIN + innerW - 190,
    unit: MARGIN + innerW - 128,
    amount: PAGE_W - MARGIN - 4,
  };
  const nameW = COL.qty - COL.name - 46;

  const pages: PDFPage[] = [];
  let page = doc.addPage([PAGE_W, PAGE_H]);
  pages.push(page);
  let y = PAGE_H;

  const text = (
    value: string, x: number, size: number, f: PDFFont, color: ReturnType<typeof rgb>, align: 'left' | 'center' | 'right' = 'left', atY = y,
  ) => {
    const s = safe(value);
    if (!s) return;
    const w = f.widthOfTextAtSize(s, size);
    const px = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
    page.drawText(s, { x: px, y: atY, size, font: f, color });
  };

  const wrap = (value: string, maxWidth: number, size: number, f: PDFFont): string[] => {
    const words = safe(value).split(' ').filter(Boolean);
    const lines: string[] = [];
    let line = '';
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (f.widthOfTextAtSize(next, size) <= maxWidth || !line) { line = next; continue; }
      lines.push(line);
      line = word;
    }
    if (line) lines.push(line);
    return lines.length ? lines : [''];
  };

  const rule = (gap = 0, color = hairline, thickness = 0.6) => {
    y -= gap;
    page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness, color });
  };

  const newPage = () => {
    page = doc.addPage([PAGE_W, PAGE_H]);
    pages.push(page);
    y = PAGE_H - MARGIN;
  };

  const need = (height: number) => {
    if (y - height < MARGIN + 26) newPage();
  };

  // ── top accent band + masthead ──
  page.drawRectangle({ x: 0, y: PAGE_H - 5, width: PAGE_W, height: 5, color: accentRgb });
  const top = PAGE_H - MARGIN - 8;
  const centered = brand.logoAlign === 'center';
  const idRight = brand.logoAlign === 'right';
  const idX = centered ? PAGE_W / 2 : idRight ? PAGE_W - MARGIN : MARGIN;
  const idAlign: 'left' | 'center' | 'right' = centered ? 'center' : idRight ? 'right' : 'left';
  const titleX = centered ? PAGE_W / 2 : idRight ? MARGIN : PAGE_W - MARGIN;
  const titleAlign: 'left' | 'center' | 'right' = centered ? 'center' : idRight ? 'left' : 'right';

  // The store's identity (logo, plus its name when asked for) on the side the
  // seller chose; the document title on the opposite side.
  let idBottom = top;
  if (logo) {
    const scale = Math.min(150 / logo.width, 42 / logo.height, 1);
    const w = logo.width * scale;
    const h = logo.height * scale;
    const x = idAlign === 'right' ? idX - w : idAlign === 'center' ? (PAGE_W - w) / 2 : idX;
    page.drawImage(logo, { x, y: idBottom - h, width: w, height: h });
    idBottom -= h;
  }
  if (showHeaderName) {
    if (logo) idBottom -= 15;
    text(brand.businessName, idX, 13, bold, ink, idAlign, idBottom);
    idBottom -= 15;
  }
  text('PURCHASE ORDER', titleX, 15, bold, ink, titleAlign, top - 2);
  text(data.poNumber, titleX, 9.5, font, mid, titleAlign, top - 17);

  y = Math.min(idBottom, top - 26) - 10;
  rule(0, hairline, 0.8);
  y -= 16;

  // ── from / to columns ──
  const colW = innerW / 2 - 12;
  const fromX = MARGIN;
  const toX = MARGIN + innerW / 2 + 12;
  const label = (value: string, x: number, atY: number) => text(value, x, 7.5, bold, accentRgb, 'left', atY);

  const fromLines = [
    brand.addressText ? brand.addressText.replace(/\n/g, ', ') : null,
    brand.phone ? `Phone ${brand.phone}` : null,
    brand.email,
    brand.taxLine,
  ].filter(Boolean) as string[];

  const toLines = [
    data.supplierEmail,
    data.supplierPhone ? `Phone ${data.supplierPhone}` : null,
    data.supplierAddress ? data.supplierAddress.replace(/\n/g, ', ') : null,
  ].filter(Boolean) as string[];

  // Each contact line is wrapped to the column width first, so the block's
  // height is the real one — a long address can never sit under the strip below it.
  const blockRows = (lines: string[]) => lines.map(line => wrap(line, colW, 9, font).slice(0, 3));
  const fromRows = blockRows(fromLines);
  const toRows = blockRows(toLines);

  const blockTop = y;
  label('FROM', fromX, blockTop);
  text(brand.businessName, fromX, 11, bold, ink, 'left', blockTop - 15);
  let cursorY = blockTop - 29;
  for (const rows of fromRows) {
    rows.forEach((sub, j) => text(sub, fromX, 9, font, mid, 'left', cursorY - j * 11));
    cursorY -= rows.length * 11 + 1;
  }
  label('SUPPLIER', toX, blockTop);
  text(data.supplierName, toX, 11, bold, ink, 'left', blockTop - 15);
  let supplierY = blockTop - 29;
  for (const rows of toRows) {
    rows.forEach((sub, j) => text(sub, toX, 9, font, mid, 'left', supplierY - j * 11));
    supplierY -= rows.length * 11 + 1;
  }
  y = Math.min(cursorY, supplierY) - 6;

  // ── meta strip ──
  const meta: [string, string][] = [
    ['PO number', data.poNumber],
    ['Date issued', formatDate(data.issuedAt)],
    ['Expected delivery', formatDate(data.expectedAt)],
    ['Status', data.status.replace(/_/g, ' ')],
  ];
  need(50);
  const metaH = 40;
  page.drawRectangle({ x: MARGIN, y: y - metaH, width: innerW, height: metaH, color: tint(accent, 0.94) });
  const metaCol = innerW / meta.length;
  meta.forEach(([k, v], i) => {
    const x = MARGIN + i * metaCol + 10;
    text(k.toUpperCase(), x, 7, bold, soft, 'left', y - 15);
    text(v, x, 10, bold, ink, 'left', y - 30);
  });
  y -= metaH + 22;

  // ── items table ──
  const tableHeader = () => {
    need(40);
    page.drawRectangle({ x: MARGIN, y: y - 18, width: innerW, height: 18, color: tint(accent, 0.86) });
    text('#', COL.idx, 7.5, bold, mid, 'left', y - 12.5);
    text('ITEM', COL.name, 7.5, bold, mid, 'left', y - 12.5);
    text('QTY', COL.qty, 7.5, bold, mid, 'right', y - 12.5);
    text('UNIT COST', COL.unit, 7.5, bold, mid, 'right', y - 12.5);
    text('AMOUNT', COL.amount, 7.5, bold, mid, 'right', y - 12.5);
    y -= 18;
  };
  tableHeader();

  data.lines.forEach((line, i) => {
    const detail = [line.options.join(' / '), line.sku ? `SKU ${line.sku}` : null].filter(Boolean).join(' · ');
    const nameLines = wrap(line.name, nameW, 9.5, bold);
    const detailLines = detail ? wrap(detail, nameW, 8, font) : [];
    const rowH = 12 + nameLines.length * 11.5 + detailLines.length * 10 + 6;
    if (y - rowH < MARGIN + 26) tableHeader();
    const rowTop = y - 12;
    text(String(i + 1), COL.idx, 9, font, soft, 'left', rowTop);
    nameLines.forEach((sub, j) => text(sub, COL.name, 9.5, bold, ink, 'left', rowTop - j * 11.5));
    detailLines.forEach((sub, j) => text(sub, COL.name, 8, font, soft, 'left', rowTop - nameLines.length * 11.5 - 1 - j * 10));
    text(String(line.quantityOrdered), COL.qty, 9.5, font, ink, 'right', rowTop);
    text(money(line.unitCost, data.currency), COL.unit, 9.5, font, ink, 'right', rowTop);
    text(money(line.unitCost * line.quantityOrdered, data.currency), COL.amount, 9.5, bold, ink, 'right', rowTop);
    y = rowTop - nameLines.length * 11.5 - detailLines.length * 10 - 6;
    rule(0, tint(accent, 0.9), 0.5);
  });

  // ── totals ──
  const totals: [string, string, boolean][] = [
    ['Subtotal', money(data.subtotal, data.currency), false],
    ...(data.shippingCost ? [['Shipping', money(data.shippingCost, data.currency), false] as [string, string, boolean]] : []),
    ...(data.taxCost ? [['Tax', money(data.taxCost, data.currency), false] as [string, string, boolean]] : []),
    ['Total', money(data.total, data.currency), true],
  ];
  need(totals.length * 17 + 26);
  y -= 10;
  const labelX = PAGE_W - MARGIN - 190;
  totals.forEach(([k, v, isTotal]) => {
    if (isTotal) {
      page.drawRectangle({ x: labelX - 10, y: y - 17, width: innerW - (labelX - MARGIN) + 10, height: 24, color: tint(accent, 0.9) });
      text(k.toUpperCase(), labelX, 8.5, bold, accentRgb, 'left', y - 4);
      text(v, COL.amount, 12, bold, ink, 'right', y - 5);
      y -= 26;
    } else {
      text(k, labelX, 9.5, font, mid, 'left', y);
      text(v, COL.amount, 9.5, font, ink, 'right', y);
      y -= 17;
    }
  });

  // ── notes ──
  if (data.notes?.trim()) {
    const lines = wrap(data.notes, innerW, 9, font).slice(0, 8);
    need(lines.length * 11 + 26);
    y -= 8;
    label('NOTES', MARGIN, y);
    lines.forEach((sub, i) => text(sub, MARGIN, 9, font, mid, 'left', y - 13 - i * 11));
    y -= 13 + lines.length * 11 + 8;
  }

  // ── footer on every page ──
  const footer = `Page`;
  pages.forEach((p, i) => {
    p.drawLine({ start: { x: MARGIN, y: MARGIN - 6 }, end: { x: PAGE_W - MARGIN, y: MARGIN - 6 }, thickness: 0.5, color: hairline });
    p.drawText(safe(`${brand.businessName} · ${data.poNumber}`), { x: MARGIN, y: MARGIN - 18, size: 7.5, font, color: soft });
    p.drawText(safe(`${footer} ${i + 1} of ${pages.length}`), { x: PAGE_W - MARGIN, y: MARGIN - 18, size: 7.5, font, color: soft });
  });

  return Buffer.from(await doc.save());
}
