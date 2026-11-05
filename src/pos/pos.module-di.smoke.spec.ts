/* eslint-disable prettier/prettier */
import { Test } from '@nestjs/testing';
import { PosController } from './pos.controller';
import { PaymentsCoreController } from '../payments-core/payments-core.controller';
import { PaymentsWebhookController } from '../payments-core/payments-webhook.controller';
import { KybController } from '../kyb/kyb.controller';
import { KybAdminController } from '../kyb/kyb-admin.controller';

/**
 * The whole application's module graph resolves with the 5D wiring (PosController now injects InventoryService,
 * PosPlansService and PosDeviceService; PosAuthGuard needs RedisService/DatabaseService/Reflector). `compile()` builds
 * every provider but runs no lifecycle hooks (no crons, no listening, no Redis connect). Needs a Mongo on MONGO_URI
 * (a throw-away local database whose name contains `di_smoke`).
 *
 * RUN IT WITH `npm run test:di` (in band, 6 GB heap; `DI_SMOKE_MONGO_URI` overrides the default local URI). WHY NOT IN THE PARALLEL JEST RUN:
 * importing AppModule pulls the whole codebase (hundreds of files) through ts-jest in ONE process — peak ≈ 1.2 GB resident, 32 s —
 * which crashed a 2-worker run with "Jest worker ran out of memory". AppModule is therefore imported lazily INSIDE the test: when the
 * test is skipped (no local MONGO_URI) the file costs nothing and the default `npx jest` gate stays light.
 */
jest.setTimeout(180_000);
const uri = process.env.MONGO_URI ?? '';
const run = uri.includes('127.0.0.1') && uri.includes('di_smoke') ? it : it.skip; // never point this at a real database
run('AppModule resolves, including the POS controller', async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { AppModule } = require('../app.module'); // lazy (a static import loads the whole app even when skipped): see the note above
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  expect(mod.get(PosController, { strict: false })).toBeTruthy();
  // G2.1 / G2.2: the payment and KYB controllers (and everything they inject, incl. the payment-provider registry and the KYB gate) resolve too
  for (const c of [PaymentsCoreController, PaymentsWebhookController, KybController, KybAdminController]) expect(mod.get(c, { strict: false })).toBeTruthy();
  await mod.close().catch(() => {}); // RedisService.onModuleDestroy throws when it never connected
});
