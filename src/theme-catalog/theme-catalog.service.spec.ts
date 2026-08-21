/* eslint-disable prettier/prettier */
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ThemeCatalogService } from './theme-catalog.service';
import { DatabaseService } from '../database/databaseservice';

describe('ThemeCatalogService', () => {
  let service: ThemeCatalogService;
  let themeDefinitionModel: any;
  let db: DatabaseService;

  const validHomeSections = [
    { type: 'hero', settings: {}, blocks: [{ type: 'hero_slide', settings: { imageUrl: 'https://cdn.example.com/hero.jpg', heading: 'Hi' } }] },
  ];

  beforeEach(() => {
    themeDefinitionModel = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({ sort: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }) }),
        sort: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }),
      }),
      create: jest.fn().mockImplementation((doc: any) => Promise.resolve(doc)),
      findById: jest.fn().mockResolvedValue(null),
      findByIdAndUpdate: jest.fn(),
      findOneAndUpdate: jest.fn(),
      updateOne: jest.fn().mockResolvedValue({}),
    };
    db = { repositories: { themeDefinitionModel } } as any;
    service = new ThemeCatalogService(db);
  });

  describe('create', () => {
    it('rejects a duplicate slug', async () => {
      themeDefinitionModel.findOne.mockResolvedValue({ slug: 'vogue' });
      await expect(service.create({ slug: 'vogue', name: 'Vogue', category: 'fashion' } as any)).rejects.toThrow(ConflictException);
      expect(themeDefinitionModel.create).not.toHaveBeenCalled();
    });

    it('rejects invalid homePageSections before ever touching the database', async () => {
      const badSections = [{ type: 'hero', settings: {}, blocks: [{ type: 'hero_slide', settings: {} }] }]; // missing required imageUrl
      await expect(
        service.create({ slug: 'x', name: 'X', category: 'general', homePageSections: badSections } as any),
      ).rejects.toThrow(BadRequestException);
      expect(themeDefinitionModel.findOne).not.toHaveBeenCalled();
    });

    it('rejects a block type that is not allowed inside its section (e.g. a testimonial block inside a hero)', async () => {
      const wrongBlock = [{ type: 'hero', settings: {}, blocks: [{ type: 'testimonial', settings: { quote: 'x', authorName: 'y' } }] }];
      await expect(
        service.create({ slug: 'x', name: 'X', category: 'general', homePageSections: wrongBlock } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a footer with more blocks than the seller-facing limit allows', async () => {
      const tooManyFooterBlocks = Array.from({ length: 21 }, () => ({ type: 'social_link', settings: { platform: 'facebook', url: 'https://facebook.com/x' } }));
      await expect(
        service.create({
          slug: 'x', name: 'X', category: 'general',
          footer: { blocks: tooManyFooterBlocks, footerStyle: 'columns' },
        } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('creates a theme with genuinely valid content', async () => {
      const dto = { slug: 'vogue', name: 'Vogue', category: 'fashion', homePageSections: validHomeSections } as any;
      const created = await service.create(dto);
      expect(created.data).toEqual(dto);
      expect(themeDefinitionModel.create).toHaveBeenCalledWith(dto);
    });
  });

  describe('update', () => {
    it('404s on an unknown id', async () => {
      themeDefinitionModel.findById.mockResolvedValue(null);
      await expect(service.update('missing', { name: 'X' } as any)).rejects.toThrow(NotFoundException);
    });

    it('rejects renaming to a slug already used by a different theme', async () => {
      themeDefinitionModel.findById.mockResolvedValue({ _id: 'a', slug: 'vogue', version: 1, save: jest.fn() });
      themeDefinitionModel.findOne.mockResolvedValue({ _id: 'b', slug: 'urban' });
      await expect(service.update('a', { slug: 'urban' } as any)).rejects.toThrow(ConflictException);
    });

    it('bumps the version and persists on a valid edit', async () => {
      const theme = { _id: 'a', slug: 'vogue', version: 1, save: jest.fn() };
      themeDefinitionModel.findById.mockResolvedValue(theme);
      await service.update('a', { description: 'Updated copy' } as any);
      expect(theme.version).toBe(2);
      expect(theme.save).toHaveBeenCalled();
    });
  });

  describe('setStatus / setFeatured', () => {
    it('404s setStatus on an unknown id', async () => {
      themeDefinitionModel.findByIdAndUpdate.mockResolvedValue(null);
      await expect(service.setStatus('missing', 'published')).rejects.toThrow(NotFoundException);
    });

    it('404s setFeatured on an unknown id', async () => {
      themeDefinitionModel.findByIdAndUpdate.mockResolvedValue(null);
      await expect(service.setFeatured('missing', true)).rejects.toThrow(NotFoundException);
    });
  });

  describe('publicList', () => {
    it('always filters to published themes, even when the caller asks for a different status implicitly', async () => {
      const findSpy = themeDefinitionModel.find;
      await service.publicList({ category: 'fashion' } as any);
      expect(findSpy).toHaveBeenCalledWith(expect.objectContaining({ status: 'published', category: 'fashion' }));
    });
  });

  describe('publicGetBySlug', () => {
    it('404s a draft/archived theme — public reads never see unpublished catalog content', async () => {
      themeDefinitionModel.findOneAndUpdate.mockResolvedValue(null);
      await expect(service.publicGetBySlug('unpublished-theme')).rejects.toThrow(NotFoundException);
      expect(themeDefinitionModel.findOneAndUpdate).toHaveBeenCalledWith(
        { slug: 'unpublished-theme', status: 'published' },
        { $inc: { viewCount: 1 } },
        { new: true },
      );
    });

    it('increments viewCount as a side effect of a successful public read', async () => {
      themeDefinitionModel.findOneAndUpdate.mockResolvedValue({ slug: 'vogue', status: 'published', viewCount: 5 });
      const res = await service.publicGetBySlug('vogue');
      expect(res.data.viewCount).toBe(5);
    });
  });

  describe('getPublishedForApply', () => {
    it('refuses to hand back a draft/archived theme for a seller to apply', async () => {
      themeDefinitionModel.findOne.mockResolvedValue(null); // filter includes status: 'published'
      await expect(service.getPublishedForApply('draft-theme-id')).rejects.toThrow(NotFoundException);
      expect(themeDefinitionModel.findOne).toHaveBeenCalledWith({ _id: 'draft-theme-id', status: 'published' });
    });
  });
});
