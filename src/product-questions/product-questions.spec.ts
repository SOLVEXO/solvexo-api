import { BadRequestException, NotFoundException } from '@nestjs/common';
import { cleanAnswer, cleanQuestion } from './product-questions.util';
import { ProductQuestionsService } from './product-questions.service';

/** A tiny in-memory stand-in for the mongoose model: just the calls the service makes. */
function fakeModel() {
  const rows: any[] = [];
  let n = 0;
  const match = (r: any, f: any) => Object.entries(f).every(([k, v]) => (v && typeof v === 'object' && '$in' in (v as any)) ? (v as any).$in.includes(r[k]) : r[k] === v);
  const chain = (list: any[]) => ({ sort: () => chain(list), skip: () => chain(list), limit: () => chain(list), lean: async () => list });
  return {
    rows,
    create: async (d: any) => { const r = { _id: `q${++n}`, createdAt: new Date(), answer: '', answeredAt: null, ...d }; rows.push(r); return r; },
    find: (f: any) => chain(rows.filter(r => match(r, f))),
    countDocuments: async (f: any) => rows.filter(r => match(r, f)).length,
    findOne: (f: any) => ({ lean: async () => rows.find(r => match(r, f)) ?? null }),
    findOneAndUpdate: (f: any, u: any) => ({ lean: async () => { const r = rows.find(x => match(x, f)); if (r) Object.assign(r, u.$set); return r ?? null; } }),
    updateOne: async (f: any, u: any) => { const r = rows.find(x => match(x, f)); if (r) Object.assign(r, u.$set); },
    deleteOne: async (f: any) => { const i = rows.findIndex(x => match(x, f)); if (i >= 0) rows.splice(i, 1); return { deletedCount: i >= 0 ? 1 : 0 }; },
  };
}
const db = (products: any[]) => ({ repositories: { productModel: { findOne: (f: any) => ({ select: () => ({ lean: async () => products.find(p => p._id === f._id && p.storeId === f.storeId) ?? null }) }), find: () => ({ select: () => ({ lean: async () => products }) }) } } });

describe('product questions: what a shopper may send', () => {
  it('accepts a normal question and cleans it', () => {
    expect(cleanQuestion({ name: ' Sara ', question: 'Does it  fit a 15 inch laptop?', email: 'sara@example.com' })).toEqual({ askerName: 'Sara', askerEmail: 'sara@example.com', question: 'Does it fit a 15 inch laptop?' });
  });
  it('strips tags, rejects short text, bad email, many links and bot-filled field', () => {
    expect(cleanQuestion({ name: 'Al', question: '<b>Is it waterproof?</b>' }).question).toBe('Is it waterproof?');
    expect(() => cleanQuestion({ name: 'A', question: 'Is it waterproof?' })).toThrow(/name/);
    expect(() => cleanQuestion({ name: 'Sara', question: 'hi' })).toThrow(/question/);
    expect(() => cleanQuestion({ name: 'Sara', question: 'Is it ok?', email: 'nope' })).toThrow(/email/);
    expect(() => cleanQuestion({ name: 'Sara', question: 'see http://a.test and http://b.test' })).toThrow(/links/);
    expect(() => cleanQuestion({ name: 'Sara', question: 'Is it ok?', website: 'http://spam' })).toThrow();
  });
  it('answers must not be empty', () => { expect(() => cleanAnswer('  ')).toThrow(); expect(cleanAnswer(' Yes. ')).toBe('Yes.'); });
});

describe('ProductQuestionsService', () => {
  const setup = () => { const model = fakeModel(); const svc = new ProductQuestionsService(model as any, db([{ _id: 'P1', storeId: 'S1', name: 'Tee', slug: 'tee' }]) as any); return { model, svc }; };

  it('a new question waits: the storefront shows nothing until the seller answers', async () => {
    const { svc } = setup();
    await svc.ask('S1', 'P1', { name: 'Sara', question: 'Does it shrink?', email: 'sara@example.com' });
    expect((await svc.publicList('S1', 'P1')).items).toHaveLength(0);
    const inbox = await svc.sellerList('S1', {});
    expect(inbox.pending).toBe(1);
    expect(inbox.items[0]).toMatchObject({ askerEmail: 'sara@example.com', productName: 'Tee', status: 'pending' });
  });
  it('answering publishes it, without the email', async () => {
    const { svc } = setup();
    await svc.ask('S1', 'P1', { name: 'Sara', question: 'Does it shrink?', email: 'sara@example.com' });
    const id = (await svc.sellerList('S1', {})).items[0].id;
    await svc.answer('S1', id, { answer: 'No, pre-washed.' });
    const pub = (await svc.publicList('S1', 'P1')).items;
    expect(pub).toHaveLength(1);
    expect(pub[0].answer).toBe('No, pre-washed.');
    expect(JSON.stringify(pub)).not.toContain('sara@example.com');
  });
  it('hide / publish rules: cannot publish without an answer; hidden disappears; other stores cannot touch it', async () => {
    const { svc } = setup();
    await svc.ask('S1', 'P1', { name: 'Sara', question: 'Does it shrink?' });
    const id = (await svc.sellerList('S1', {})).items[0].id;
    await expect(svc.setStatus('S1', id, 'published')).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.setStatus('S1', id, 'weird')).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.answer('S2', id, { answer: 'x' })).rejects.toBeInstanceOf(NotFoundException);
    await svc.answer('S1', id, { answer: 'No.' });
    await svc.setStatus('S1', id, 'hidden');
    expect((await svc.publicList('S1', 'P1')).items).toHaveLength(0);
    await expect(svc.remove('S2', id)).rejects.toBeInstanceOf(NotFoundException);
    await svc.remove('S1', id);
    expect((await svc.sellerList('S1', {})).items).toHaveLength(0);
  });
  it('asking about a product that is not in the store fails; too many waiting questions are refused', async () => {
    const { svc } = setup();
    await expect(svc.ask('S1', 'NOPE', { name: 'Sara', question: 'Does it shrink?' })).rejects.toBeInstanceOf(NotFoundException);
    for (let i = 0; i < 30; i++) await svc.ask('S1', 'P1', { name: 'Sara', question: `Question number ${i}?` });
    await expect(svc.ask('S1', 'P1', { name: 'Sara', question: 'One more please?' })).rejects.toBeInstanceOf(BadRequestException);
  });
});
