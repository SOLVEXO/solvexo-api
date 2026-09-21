/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';
import { APP_CATALOG, findApp, findAppBlockDefinition, validateAppBlockSettings } from './app-catalog';
import { buildAppBlockType, isAppBlockType, parseAppBlockType, sectionAcceptsAppBlocks } from '../common/store-content/app-block.util';

describe('app-catalog (Phase 8)', () => {
  const ratingBadgeType = buildAppBlockType('trust-signals', 'rating_badge');

  it('builds and parses the namespaced block type consistently', () => {
    expect(ratingBadgeType).toBe('app:trust-signals:rating_badge');
    expect(isAppBlockType(ratingBadgeType)).toBe(true);
    expect(isAppBlockType('heading')).toBe(false);
    expect(parseAppBlockType(ratingBadgeType)).toEqual({ appId: 'trust-signals', blockKey: 'rating_badge' });
    expect(parseAppBlockType('app:no-colon')).toBeNull();
  });

  it('only allows app blocks inside the explicitly capable section types', () => {
    expect(sectionAcceptsAppBlocks('rich_text' as any)).toBe(true);
    expect(sectionAcceptsAppBlocks('hero' as any)).toBe(false);
  });

  it('resolves a real block type back to its app + block definition', () => {
    const found = findAppBlockDefinition(ratingBadgeType);
    expect(found?.app.id).toBe('trust-signals');
    expect(found?.block.key).toBe('rating_badge');
    expect(findAppBlockDefinition('app:unknown:thing')).toBeNull();
  });

  it('finds a real app by id', () => {
    expect(findApp('trust-signals')?.name).toContain('Trust Signals');
    expect(findApp('does-not-exist')).toBeUndefined();
  });

  describe('validateAppBlockSettings', () => {
    const def = APP_CATALOG[0].blocks[0]; // rating_badge: text(required,maxLength60), showStars(boolean)

    it('accepts valid settings', () => {
      expect(() => validateAppBlockSettings(def, { text: 'Loved by 500+ customers', showStars: true })).not.toThrow();
    });

    it('rejects a missing required field', () => {
      expect(() => validateAppBlockSettings(def, { showStars: true })).toThrow(BadRequestException);
    });

    it('rejects a value over maxLength', () => {
      expect(() => validateAppBlockSettings(def, { text: 'x'.repeat(61) })).toThrow(BadRequestException);
    });

    it('rejects a non-boolean for a boolean field', () => {
      expect(() => validateAppBlockSettings(def, { text: 'ok', showStars: 'yes' as any })).toThrow(BadRequestException);
    });
  });
});
