/* eslint-disable prettier/prettier */
import { Injectable, ConflictException, NotFoundException, BadRequestException } from '@nestjs/common';
import { DatabaseService } from '@/database/databaseservice';
import { ActivityLogService } from '@/activity-log/activity-log.service';
import { CreateRedirectDto } from '../dto/create-redirect.dto';
import { UpdateRedirectDto } from '../dto/update-redirect.dto';
import { assertSafeSeoDestination, storeSeoHosts } from './seo-url-safety.util';

/**
 * Shared between the admin (`storeId: null`, platform-wide) and seller
 * (`storeId` set, gated by `customRedirectsAllowed`) redirect controllers —
 * one collection, one service, matching how `analytics/utils/*` is shared
 * between seller and admin analytics elsewhere in this codebase.
 */
@Injectable()
export class SeoRedirectsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly activityLog: ActivityLogService,
  ) {}

  private get model() {
    return this.db.repositories.seoRedirectModel;
  }

  async create(storeId: string | null, dto: CreateRedirectDto, actor: { id: string; name?: string; role?: string }) {
    assertSafeSeoDestination(dto.destination, await storeSeoHosts(this.db, storeId));
    const source = normalizeSource(dto.source);
    const sourceKey = redirectKey(source);

    const existing = await this.model.findOne({ storeId, isDelete: false, $or: [{ sourceKey }, { source }] });
    if (existing) throw new ConflictException(`A redirect for "${source}" already exists${storeId ? ' for this store' : ' at the platform level'}.`);
    if (dto.isActive ?? true) await this.assertNoLoop(storeId, sourceKey, dto.destination, null);

    const redirect = await this.model.create({
      storeId,
      source,
      sourceKey,
      destination: dto.destination,
      statusCode: dto.statusCode ?? 301,
      isActive: dto.isActive ?? true,
    });

    await this.activityLog.log({
      storeId: storeId ?? undefined,
      category: 'seo',
      action: 'seo_redirect_created',
      description: `Redirect created: ${source} → ${dto.destination}`,
      actorId: actor.id,
      actorName: actor.name ?? null,
      actorRole: actor.role ?? null,
      targetId: redirect._id.toString(),
      targetType: 'seo_redirect',
    });

    return redirect;
  }

  async list(storeId: string | null, query: { page?: number; limit?: number; isActive?: boolean }) {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
    const filter: Record<string, any> = { storeId, isDelete: false };
    if (query.isActive !== undefined) filter.isActive = query.isActive;

    const [items, total] = await Promise.all([
      this.model.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      this.model.countDocuments(filter),
    ]);

    return { items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  }

  async update(storeId: string | null, redirectId: string, dto: UpdateRedirectDto, actor: { id: string; name?: string; role?: string }) {
    const redirect = await this.findOwned(storeId, redirectId);
    if (dto.destination) assertSafeSeoDestination(dto.destination, await storeSeoHosts(this.db, storeId));
    if (dto.source) dto.source = normalizeSource(dto.source);

    const nextSource = dto.source ?? (redirect as any).source;
    const nextDestination = dto.destination ?? (redirect as any).destination;
    const nextActive = dto.isActive ?? (redirect as any).isActive;
    if (nextActive) await this.assertNoLoop(storeId, redirectKey(nextSource), nextDestination, redirectId);

    Object.assign(redirect, dto);
    if (dto.source) (redirect as any).sourceKey = redirectKey(dto.source);
    await redirect.save();

    await this.activityLog.log({
      storeId: storeId ?? undefined,
      category: 'seo',
      action: 'seo_redirect_updated',
      actorId: actor.id,
      actorName: actor.name ?? null,
      actorRole: actor.role ?? null,
      targetId: redirectId,
      targetType: 'seo_redirect',
    });

    return redirect;
  }

  async delete(storeId: string | null, redirectId: string, actor: { id: string; name?: string; role?: string }) {
    const redirect = await this.findOwned(storeId, redirectId);
    redirect.isDelete = true;
    redirect.isActive = false;
    await redirect.save();

    await this.activityLog.log({
      storeId: storeId ?? undefined,
      category: 'seo',
      action: 'seo_redirect_deleted',
      actorId: actor.id,
      actorName: actor.name ?? null,
      actorRole: actor.role ?? null,
      targetId: redirectId,
      targetType: 'seo_redirect',
    });

    return { success: true };
  }

  /**
   * The redirect for a requested path, or null. The path is compared the way a visitor would expect: the query string and #hash
   * are ignored, a trailing slash does not matter, and upper/lower case does not matter. A rule whose destination is the very
   * page requested is never returned (it would send the visitor in circles).
   */
  async resolve(storeId: string | null, path: string) {
    const key = redirectKey(path);
    const redirect: any = await this.model.findOne({
      storeId, isActive: true, isDelete: false,
      $or: [{ sourceKey: key }, { source: { $in: [key, `${key}/`] } }],
    }).lean();
    if (redirect && isRelative(redirect.destination) && redirectKey(redirect.destination) === key) return null;
    if (redirect) {
      // Fire-and-forget hit counter — not awaited, must never slow down the actual redirect.
      this.model.updateOne({ _id: (redirect as any)._id }, { $inc: { hitCount: 1 }, $set: { lastHitAt: new Date() } }).catch(() => {});
    }
    return redirect;
  }

  /**
   * Refuses a rule that would send visitors in circles: the destination leads back to the source, directly (/a -> /a), or through
   * other active redirects of the same store (/a -> /b -> /c -> /a), or the chain is longer than MAX_REDIRECT_CHAIN. Only paths of
   * the store itself can loop; a destination on another address ends the chain. `ignoreId` = the redirect being edited.
   */
  private async assertNoLoop(storeId: string | null, sourceKey: string, destination: string, ignoreId: string | null) {
    if (!isRelative(destination)) return;
    const rows: any[] = await this.model.find({ storeId, isActive: true, isDelete: false }).select('source sourceKey destination').limit(5000).lean();
    const next = new Map<string, string>();
    for (const r of rows) {
      if (ignoreId && String(r._id) === ignoreId) continue;
      if (isRelative(r.destination)) next.set(r.sourceKey ?? redirectKey(r.source), redirectKey(r.destination));
    }
    const path: string[] = [sourceKey];
    let current = redirectKey(destination);
    let hops = 1; // source -> destination is the first hop
    for (;;) {
      if (current === sourceKey) {
        throw new BadRequestException(`This redirect would send visitors in circles: ${[...path, current].join(' → ')}. Change the destination.`);
      }
      const following = next.get(current);
      if (!following) return;
      hops++;
      if (hops > MAX_REDIRECT_CHAIN) {
        throw new BadRequestException(`This redirect would start a chain of more than ${MAX_REDIRECT_CHAIN} redirects. Point it straight at the final page instead.`);
      }
      path.push(current);
      current = following;
    }
  }

  private async findOwned(storeId: string | null, redirectId: string) {
    const redirect = await this.model.findOne({ _id: redirectId, storeId, isDelete: false });
    if (!redirect) throw new NotFoundException('Redirect not found.');
    return redirect;
  }
}

