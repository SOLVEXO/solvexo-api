/* eslint-disable prettier/prettier */
import { ContentVersioningService } from './content-versioning.service';

describe('ContentVersioningService', () => {
  let service: ContentVersioningService;
  let model: any;

  beforeEach(() => {
    model = {
      findOneAndUpdate: jest.fn().mockResolvedValue({ _id: 'doc-1' }),
      updateMany: jest.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 }),
    };
    service = new ContentVersioningService();
  });

  describe('publishDraft', () => {
    it('runs a single aggregation-pipeline findOneAndUpdate with { new: true } — never a two-step read-then-write', async () => {
      await service.publishDraft(model, { storeId: 's1' }, { sections: '$draft.sections' }, { status: 'published' });

      expect(model.findOneAndUpdate).toHaveBeenCalledTimes(1);
      const [filter, pipeline, options] = model.findOneAndUpdate.mock.calls[0];
      expect(filter).toEqual({ storeId: 's1' });
      // The update MUST be an aggregation pipeline (an array), not a plain
      // `{ $set: ... }` object — that's what makes the read of `$draft.*`
      // and the write of the live fields atomic in the same operation.
      expect(Array.isArray(pipeline)).toBe(true);
      expect(pipeline).toEqual([{ $set: { sections: '$draft.sections', status: 'published' } }]);
      expect(options).toEqual({ new: true });
    });

    it('merges fieldMap and extraSet into one $set stage, with extraSet keys present alongside the copied fields', async () => {
      await service.publishDraft(
        model,
        { _id: 'page-1' },
        { sections: '$draft.sections' },
        { status: 'published', lastPublishedAt: '$$NOW' },
      );
      const [, pipeline] = model.findOneAndUpdate.mock.calls[0];
      expect(pipeline[0].$set).toEqual({
        sections: '$draft.sections',
        status: 'published',
        lastPublishedAt: '$$NOW',
      });
    });

    it('returns whatever the model resolves (the post-update document)', async () => {
      const result = await service.publishDraft(model, {}, {});
      expect(result).toEqual({ _id: 'doc-1' });
    });
  });

  describe('revertDraft', () => {
    it('supports a nested-object expression value (e.g. rewriting a whole `draft` subdocument in one field), not just flat string references', async () => {
      await service.revertDraft(model, { storeId: 's1' }, {
        draft: { theme: '$theme', header: '$header' },
      });
      const [filter, pipeline, options] = model.findOneAndUpdate.mock.calls[0];
      expect(filter).toEqual({ storeId: 's1' });
      expect(pipeline).toEqual([{ $set: { draft: { theme: '$theme', header: '$header' } } }]);
      expect(options).toEqual({ new: true });
    });

    it('supports a flat dot-path field (the StorePage shape)', async () => {
      await service.revertDraft(model, { _id: 'page-1' }, { 'draft.sections': '$sections' });
      const [, pipeline] = model.findOneAndUpdate.mock.calls[0];
      expect(pipeline).toEqual([{ $set: { 'draft.sections': '$sections' } }]);
    });
  });

  describe('backfillDraft', () => {
    it('scopes the update with a raw draftPath $exists:false filter — never overwrites a draft that already exists', async () => {
      await service.backfillDraft(model, { storeId: 's1' }, 'draft', { sections: '$sections' });

      expect(model.updateMany).toHaveBeenCalledTimes(1);
      const [filter, pipeline] = model.updateMany.mock.calls[0];
      expect(filter).toEqual({ storeId: 's1', draft: { $exists: false } });
      expect(pipeline).toEqual([{ $set: { draft: { sections: '$sections' } } }]);
    });

    it('merges the caller filter with the $exists guard rather than replacing it', async () => {
      await service.backfillDraft(model, { _id: 'page-1', storeId: 's1' }, 'draft', { sections: '$sections' });
      const [filter] = model.updateMany.mock.calls[0];
      expect(filter).toEqual({ _id: 'page-1', storeId: 's1', draft: { $exists: false } });
    });
  });
});
