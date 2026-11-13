import { SellerTrustService } from './seller-trust.service';

/**
 * Mongoose 9 refuses an aggregation-pipeline update unless `updatePipeline: true` is passed
 * ("Cannot pass an array to query updates…"), which made "Start enforcement" fail with a 500.
 */
describe('SellerTrustService.syncDeadlines', () => {
  function build(settings: { enforcementStartedAt: Date | null; graceDays: number }) {
    const storeModel = { updateMany: jest.fn().mockResolvedValue({ modifiedCount: 0 }) };
    const db = { repositories: { storeModel } } as any;
    const adminConfig = { getSellerTrustSettings: jest.fn().mockResolvedValue(settings) } as any;
    const service = new SellerTrustService(db, adminConfig);
    return { service, storeModel };
  }

  it('passes updatePipeline for the pipeline update that stamps new stores with their own createdAt', async () => {
    const start = new Date('2026-11-12T00:00:00Z');
    const { service, storeModel } = build({ enforcementStartedAt: start, graceDays: 30 });
    await service.syncDeadlines(new Date('2026-11-12T01:00:00Z'));
    const pipelineCalls = storeModel.updateMany.mock.calls.filter(([, update]) => Array.isArray(update));
    expect(pipelineCalls).toHaveLength(1);
    expect(pipelineCalls[0][2]).toMatchObject({ updatePipeline: true });
    // Existing stores get the grace deadline.
    expect(storeModel.updateMany).toHaveBeenCalledWith(
      { isDelete: false, createdAt: { $lt: start } },
      { $set: { verificationDueAt: new Date('2026-12-12T00:00:00Z') } },
    );
  });

  it('every update it sends is one Mongoose 9 accepts', async () => {
    const { service, storeModel } = build({ enforcementStartedAt: new Date('2026-11-12T00:00:00Z'), graceDays: 30 });
    await service.syncDeadlines(new Date('2026-11-12T01:00:00Z'));
    for (const [, update, opts] of storeModel.updateMany.mock.calls) {
      if (Array.isArray(update)) expect(opts?.updatePipeline).toBe(true);
    }
  });
});
