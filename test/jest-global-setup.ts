import { MongoMemoryReplSet } from 'mongodb-memory-server';

/**
 * ONE real mongod for the whole jest run (instead of one per integration suite): each suite gets its own
 * database on it (see src/pos/testing/mongo-harness.ts). Starting a mongod per suite on top of N ts-jest
 * workers is what used to exhaust the machine. The URI travels to the workers via the environment.
 */
export default async function globalSetup() {
  // A single-node REPLICA SET (not a standalone mongod): production is Atlas, so the transactional code paths (sale + payment +
  // audit written atomically) must run under real multi-document transactions in the tests too.
  const server = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.TEST_MONGO_URI = server.getUri();
  (globalThis as any).__TEST_MONGO__ = server;
}
