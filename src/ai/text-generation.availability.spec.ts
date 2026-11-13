import { TextGenerationService } from './text-generation.service';

/** Canned (mock) text is never sold to real sellers; a missing key never crashes the API. Plain describe/it/expect (also runs on scripts/mini-jest.cjs). */
const config = (env: Record<string, string>) => ({ get: (k: string) => env[k] }) as any;

async function withoutJestWorker<T>(fn: () => Promise<T> | T): Promise<T> {
  const saved = process.env.JEST_WORKER_ID;
  delete process.env.JEST_WORKER_ID;
  try { return await fn(); } finally { if (saved !== undefined) process.env.JEST_WORKER_ID = saved; }
}

describe('AI text availability', () => {
  it('claude with a key is available', async () => {
    await withoutJestWorker(() => {
      const s = new TextGenerationService(config({ AI_PROVIDER: 'claude', ANTHROPIC_API_KEY: 'sk-test', NODE_ENV: 'production' }));
      expect(s.isAvailable).toBe(true);
      s.assertAvailable();
    });
  });

  it('claude without a key does not crash the API; it is simply not available, and says so', async () => {
    await withoutJestWorker(async () => {
      const s = new TextGenerationService(config({ AI_PROVIDER: 'claude', NODE_ENV: 'production' }));
      expect(s.isAvailable).toBe(false);
      expect(() => s.assertAvailable()).toThrow('not available yet');
      await expect(s.generate({ system: 's', prompt: 'p' } as any)).rejects.toThrow('not switched on');
    });
  });

  it('mock text is refused in production, so a seller is never charged for canned text', async () => {
    await withoutJestWorker(() => {
      expect(new TextGenerationService(config({ NODE_ENV: 'production' })).isAvailable).toBe(false);
      expect(new TextGenerationService(config({ AI_PROVIDER: 'mock', NODE_ENV: 'production' })).isAvailable).toBe(false);
      expect(() => new TextGenerationService(config({ NODE_ENV: 'production' })).assertAvailable()).toThrow('No credits were used');
    });
  });

  it('mock text is allowed for development, tests and an explicit demo switch', async () => {
    await withoutJestWorker(() => {
      expect(new TextGenerationService(config({ NODE_ENV: 'development' })).isAvailable).toBe(true);
      expect(new TextGenerationService(config({ NODE_ENV: 'test' })).isAvailable).toBe(true);
      expect(new TextGenerationService(config({ NODE_ENV: 'production', AI_ALLOW_MOCK: 'true' })).isAvailable).toBe(true);
    });
  });
});
