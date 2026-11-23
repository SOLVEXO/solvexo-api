/* eslint-disable prettier/prettier */
import { Body, Controller, INestApplication, Param, Patch, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ActivityLogService } from './activity-log.service';
import { AuditStoreWrites } from './audit-store-writes';
import { RequestActorInterceptor } from './activity-actor.context';
import { APP_INTERCEPTOR } from '@nestjs/core';

const STORE = '6ac5cae50f9f63df82763e4f';
const OWNER = '6ac5cae50f9f63df82763e00';
const STAFF = '6ac5cae50f9f63df82763e11';

/** Same route shapes the real controllers use (storeId in the class path, or first in the method path). */
@Controller('api/shipping-zones/store/:storeId')
@AuditStoreWrites('shipping_zone', 'settings')
class ZonesController {
  @Post('import') imp() { return { success: true, data: { created: 3, updated: 0, skipped: 1, failedCount: 0 } }; }
  @Patch(':zoneId') upd(@Param('zoneId') _z: string, @Body() _b: any) { return { ok: true }; }
}

@Controller('api/store-faq')
@AuditStoreWrites('faq', 'marketing')
class FaqController {
  @Post(':storeId/import') imp() { return { created: 2, updated: 0, skipped: 0, failedCount: 1 }; }
}

jest.setTimeout(120000);

describe('@AuditStoreWrites on real route shapes', () => {
  let app: INestApplication;
  let logged: any[];
  let rowLogger: ActivityLogService;

  const asUser = (user: any) => (req: any, _res: any, next: any) => { req.user = user; next(); };

  async function boot(user: any) {
    logged = [];
    const activity: any = { log: jest.fn(async (e: any) => { logged.push(e); }) };
    const moduleRef = await Test.createTestingModule({
      controllers: [ZonesController, FaqController],
      providers: [{ provide: ActivityLogService, useValue: activity }, { provide: APP_INTERCEPTOR, useClass: RequestActorInterceptor }],
    }).compile();
    app = moduleRef.createNestApplication();
    app.use(asUser(user));
    await app.init();
    rowLogger = activity;
  }

  afterEach(async () => { await app?.close(); });

  it('shipping-zones import: storeId from the class path, import counts in the entry', async () => {
    await boot({ role: 'seller', userId: OWNER });
    await request(app.getHttpServer()).post(`/api/shipping-zones/store/${STORE}/import`).expect(201);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ storeId: STORE, action: 'shipping_zone_imported', force: true, actorId: OWNER });
    expect(logged[0].description).toContain('3 created');
  });

  it('FAQ import: storeId is the first path segment of the method', async () => {
    await boot({ role: 'staff', userId: STAFF, sellerId: OWNER });
    await request(app.getHttpServer()).post(`/api/store-faq/${STORE}/import`).expect(201);
    expect(logged[0]).toMatchObject({ storeId: STORE, action: 'faq_imported', actorId: STAFF, actorRole: 'staff' });
  });

  it('a normal update is logged with the verb "updated" and the target id', async () => {
    await boot({ role: 'seller', userId: OWNER });
    await request(app.getHttpServer()).patch(`/api/shipping-zones/store/${STORE}/zoneABC`).send({ price: 5 }).expect(200);
    expect(logged[0]).toMatchObject({ action: 'shipping_zone_updated', targetId: 'zoneABC' });
    expect(logged[0].metadata.fields).toEqual(['price']);
  });
});
