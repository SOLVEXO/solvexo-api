import { Injectable, BadRequestException } from '@nestjs/common';
import { DatabaseService } from '@/database/databaseservice';
import { MarketsService } from './markets.service';

@Injectable()
export class MarketDomainService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly marketsService: MarketsService,
  ) {}

  private get marketModel() {
    return this.databaseService.repositories.marketModel;
  }

  /**
   * Resolve a market from a domain or subfolder.
   * Used by frontend routing to determine which market to show.
   *
   * @param storeId - Store ID
   * @param hostname - Request hostname (e.g., eu.mystore.com, mystore.com)
   * @param subfolder - URL subfolder (e.g., 'en-ca' from /en-ca/products)
   * @returns The matching market or null
   */
  async resolveMarketFromUrl(
    storeId: string,
    hostname: string,
    subfolder?: string | null,
  ): Promise<{ market: any; resolvedBy: 'domain' | 'subfolder' | 'primary' } | null> {
    // First, try to match by custom domain
    const marketByDomain = await this.marketModel.findOne({
      storeId,
      domainType: { $in: ['subdomain', 'primary'] },
      domain: hostname,
      isActive: true,
      isDelete: false,
    }).lean();

    if (marketByDomain) {
      return { market: marketByDomain, resolvedBy: 'domain' };
    }

    // Next, try to match by subfolder
    if (subfolder) {
      const marketBySubfolder = await this.marketModel.findOne({
        storeId,
        domainType: 'subfolder',
        subfolder: subfolder.toLowerCase(),
        isActive: true,
        isDelete: false,
      }).lean();

      if (marketBySubfolder) {
        return { market: marketBySubfolder, resolvedBy: 'subfolder' };
      }
    }

    // Fallback to primary market
    const primaryMarket = await this.marketsService.getPrimaryMarket(storeId);
    if (primaryMarket) {
      return { market: primaryMarket, resolvedBy: 'primary' };
    }

    return null;
  }

  /**
   * Validate that a domain is not already used by another market.
   */
  async validateDomainAvailability(storeId: string, domain: string, excludeMarketId?: string): Promise<boolean> {
    const query: any = {
      storeId,
      domain,
      domainType: { $in: ['subdomain', 'primary'] },
      isDelete: false,
    };

    if (excludeMarketId) {
      query._id = { $ne: excludeMarketId };
    }

    const existing = await this.marketModel.findOne(query);
    return !existing;
  }

  /**
   * Validate that a subfolder is not already used by another market.
   */
  async validateSubfolderAvailability(storeId: string, subfolder: string, excludeMarketId?: string): Promise<boolean> {
    const query: any = {
      storeId,
      subfolder: subfolder.toLowerCase(),
      domainType: 'subfolder',
      isDelete: false,
    };

    if (excludeMarketId) {
      query._id = { $ne: excludeMarketId };
    }

    const existing = await this.marketModel.findOne(query);
    return !existing;
  }

  /**
   * Validate domain format.
   * - Must be a valid domain name
   * - Cannot contain protocol (http://)
   * - Cannot contain path
   */
  validateDomainFormat(domain: string): void {
    if (!domain) {
      throw new BadRequestException('Domain is required');
    }

    // Remove protocol if present
    const cleanDomain = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '');

    // Basic domain validation
    const domainRegex = /^[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9]*\.[a-zA-Z]{2,}$/;
    if (!domainRegex.test(cleanDomain)) {
      throw new BadRequestException('Invalid domain format');
    }

    // Check for protocol or path in original
    if (domain.includes('/') || domain.includes(':')) {
      throw new BadRequestException('Domain should not include protocol or path');
    }
  }

  /**
   * Validate subfolder format.
   * - Must be lowercase alphanumeric with hyphens
   * - Cannot start or end with hyphen
   * - Must be 2-50 characters
   */
  validateSubfolderFormat(subfolder: string): void {
    if (!subfolder) {
      throw new BadRequestException('Subfolder is required');
    }

    const subfolderRegex = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
    if (!subfolderRegex.test(subfolder)) {
      throw new BadRequestException('Subfolder must be lowercase alphanumeric with hyphens, cannot start or end with hyphen');
    }

    if (subfolder.length < 2 || subfolder.length > 50) {
      throw new BadRequestException('Subfolder must be 2-50 characters');
    }
  }

  /**
   * Generate a default subfolder for a market based on language/country.
   * e.g., 'en-ca' for English Canada, 'fr' for France
   */
  generateDefaultSubfolder(market: { languages: string[]; countries: string[] }): string {
    const language = market.languages[0] || 'en';
    const country = market.countries[0];

    if (country) {
      return `${language}-${country.toLowerCase()}`;
    }

    return language;
  }

  /**
   * Get all active markets with their domain/subfolder configuration.
   */
  async getActiveMarketsWithDomains(storeId: string): Promise<any[]> {
    return this.marketModel
      .find({
        storeId,
        isActive: true,
        isDelete: false,
      })
      .select('name domainType domain subfolder currency countries languages')
      .lean();
  }
}
