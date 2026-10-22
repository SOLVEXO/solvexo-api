/* eslint-disable prettier/prettier */
import { INestApplication, ExecutionContext, CallHandler } from '@nestjs/common';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { StoreThemeController } from './store-theme.controller';
import { StoreThemeService } from './store-theme.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';

// Real HTTP routing + real ValidationPipe + real DTO validation for the Brand Kit
// endpoints, with auth guards stubbed and the service mocked (no database needed).
describe('Brand Kit HTTP routes (StoreThemeController)', () => {
  let app: INestApplication;
  const service = {
    getBrandKit: jest.fn().mockResolvedValue({ success: true, data: null }),
    saveBrandKit: jest.fn().mockResolvedValue({ success: true, data: {} }),
    setBrandKitLocked: jest.fn().mockResolvedValue({ success: true, data: { locked: true } }),
  };
  let user: any;

  beforeAll(async () => {
    const allow = { canActivate: (ctx: ExecutionContext) => { ctx.switchToHttp().getRequest().user = user; return true; } };
    const moduleRef = await Test.createTestingModule({
      controllers: [StoreThemeController],
      providers: [{ provide: StoreThemeService, useValue: service }],
    })
      .overrideGuard(JwtAuthGuard).useValue(allow)
      .overrideGuard(RolesGuard).useValue({ canActivate: () => true })
      .overrideGuard(PermissionsGuard).useValue({ canActivate: () => true })
      .overrideInterceptor(IdempotencyInterceptor).useValue({ intercept: (_ctx: ExecutionContext, next: CallHandler) => next.handle() })
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });
  afterAll(async () => { await app.close(); });
  beforeEach(() => { jest.clearAllMocks(); user = { userId: 'seller-1', role: 'seller' }; });

  const good = { primaryColor: '#e20303', accentColor: '#112233', locked: true };

  it('GET brand-kit reads the kit for the calling seller', async () => {
    await request(app.getHttpServer()).get('/api/store-theme/store-1/brand-kit').expect(200);
    expect(service.getBrandKit).toHaveBeenCalledWith('store-1', 'seller-1');
  });

  it('PUT brand-kit accepts a valid kit and forwards the ?instance= theme row', async () => {
    await request(app.getHttpServer()).put('/api/store-theme/store-1/brand-kit?instance=inst-9').send({ ...good, bgColor: null, saleColor: '#cc0000' }).expect(200);
    expect(service.saveBrandKit).toHaveBeenCalledWith('store-1', 'seller-1', expect.objectContaining({ primaryColor: '#e20303', saleColor: '#cc0000', locked: true }), 'inst-9');
  });

  it.each([
    ['a non-hex primary colour', { ...good, primaryColor: 'red' }],
    ['a script-looking colour', { ...good, accentColor: 'url(javascript:alert(1))' }],
    ['a missing primary colour', { accentColor: '#112233', locked: true }],
    ['a non-boolean locked flag', { ...good, locked: 'yes' }],
  ])('PUT brand-kit rejects %s with 400 and never reaches the service', async (_label, body) => {
    await request(app.getHttpServer()).put('/api/store-theme/store-1/brand-kit').send(body).expect(400);
    expect(service.saveBrandKit).not.toHaveBeenCalled();
  });

  it('PATCH brand-kit/lock flips only the lock flag (own route, not swallowed by another)', async () => {
    await request(app.getHttpServer()).patch('/api/store-theme/store-1/brand-kit/lock').send({ locked: false }).expect(200);
    expect(service.setBrandKitLocked).toHaveBeenCalledWith('store-1', 'seller-1', false);
    expect(service.saveBrandKit).not.toHaveBeenCalled();
  });

  it('PATCH brand-kit/lock rejects a non-boolean body', async () => {
    await request(app.getHttpServer()).patch('/api/store-theme/store-1/brand-kit/lock').send({ locked: 'maybe' }).expect(400);
    expect(service.setBrandKitLocked).not.toHaveBeenCalled();
  });

  it('a staff session is scoped to its owning seller (actingSellerId), not its own staff id', async () => {
    user = { userId: 'staff-7', sellerId: 'seller-1', role: 'staff', storeId: 'store-1' };
    await request(app.getHttpServer()).get('/api/store-theme/store-1/brand-kit').expect(200);
    expect(service.getBrandKit).toHaveBeenCalledWith('store-1', 'seller-1');
  });
});
