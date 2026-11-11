import { SeoAiService, AI_SEO_SUGGESTION_CREDIT_COST } from './seo-ai.service';
import { FakeModel } from '../../digital-access/testing/fake-db.kit-spec';

/** AI SEO: a suggestion is a PREVIEW until the seller accepts it; credits are charged only for a suggestion really produced. */
const LOG_ID = '665f1f77bcf86cd799439011';

function setup(opts: { configured?: boolean; providerFails?: boolean; entityStore?: string } = {}) {
  const logs = new FakeModel();
  const calls = { applied: [] as any[], deducted: 0, granted: 0, provider: 0 };
  const db: any = { repositories: { seoAiSuggestionLogModel: logs } };
  const svc = new SeoAiService(
    db,
    { log: async () => undefined } as any,
    { assertFeatureAllowed: async () => undefined } as any,
    { deduct: async () => { calls.deducted += 1; }, grant: async () => { calls.granted += 1; } } as any,
    {
      getEntityContext: async () => ({ sellerId: 'sel1', storeId: opts.entityStore ?? 's1', name: 'Brand Kit', description: 'd', categoryName: null, storeName: 'Shop' }),
      applySeoSuggestion: async (...args: any[]) => { calls.applied.push(args); },
    } as any,
    {
      isConfigured: opts.configured !== false,
      generateSuggestion: async () => {
        calls.provider += 1;
        if (opts.providerFails) throw new Error('provider down');
        return { metaTitle: 'T', metaDescription: 'D', keywords: ['k'] };
      },
    } as any,
    { getSettings: async () => ({ aiSeoEnabled: true }) } as any,
    { add: async () => ({ id: 'j' }) } as any,
  );
  return { svc, logs, calls };
}
const actor = { id: 'u1', role: 'seller' };

describe('AI SEO suggestions', () => {
  it('generate is a preview: it charges the credits and returns the suggestion, but writes nothing on the product', async () => {
    const { svc, logs, calls } = setup();
    const out: any = await svc.generate('product', 'p1', 'sel1', actor);
    expect(out.metaTitle).toBe('T');
    expect(out.applied).toBe(false);
    expect(!!out.suggestionId).toBe(true);
    expect(calls.applied.length).toBe(0);
    expect(calls.deducted).toBe(1);
    expect(logs.rows[0].accepted).toBe(false);
    expect(logs.rows[0].creditsCost).toBe(AI_SEO_SUGGESTION_CREDIT_COST);
  });

  it('the bulk job asks to apply: it writes the suggestion straight away', async () => {
    const { svc, logs, calls } = setup();
    const out: any = await svc.generate('product', 'p1', 'sel1', actor, { apply: true });
    expect(out.applied).toBe(true);
    expect(calls.applied.length).toBe(1);
    expect(logs.rows[0].accepted).toBe(true);
  });

  it('a failing AI call gives the credits back and leaves no log', async () => {
    const { svc, logs, calls } = setup({ providerFails: true });
    await expect(svc.generate('product', 'p1', 'sel1', actor)).rejects.toThrow('provider down');
    expect(calls.deducted).toBe(1);
    expect(calls.granted).toBe(1);
    expect(logs.rows.length).toBe(0);
  });

  it('without an API key it refuses BEFORE touching the credits', async () => {
    const { svc, calls } = setup({ configured: false });
    await expect(svc.generate('product', 'p1', 'sel1', actor)).rejects.toThrow('not switched on yet');
    expect(calls.deducted).toBe(0);
    expect(calls.provider).toBe(0);
  });

  it('"use this" writes the previewed suggestion once; a second click changes nothing', async () => {
    const { svc, logs, calls } = setup();
    logs.rows.push({ _id: LOG_ID, storeId: 's1', sellerId: 'sel1', entityType: 'product', entityId: 'p1', suggestion: { metaTitle: 'T', metaDescription: 'D', keywords: ['k'] }, accepted: false });
    const first: any = await svc.accept('s1', LOG_ID, actor);
    expect(first.applied).toBe(true);
    expect(first.alreadyApplied).toBe(false);
    expect(calls.applied.length).toBe(1);
    const second: any = await svc.accept('s1', LOG_ID, actor);
    expect(second.alreadyApplied).toBe(true);
    expect(calls.applied.length).toBe(1);
  });

  it('another store cannot accept this suggestion, and an unknown id is not found', async () => {
    const { svc, logs, calls } = setup();
    logs.rows.push({ _id: LOG_ID, storeId: 's1', sellerId: 'sel1', entityType: 'product', entityId: 'p1', suggestion: { metaTitle: 'T', metaDescription: 'D', keywords: [] }, accepted: false });
    await expect(svc.accept('s2', LOG_ID, actor)).rejects.toThrow('Suggestion not found');
    await expect(svc.accept('s1', 'not-an-id', actor)).rejects.toThrow('Suggestion not found');
    expect(calls.applied.length).toBe(0);
  });

  it('a product that no longer belongs to the store is refused and the suggestion stays open', async () => {
    const { svc, logs, calls } = setup({ entityStore: 'other-store' });
    logs.rows.push({ _id: LOG_ID, storeId: 's1', sellerId: 'sel1', entityType: 'product', entityId: 'p1', suggestion: { metaTitle: 'T', metaDescription: 'D', keywords: [] }, accepted: false });
    await expect(svc.accept('s1', LOG_ID, actor)).rejects.toThrow('does not belong');
    expect(calls.applied.length).toBe(0);
    expect(logs.rows[0].accepted).toBe(false);
  });
});
