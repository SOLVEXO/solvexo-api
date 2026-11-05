/* eslint-disable prettier/prettier */
import 'reflect-metadata';
import { CanActivate, ExecutionContext, INestApplication, Injectable, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { makePaymentsFixture, setKybKeys } from '../payments-core/testing/payments-harness';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { DatabaseService } from '../database/databaseservice';
import { KybAdminController } from './kyb-admin.controller';
import { KybController } from './kyb.controller';
import { KybAdminService } from './kyb-admin.service';
import { KybMaintenanceService } from './kyb-maintenance.service';
import { KybService } from './kyb.service';

jest.setTimeout(120_000);

/** Stands in for the JWT strategy: the identity comes from a test header; no header = unauthenticated. */
@Injectable()
class FakeJwtGuard implements CanActivate {
  canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    const raw = req.headers['x-test-user'];
    if (!raw) return false;
    req.user = JSON.parse(String(raw));
    return true;
  }
}

describe('KYB HTTP: admin endpoints are admin-only; owner endpoints are seller-only', () => {
  let app: INestApplication; let x: Awaited<ReturnType<typeof makePaymentsFixture>>;
  const as = (u: any) => ({ 'x-test-user': JSON.stringify(u) });
  const ADMIN = { userId: 'adm-1', role: 'admin' };
  const TEAM_REVIEWER = { userId: 'adm-2', role: 'admin', teamAdmin: true, permissions: ['kyb.review'] };
  const TEAM_OTHER = { userId: 'adm-3', role: 'admin', teamAdmin: true, permissions: ['marketplace.manage'] };

  beforeAll(async () => {
    setKybKeys({ v1: true, current: '1' });
    x = await makePaymentsFixture({ verified: false });
    const mod = await Test.createTestingModule({
      controllers: [KybAdminController, KybController],
      providers: [
        { provide: KybAdminService, useValue: x.kybAdmin }, { provide: KybMaintenanceService, useValue: x.maintenance }, { provide: KybService, useValue: x.kyb },
        { provide: DatabaseService, useValue: {} },
      ],
    }).overrideGuard(JwtAuthGuard).useClass(FakeJwtGuard).compile();
    app = mod.createNestApplication(); app.useGlobalPipes(new ValidationPipe({ transform: false })); await app.init();
  });
  afterAll(async () => { await app.close(); await x.stop(); setKybKeys({ v1: false, current: null }); });

  const ADMIN_ROUTES: Array<[string, string, any?]> = [
    ['get', '/api/admin/kyb/submissions'],
    ['get', '/api/admin/kyb/submissions/s1'],
    ['get', '/api/admin/kyb/submissions/s1/documents/d1/url'],
    ['get', '/api/admin/kyb/submissions/s1/documents/d1/download'],
    ['post', '/api/admin/kyb/submissions/s1/approve', {}],
    ['post', '/api/admin/kyb/submissions/s1/reject', { reason: 'not enough detail given' }],
    ['put', '/api/admin/kyb/submissions/s1/sub-merchant', { providerKey: 'mock', ref: 'SM-1' }],
    ['get', '/api/admin/kyb/submissions/s1/audit'],
    ['get', '/api/admin/kyb/retention'],
    ['put', '/api/admin/kyb/retention', { afterClosureDays: 400 }],
    ['post', '/api/admin/kyb/retention/run', {}],
  ];

  it('a seller, a buyer, a POS-staff user and an unauthenticated caller get 403 on EVERY admin KYB endpoint', async () => {
    for (const who of [{ userId: 'u', role: 'seller' }, { userId: 'b', role: 'buyer' }, { userId: 's', role: 'staff', storeId: 'x', permissions: ['kyb.review'] }, null]) {
      for (const [m, path, body] of ADMIN_ROUTES) {
        let r = (request(app.getHttpServer()) as any)[m](path); if (who) r = r.set(as(who)); if (body) r = r.send(body);
        const res = await r; expect({ who: who?.role ?? 'anonymous', path, status: res.status }).toEqual({ who: who?.role ?? 'anonymous', path, status: 403 });
      }
    }
  });

  it('a team admin needs the specific permission: kyb.review for review routes, kyb.settings for retention; the owner/super admin passes', async () => {
    await request(app.getHttpServer()).get('/api/admin/kyb/submissions').set(as(TEAM_OTHER)).expect(403);
    await request(app.getHttpServer()).get('/api/admin/kyb/submissions').set(as(TEAM_REVIEWER)).expect(200);
    await request(app.getHttpServer()).get('/api/admin/kyb/retention').set(as(TEAM_REVIEWER)).expect(403); // reviewers cannot touch retention
    await request(app.getHttpServer()).get('/api/admin/kyb/retention').set(as(ADMIN)).expect(200);
    await request(app.getHttpServer()).get('/api/admin/kyb/submissions').set(as(ADMIN)).expect(200);
  });

  it('end to end over HTTP: owner fills and submits; admin lists, views (audited), approves and sets the sub-merchant', async () => {
    const { sellerId, storeId } = x.s;
    const OWNER = { userId: sellerId, role: 'seller' };
    await request(app.getHttpServer()).get(`/api/kyb/${storeId}`).set(as(ADMIN)).expect(403); // admins are not owners
    const put = await request(app.getHttpServer()).put(`/api/kyb/${storeId}/draft`).set(as(OWNER)).send({ businessType: 'sole_proprietor', legalBusinessName: 'Ali Traders', businessAddress: 'Shop 1, Lahore', contact: { name: 'Ali', email: 'ali@x.pk', phone: '0300' }, bankName: 'HBL', cnic: '3520212345671', iban: 'PK36SCBL0000001123456702', accountTitle: 'Ali Traders' }).expect(200);
    expect(put.body.data).toMatchObject({ status: 'draft', cnicMasked: '•••••••••5671' });
    await request(app.getHttpServer()).put(`/api/kyb/${storeId}/draft`).set(as(OWNER)).send({ evil: 'field', iban: 'PK36SCBL0000001123456702' }).expect(200); // unknown field stripped
    await request(app.getHttpServer()).put(`/api/kyb/${storeId}/draft`).set(as(OWNER)).send({ iban: 'bad' }).expect(400);
    await x.kyb.uploadDocument(sellerId, storeId, 'owner_cnic', { originalname: 'a.pdf', mimetype: 'application/pdf', size: 10, buffer: Buffer.from('x') } as any);
    await x.kyb.uploadDocument(sellerId, storeId, 'bank_proof', { originalname: 'b.pdf', mimetype: 'application/pdf', size: 10, buffer: Buffer.from('x') } as any);
    await request(app.getHttpServer()).post(`/api/kyb/${storeId}/submit`).set(as(OWNER)).expect(201);
    const list = await request(app.getHttpServer()).get('/api/admin/kyb/submissions').set(as(ADMIN)).expect(200);
    expect(list.body.data.items).toHaveLength(1);
    const det = await request(app.getHttpServer()).get(`/api/admin/kyb/submissions/${storeId}`).set(as(ADMIN)).expect(200);
    expect(det.body.data).toMatchObject({ iban: 'PK36SCBL0000001123456702', cnic: '3520212345671', status: 'submitted' });
    const docId = det.body.data.documents[0].id;
    const url = await request(app.getHttpServer()).get(`/api/admin/kyb/submissions/${storeId}/documents/${docId}/url`).set(as(ADMIN)).expect(200);
    expect(url.body.data.url).toContain('https://signed.example/');
    const dl = await request(app.getHttpServer()).get(`/api/admin/kyb/submissions/${storeId}/documents/${docId}/download`).set(as(ADMIN)).expect(200);
    expect(dl.headers['content-disposition']).toContain('attachment'); expect(dl.headers['cache-control']).toBe('no-store');
    await request(app.getHttpServer()).post(`/api/admin/kyb/submissions/${storeId}/reject`).set(as(ADMIN)).send({ reason: 'short' }).expect(400);
    await request(app.getHttpServer()).post(`/api/admin/kyb/submissions/${storeId}/approve`).set(as(ADMIN)).send({ note: 'ok' }).expect(201);
    await request(app.getHttpServer()).put(`/api/admin/kyb/submissions/${storeId}/sub-merchant`).set(as(ADMIN)).send({ providerKey: 'mock', ref: 'SM-555' }).expect(200);
    const audit = await request(app.getHttpServer()).get(`/api/admin/kyb/submissions/${storeId}/audit?limit=50`).set(as(ADMIN)).expect(200);
    const acts = audit.body.data.items.map((a: any) => a.action);
    expect(acts).toEqual(expect.arrayContaining(['kyb_viewed', 'kyb_document_viewed', 'kyb_document_downloaded', 'kyb_approved', 'kyb_sub_merchant_set']));
    expect(await x.gate.isEnabled(storeId)).toBe(true);
  });
});
