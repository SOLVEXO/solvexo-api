/* eslint-disable prettier/prettier */
import { runBulkImport } from '../common/bulk-import/bulk-import.util';
import { TESTIMONIAL_COLUMNS, makeTestimonialRowHandler, testimonialFileDedupeKey } from './testimonials-bulk-import';

describe('testimonials bulk import', () => {
  it('creates valid rows, skips existing name+text, reports invalid', async () => {
    const created: any[] = [];
    const handler = makeTestimonialRowHandler({
      exists: async (n, t) => n.toLowerCase() === 'old' && t.toLowerCase() === 'great',
      create: async (dto) => { created.push(dto); },
    });
    const res: any = await runBulkImport({
      text: 'Seller name,Store name,Rating,Text,Verified seller,Order,Active\nAna,Shop,5,Nice,yes,2,no\nOLD,,4,GREAT,,,\nBo,,6,Fine,,,\nCy,,3,,,,\nDi,,x,Hi,,,\nAna,,5,nice,,,\n',
      columns: TESTIMONIAL_COLUMNS, maxRows: 50, label: 'testimonial', handler, fileDedupeKey: testimonialFileDedupeKey,
    });
    expect(res.data.created).toBe(1);
    expect(res.data.skipped).toBe(1);
    expect(res.data.failedCount).toBe(4);
    expect(created[0]).toEqual({ sellerName: 'Ana', storeName: 'Shop', rating: 5, text: 'Nice', isVerifiedSeller: true, order: 2, isActive: false });
    const errs = res.data.failed.map((f: any) => f.error).join('|');
    expect(errs).toContain('Rating must be at most 5');
    expect(errs).toContain('Text is required');
    expect(errs).toContain('Rating must be a number');
    expect(errs).toContain('Duplicate of row');
  });
});
