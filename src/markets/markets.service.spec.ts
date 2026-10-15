// @ts-nocheck -- jest mock typings only (mongoose Document mocks); the assertions below are real.
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { MarketsService } from './markets.service';
import { DatabaseService } from '@/database/databaseservice';
import { AdminConfigService } from '@/admin-config/admin-config.service';
import { Market, MarketDocument } from './schemas/market.schema';
import { CreateMarketDto } from './dto/create-market.dto';
import { UpdateMarketDto } from './dto/update-market.dto';

describe('MarketsService', () => {
  let service: MarketsService;
  let databaseService: DatabaseService;
  let adminConfigService: AdminConfigService;

  const mockStore = {
    _id: 'store123',
    name: 'Test Store',
    baseCurrency: 'USD',
  };

  const mockMarket: Partial<Market> = {
    _id: 'market123',
    storeId: 'store123',
    name: 'United States',
    countries: ['US'],
    currency: 'USD',
    languages: ['en'],
    domainType: 'primary',
    isActive: true,
    isPrimary: true,
    isDelete: false,
  };

  const mockEnabledCurrencies = [
    { code: 'USD', sanityBandMin: null, sanityBandMax: null, stripeCardPaymentSupported: true },
    { code: 'EUR', sanityBandMin: 0.8, sanityBandMax: 1.2, stripeCardPaymentSupported: true },
    { code: 'PKR', sanityBandMin: 150, sanityBandMax: 450, stripeCardPaymentSupported: true },
  ];

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MarketsService,
        {
          provide: DatabaseService,
          useValue: {
            repositories: {
              storeModel: {
                findById: jest.fn(),
              },
              marketModel: {
                create: jest.fn(),
                find: jest.fn(),
                findOne: jest.fn(),
                findOneAndUpdate: jest.fn(),
                updateMany: jest.fn(),
                updateOne: jest.fn(),
              },
            },
          },
        },
        {
          provide: AdminConfigService,
          useValue: {
            getEnabledCurrencies: jest.fn().mockResolvedValue(mockEnabledCurrencies),
          },
        },
      ],
    }).compile();

    service = module.get<MarketsService>(MarketsService);
    databaseService = module.get<DatabaseService>(DatabaseService);
    adminConfigService = module.get<AdminConfigService>(AdminConfigService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('create', () => {
    it('should create a market successfully', async () => {
      const dto: CreateMarketDto = {
        name: 'United States',
        countries: ['US'],
        currency: 'USD',
        languages: ['en'],
        isPrimary: true,
      };

      jest.spyOn(databaseService.repositories.storeModel, 'findById').mockResolvedValue(mockStore);
      jest.spyOn(databaseService.repositories.marketModel, 'updateMany').mockResolvedValue({} as any);
      jest.spyOn(databaseService.repositories.marketModel, 'create').mockResolvedValue(mockMarket as MarketDocument);

      const result = await service.create('store123', dto);

      expect(result).toEqual(mockMarket);
      expect(databaseService.repositories.storeModel.findById).toHaveBeenCalledWith('store123');
      expect(databaseService.repositories.marketModel.create).toHaveBeenCalled();
    });

    it('should throw NotFoundException if store does not exist', async () => {
      const dto: CreateMarketDto = {
        name: 'United States',
        countries: ['US'],
        currency: 'USD',
      };

      jest.spyOn(databaseService.repositories.storeModel, 'findById').mockResolvedValue(null);

      await expect(service.create('store123', dto)).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException if currency is not enabled', async () => {
      const dto: CreateMarketDto = {
        name: 'United States',
        countries: ['US'],
        currency: 'XXX', // Invalid currency
      };

      jest.spyOn(databaseService.repositories.storeModel, 'findById').mockResolvedValue(mockStore);
      jest.spyOn(adminConfigService, 'getEnabledCurrencies').mockResolvedValue(mockEnabledCurrencies);

      await expect(service.create('store123', dto)).rejects.toThrow(BadRequestException);
      await expect(service.create('store123', dto)).rejects.toThrow('Currency XXX is not enabled on this platform');
    });

    it('should set isPrimary to false for other markets when creating primary market', async () => {
      const dto: CreateMarketDto = {
        name: 'United States',
        countries: ['US'],
        currency: 'USD',
        isPrimary: true,
      };

      const updateManySpy = jest.spyOn(databaseService.repositories.marketModel, 'updateMany').mockResolvedValue({} as any);
      jest.spyOn(databaseService.repositories.storeModel, 'findById').mockResolvedValue(mockStore);
      jest.spyOn(databaseService.repositories.marketModel, 'create').mockResolvedValue(mockMarket as MarketDocument);

      await service.create('store123', dto);

      expect(updateManySpy).toHaveBeenCalledWith(
        { storeId: 'store123', isPrimary: true, isDelete: false },
        { isPrimary: false },
      );
    });
  });

  describe('findAll', () => {
    it('should return all markets for a store', async () => {
      const mockMarkets = [mockMarket, { ...mockMarket, _id: 'market456', name: 'Europe' }];
      jest.spyOn(databaseService.repositories.marketModel, 'find').mockReturnValue({
        sort: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(mockMarkets) }),
      } as any);

      const result = await service.findAll('store123');

      expect(result).toEqual(mockMarkets);
      expect(databaseService.repositories.marketModel.find).toHaveBeenCalledWith({ storeId: 'store123', isDelete: false });
    });
  });

  describe('findOne', () => {
    it('should return a market by ID', async () => {
      jest.spyOn(databaseService.repositories.marketModel, 'findOne').mockResolvedValue(mockMarket as MarketDocument);

      const result = await service.findOne('store123', 'market123');

      expect(result).toEqual(mockMarket);
      expect(databaseService.repositories.marketModel.findOne).toHaveBeenCalledWith({
        _id: 'market123',
        storeId: 'store123',
        isDelete: false,
      });
    });

    it('should throw NotFoundException if market not found', async () => {
      jest.spyOn(databaseService.repositories.marketModel, 'findOne').mockResolvedValue(null);

      await expect(service.findOne('store123', 'market123')).rejects.toThrow(NotFoundException);
    });
  });

  describe('update', () => {
    it('should update a market successfully', async () => {
      const dto: UpdateMarketDto = {
        name: 'United States (Updated)',
      };

      const updatedMarket = { ...mockMarket, name: 'United States (Updated)' };
      jest.spyOn(databaseService.repositories.marketModel, 'findOne').mockResolvedValue(mockMarket as MarketDocument);
      jest.spyOn(databaseService.repositories.marketModel, 'findOneAndUpdate').mockResolvedValue(updatedMarket as MarketDocument);

      const result = await service.update('store123', 'market123', dto);

      expect(result.name).toBe('United States (Updated)');
      expect(databaseService.repositories.marketModel.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: 'market123', storeId: 'store123', isDelete: false },
        { $set: dto },
        { new: true },
      );
    });

    it('should throw NotFoundException if market does not exist', async () => {
      const dto: UpdateMarketDto = { name: 'Updated' };
      jest.spyOn(databaseService.repositories.marketModel, 'findOne').mockResolvedValue(null);

      await expect(service.update('store123', 'market123', dto)).rejects.toThrow(NotFoundException);
    });

    it('should validate currency if being changed', async () => {
      const dto: UpdateMarketDto = { currency: 'EUR' };
      jest.spyOn(databaseService.repositories.marketModel, 'findOne').mockResolvedValue(mockMarket as MarketDocument);
      jest.spyOn(databaseService.repositories.marketModel, 'findOneAndUpdate').mockResolvedValue(mockMarket as MarketDocument);

      await service.update('store123', 'market123', dto);

      expect(adminConfigService.getEnabledCurrencies).toHaveBeenCalled();
    });

    it('should throw BadRequestException if new currency is not enabled', async () => {
      const dto: UpdateMarketDto = { currency: 'XXX' };
      jest.spyOn(databaseService.repositories.marketModel, 'findOne').mockResolvedValue(mockMarket as MarketDocument);
      jest.spyOn(adminConfigService, 'getEnabledCurrencies').mockResolvedValue(mockEnabledCurrencies);

      await expect(service.update('store123', 'market123', dto)).rejects.toThrow(BadRequestException);
    });
  });

  describe('remove', () => {
    it('should soft delete a market', async () => {
      jest.spyOn(databaseService.repositories.marketModel, 'findOne').mockResolvedValue(mockMarket as MarketDocument);
      jest.spyOn(databaseService.repositories.marketModel, 'updateOne').mockResolvedValue({} as any);

      await service.remove('store123', 'market123');

      expect(databaseService.repositories.marketModel.updateOne).toHaveBeenCalledWith(
        { _id: 'market123' },
        { isDelete: true },
      );
    });

    it('should throw NotFoundException if market does not exist', async () => {
      jest.spyOn(databaseService.repositories.marketModel, 'findOne').mockResolvedValue(null);

      await expect(service.remove('store123', 'market123')).rejects.toThrow(NotFoundException);
    });
  });

  describe('getPrimaryMarket', () => {
    it('should return the primary market for a store', async () => {
      jest.spyOn(databaseService.repositories.marketModel, 'findOne').mockReturnValue({ lean: () => Promise.resolve(mockMarket) } as any);

      const result = await service.getPrimaryMarket('store123');

      expect(result).toEqual(mockMarket);
      expect(databaseService.repositories.marketModel.findOne).toHaveBeenCalledWith({
        storeId: 'store123',
        isPrimary: true,
        isDelete: false,
      });
    });

    it('should return null if no primary market exists', async () => {
      jest.spyOn(databaseService.repositories.marketModel, 'findOne').mockReturnValue({ lean: () => Promise.resolve(null) } as any);

      expect(await service.getPrimaryMarket('store123')).toBeNull();
    });
  });

  describe('getMarketForCountry', () => {
    const us = { ...mockMarket, _id: 'us', countries: ['US'], isActive: true, isPrimary: false };
    const home = { ...mockMarket, _id: 'home', countries: ['PK'], isActive: true, isPrimary: true };
    const stub = (markets: any[]) =>
      jest.spyOn(databaseService.repositories.marketModel, 'find').mockReturnValue({ lean: () => Promise.resolve(markets) } as any);

    it('should return the market that lists the country', async () => {
      stub([home, us]);
      const result = await service.getMarketForCountry('store123', 'us');
      expect((result as any)._id).toBe('us');
      expect(databaseService.repositories.marketModel.find).toHaveBeenCalledWith({ storeId: 'store123', isActive: true, isDelete: false });
    });

    it('should fall back to the primary market for an unlisted country', async () => {
      stub([home, us]);
      expect(((await service.getMarketForCountry('store123', 'XX')) as any)._id).toBe('home');
    });

    it('should return null when no market matches and none is primary', async () => {
      stub([us]);
      expect(await service.getMarketForCountry('store123', 'XX')).toBeNull();
    });
  });

  describe('getPublicMarkets', () => {
    it('exposes only public fields and always offers English', async () => {
      const m = { _id: 'm1', storeId: 'store123', name: 'Pakistan', countries: ['PK'], currency: 'PKR', languages: ['ur'], isPrimary: true, isActive: true, secret: 'x', pricingRule: { type: 'percentage', percentageAdjustment: 5 } };
      jest.spyOn(databaseService.repositories.marketModel, 'find').mockReturnValue({ sort: () => ({ lean: () => Promise.resolve([m]) }) } as any);
      const result: any = await service.getPublicMarkets('store123');
      expect(result.languages).toEqual(['en', 'ur']);
      expect(result.markets[0]).toEqual({
        id: 'm1', name: 'Pakistan', countries: ['PK'], currency: 'PKR', languages: ['ur'], isPrimary: true, subfolder: null, domain: null,
        pricingRule: { type: 'percentage', percentageAdjustment: 5, useRounding: false, roundingRule: 'nearest', conversionFee: null },
      });
    });
  });
});
