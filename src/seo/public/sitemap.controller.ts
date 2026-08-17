/* eslint-disable prettier/prettier */
import { Controller, Get, Param, Res, NotFoundException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { SeoSitemapService } from '../services/seo-sitemap.service';
import { SITEMAP_TYPES, SitemapType } from '../schemas/seo-sitemap-cache.schema';

// Bare paths (no `api/` prefix) — crawlers expect literal `/sitemap.xml`.
// Exempt from the global throttle: this is exactly the kind of caller
// (Googlebot/Bingbot fetching every chunk in quick succession) the default
// 100-req/min-per-IP limit would otherwise wrongly block.
@Controller()
export class SitemapController {
  constructor(private readonly sitemapService: SeoSitemapService) {}

  @SkipThrottle()
  @Get('sitemap.xml')
  async getIndex(@Res() res: Response) {
    const xml = await this.sitemapService.getSitemapIndexXml();
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.send(xml);
  }

  // Matches /sitemap-products-3.xml, /sitemap-products-<storeId>-0.xml, /sitemap-categories-0.xml, etc.
  @SkipThrottle()
  @Get('sitemap-:suffix.xml')
  async getChunk(@Param('suffix') suffix: string, @Res() res: Response) {
    const parts = suffix.split('-');
    const chunkIndex = Number(parts[parts.length - 1]);
    const type = parts[0] as SitemapType;
    const storeId = parts.length === 3 ? parts[1] : null;

    if (!SITEMAP_TYPES.includes(type) || Number.isNaN(chunkIndex)) {
      throw new NotFoundException('Unknown sitemap file.');
    }

    const xml = await this.sitemapService.getChunkXml(type, storeId, chunkIndex);
    if (!xml) throw new NotFoundException('Sitemap chunk not found — it may not have been generated yet.');

    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.send(xml);
  }
}
