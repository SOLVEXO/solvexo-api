/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { SearchConfig, SearchConfigDocument, SearchMiss, SearchMissDocument } from './search-discovery.schema';
import { cleanFilters, cleanPinned, cleanSynonymGroups, defaultFilters, expandQuery, norm, pinnedFor, reportableQuery, termsRegexSource } from './search-discovery.util';

const CACHE_MS = 30_000;

@Injectable()
export class SearchDiscoveryService {
  private cache = new Map<string, { at: number; cfg: any }>();
  constructor(
    @InjectModel(SearchConfig.name) private readonly cfgModel: Model<SearchConfigDocument>,
    @InjectModel(SearchMiss.name) private readonly missModel: Model<SearchMissDocument>,
    private readonly db: DatabaseService,
  ) {}

  private async load(storeId: string) {
    const hit = this.cache.get(storeId);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.cfg;
    const cfg = (await this.cfgModel.findOne({ storeId }).lean()) ?? { synonyms: [], pinned: [], filters: defaultFilters() };
    if (this.cache.size > 2000) this.cache.clear();
    this.cache.set(storeId, { at: Date.now(), cfg });
    return cfg;
  }

  /** The terms to search for (typed query first). Never throws: search must work without this feature. */
  async terms(storeId: string, query: string): Promise<string[]> {
    try { return expandQuery((await this.load(storeId)).synonyms, query); } catch { const q = norm(query); return q ? [q] : []; }
  }
  /** Regex source for the expanded terms, or null = no expansion (use the plain behaviour). */
  async regexSource(storeId: string, query: string): Promise<string | null> {
    const t = await this.terms(storeId, query);
    return t.length > 1 ? termsRegexSource(t) : null;
  }
  async pinned(storeId: string, query: string): Promise<string[]> {
    try { return pinnedFor((await this.load(storeId)).pinned, await this.terms(storeId, query)); } catch { return []; }
  }

  async recordMiss(storeId: string, query: string): Promise<void> {
    const q = reportableQuery(query); if (!q) return;
    try { await this.missModel.updateOne({ storeId, query: q }, { $inc: { count: 1 }, $set: { lastAt: new Date() }, $setOnInsert: { storeId, query: q } }, { upsert: true }); } catch { /* a report must never break a search */ }
  }

  async getConfig(storeId: string) { this.cache.delete(storeId); const c: any = await this.load(storeId); return { synonyms: c.synonyms ?? [], pinned: c.pinned ?? [], filters: c.filters?.length ? c.filters : defaultFilters() }; }

  async save(storeId: string, body: any) {
    const set: any = {};
    try {
      if (body?.synonyms !== undefined) set.synonyms = cleanSynonymGroups(body.synonyms);
      if (body?.pinned !== undefined) {
        const pinned = cleanPinned(body.pinned);
        const ids = [...new Set(pinned.flatMap((p) => p.productIds))];
        const own = ids.length ? await (this.db.repositories as any).productModel.find({ _id: { $in: ids }, storeId, isDelete: false }).select('_id').lean() : [];
        const ok = new Set(own.map((o: any) => String(o._id)));
        set.pinned = pinned.map((p) => ({ query: p.query, productIds: p.productIds.filter((i) => ok.has(i)) })).filter((p) => p.productIds.length);
      }
      if (body?.filters !== undefined) set.filters = cleanFilters(body.filters);
    } catch (e: any) { throw new BadRequestException(e.message); }
    await this.cfgModel.updateOne({ storeId }, { $set: set, $setOnInsert: { storeId } }, { upsert: true });
    return this.getConfig(storeId);
  }

  /** What shoppers searched for and found nothing, most frequent first. */
  async noResults(storeId: string, q: { page?: any; limit?: any }) {
    const page = Math.max(1, Number(q.page) || 1); const limit = Math.min(50, Math.max(1, Number(q.limit) || 20));
    const [items, total] = await Promise.all([this.missModel.find({ storeId }).sort({ count: -1, lastAt: -1 }).skip((page - 1) * limit).limit(limit).lean(), this.missModel.countDocuments({ storeId })]);
    return { items, total, page, limit };
  }
  async clearMiss(storeId: string, query: string) { await this.missModel.deleteOne({ storeId, query: norm(query) }); return { success: true }; }

  /** Public view: only the filter settings. */
  async publicFilters(storeId: string) { const c: any = await this.load(storeId); return { filters: c.filters?.length ? c.filters : defaultFilters() }; }
}
