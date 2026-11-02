import { PDFDocument } from 'pdf-lib';
import { buildInvoiceItemsHtml, buildInvoicePdf, invoiceNumber, type InvoiceDraft } from './draft-order-invoice.util';

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
