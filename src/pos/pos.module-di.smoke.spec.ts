/* eslint-disable prettier/prettier */
import { Test } from '@nestjs/testing';
import { AppModule } from '../app.module';
import { PosController } from './pos.controller';

/**
 * The whole application's module graph resolves with the 5D wiring (PosController now injects InventoryService,
 * PosPlansService and PosDeviceService; PosAuthGuard needs RedisService/DatabaseService/Reflector). `compile()` builds
 * every provider but runs no lifecycle hooks (no crons, no listening, no Redis connect). Needs a Mongo on MONGO_URI
 * (point it at a throw-away local database): `MONGO_URI=mongodb://127.0.0.1:27017/solvexo_di_smoke`.
 */
jest.setTimeout(180_000);
const run = process.env.MONGO_URI?.includes('127.0.0.1') ? it : it.skip;
run('AppModule resolves, including the POS controller', async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  expect(mod.get(PosController, { strict: false })).toBeTruthy();
  await mod.close().catch(() => {}); // RedisService.onModuleDestroy throws when it never connected
});
