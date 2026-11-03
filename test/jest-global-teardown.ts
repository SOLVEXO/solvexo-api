export default async function globalTeardown() {
  const server = (globalThis as any).__TEST_MONGO__;
  if (server) await server.stop();
}