function normalizeSource(source: string): string {
  // The stored source is a clean path: no spaces around it, no query string or #hash (those can never be part of a path match).
  const trimmed = source.trim().replace(/[?#].*$/, '');
  const withSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withSlash.length > 1 ? withSlash.replace(/\/+$/, '') || '/' : withSlash;
}

const isRelative = (v: string) => typeof v === 'string' && v.startsWith('/') && !v.startsWith('//');

/**
 * The form two paths are compared in: query and #hash dropped, %-escapes decoded, doubled slashes collapsed, no trailing slash,
 * lower case. A full https:// address is reduced to its path. "/Shop/Old-Page/?ref=x" and "/shop/old-page" give the same key.
 */
export function redirectKey(input: string): string {
  let value = String(input ?? '').trim();
  if (/^https?:\/\//i.test(value)) {
    try { value = new URL(value).pathname; } catch { /* keep as is */ }
  }
  value = value.replace(/[?#].*$/, '');
  try { value = decodeURIComponent(value); } catch { /* keep the raw text */ }
  if (!value.startsWith('/')) value = `/${value}`;
  value = value.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  return (value || '/').toLowerCase();
}

/** How many redirects one visitor may be sent through before it counts as a chain that is too long. */
export const MAX_REDIRECT_CHAIN = 10;
