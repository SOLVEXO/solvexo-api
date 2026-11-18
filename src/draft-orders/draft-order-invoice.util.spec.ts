import { PDFDocument } from 'pdf-lib';
import { buildInvoiceItemsHtml, buildInvoicePdf, fetchInvoiceLogo, invoiceNumber, type InvoiceDraft } from './draft-order-invoice.util';

const draft = (n = 2): InvoiceDraft => ({
  id: '64f0a1b2c3d4e5f607182939', customerName: 'Uzair', customerEmail: 'u@example.com', currency: 'PKR',
  items: Array.from({ length: n }, (_, i) => ({ name: i === 0 ? 'Smart <Ring> & Co' : `Item ${i}`, options: [{ name: 'Color', value: 'Black' }], sku: `SKU-${i}`, quantity: 2, unitPrice: 2001 })),
  subtotal: 4002 * n, discountAmount: 0, shippingAmount: 100, taxAmount: 0, total: 4002 * n + 100, notes: 'Thank you', dueText: 'Payment is due on receipt.',
});

describe('invoice items html', () => {
  it('lists every item with variant, quantity and totals, and escapes names', () => {
    const html = buildInvoiceItemsHtml(draft(), 'Rs');
    expect(html).toContain('Smart &lt;Ring&gt; &amp; Co');
    expect(html).not.toContain('<Ring>');
    expect(html).toContain('Black');
    expect(html).toContain('Rs 2,001.00');
    expect(html).toContain('Rs 4,002.00');
    expect(html).toContain('Shipping');
    expect(html).not.toContain('Discount');
    expect(html).toContain('Rs 8,104.00');
  });
});

describe('invoice items html in another language', () => {
  it('uses the given labels and flips the table for a right-to-left language', () => {
    const labels = { invItem: 'آئٹم', invQty: 'تعداد', invPrice: 'قیمت', invTotal: 'کل', invSubtotal: 'ذیلی کل', invDiscount: 'رعایت', invShipping: 'شپنگ', invTax: 'ٹیکس', invGrandTotal: 'کل رقم' };
    const html = buildInvoiceItemsHtml(draft(), 'Rs', labels, true);
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('آئٹم');
    expect(html).toContain('کل رقم');
    expect(html).not.toContain('>Subtotal<');
  });
});

describe('invoice pdf', () => {
  it('is a real PDF', async () => {
    const buf = await buildInvoicePdf(draft(), { name: 'Amarawears', accent: '#6B2D44' }, 'Rs', 'https://amara.example/pay-invoice/abc');
    expect(buf.subarray(0, 4).toString()).toBe('%PDF');
    const doc = await PDFDocument.load(buf);
    expect(doc.getPageCount()).toBe(1);
  });

  it('runs onto more pages for a long invoice and survives non-Latin names', async () => {
    const d = draft(60);
    d.items[1].name = 'پروڈکٹ — سونا';
    const buf = await buildInvoicePdf(d, { name: 'Amarawears' }, 'Rs', 'https://amara.example/pay-invoice/abc');
    const doc = await PDFDocument.load(buf);
    expect(doc.getPageCount() > 1).toBe(true);
  });

  it('numbers the invoice from the draft id', () => {
    expect(invoiceNumber('64f0a1b2c3d4e5f607182939')).toBe('#182939');
  });
});

describe('invoice pdf: brand, status and the rule under each row', () => {
  // 1x1 PNG
  const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));

  it('builds with a logo, with a paid draft, and with the new fields left out', async () => {
    const withLogo = await buildInvoicePdf({ ...draft(), paid: false, address: ['A', 'B'], customerPhone: '0300' }, { name: 'Amarawears', accent: '#6B2D44', logo: { bytes: PNG, kind: 'png' }, contactEmail: 'a@b.co', contactPhone: '123' }, 'Rs', 'https://x.example/p');
    expect(withLogo.subarray(0, 5).toString()).toBe('%PDF-');
    const paid = await buildInvoicePdf({ ...draft(), paid: true, paidAt: new Date('2026-11-18') }, { name: 'Amarawears' }, 'Rs', 'https://x.example/p');
    expect(paid.subarray(0, 5).toString()).toBe('%PDF-');
    const plain = await buildInvoicePdf(draft(), { name: 'Amarawears' }, 'Rs', 'https://x.example/p');
    expect(plain.length).toBeGreaterThan(500);
  });

  /** The target of every link annotation on the document's pages. */
  const linksOf = async (buf: Buffer): Promise<string[]> => {
    const { PDFDict, PDFName, PDFString } = await import('pdf-lib');
    const doc = await PDFDocument.load(buf);
    const out: string[] = [];
    for (const page of doc.getPages()) {
      const annots = page.node.Annots();
      for (let i = 0; annots && i < annots.size(); i++) {
        const a = annots.lookup(i, PDFDict);
        const action = a.lookup(PDFName.of('A'), PDFDict);
        out.push(action.lookup(PDFName.of('URI'), PDFString).decodeText());
      }
    }
    return out;
  };

  it('an unpaid invoice carries a clickable Pay now link to the pay page; a paid one has none', async () => {
    const url = 'https://www.solvexo.store/pay-invoice/abc123';
    expect(await linksOf(await buildInvoicePdf(draft(), { name: 'S' }, 'Rs', url))).toEqual([url]);
    expect(await linksOf(await buildInvoicePdf({ ...draft(), paid: true }, { name: 'S' }, 'Rs', url))).toEqual([]);
  });

  it('a long invoice still runs onto more pages', async () => {
    const many = await PDFDocument.load(await buildInvoicePdf(draft(60), { name: 'S' }, 'Rs', 'https://x.example/p'));
    expect(many.getPageCount()).toBeGreaterThan(1);
  });
});

describe('invoice logo download (never throws, only safe https images)', () => {
  it('refuses anything that is not a public https address, without fetching', async () => {
    const spy = jest.fn();
    (global as any).fetch = spy;
    for (const u of [null, undefined, '', 'http://img.example/logo.png', 'https://localhost/a.png', 'https://127.0.0.1/a.png', 'https://10.0.0.5/a.png', 'https://192.168.1.2/a.png', 'https://169.254.169.254/latest', 'ftp://x/a.png', 'not a url']) {
      expect(await fetchInvoiceLogo(u as any)).toBeNull();
    }
    expect(spy.mock.calls.length).toBe(0);
  });

  it('accepts a PNG or JPEG, asks Cloudinary for PNG, and rejects other files and failures', async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6]);
    const jpg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6]);
    const webp = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 5, 6]);
    const reply = (bytes: Uint8Array, ok = true) => ({ ok, headers: { get: () => String(bytes.length) }, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
    const urls: string[] = [];
    (global as any).fetch = async (u: string) => { urls.push(u); return reply(u.includes('jpgcase') ? jpg : u.includes('webpcase') ? webp : png); };
    expect(await fetchInvoiceLogo('https://res.cloudinary.com/demo/image/upload/v1/logo.webp')).toMatchObject({ kind: 'png' });
    expect(urls[0]).toContain('/image/upload/f_png,w_400/');
    expect(await fetchInvoiceLogo('https://cdn.example.com/jpgcase.jpg')).toMatchObject({ kind: 'jpg' });
    expect(await fetchInvoiceLogo('https://cdn.example.com/webpcase.webp')).toBeNull();
    (global as any).fetch = async () => reply(png, false);
    expect(await fetchInvoiceLogo('https://cdn.example.com/x.png')).toBeNull();
    (global as any).fetch = async () => { throw new Error('network'); };
    expect(await fetchInvoiceLogo('https://cdn.example.com/x.png')).toBeNull();
  });
});
