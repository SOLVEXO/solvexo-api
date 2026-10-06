/* eslint-disable prettier/prettier */
import { importSubscribersCsv, SubscriberState } from './subscriber-bulk-import';

function setup(initial: Record<string, SubscriberState> = {}) {
  const states: Record<string, SubscriberState> = { ...initial };
  const subscribed: string[] = [];
  const deps = {
    getState: async (email: string) => states[email] ?? 'none',
    subscribe: async (email: string) => { subscribed.push(email); states[email] = 'active'; return {}; },
  };
  return { deps, subscribed };
}

describe('subscribers bulk import', () => {
  it('adds valid emails and reports invalid ones', async () => {
    const { deps, subscribed } = setup();
    const res = await importSubscribersCsv(deps, 'Email\na@x.com\nbad-email\nB@x.com');
    expect(res.data.created).toBe(2);
    expect(res.data.failedCount).toBe(1);
    expect(res.data.failed[0].error).toContain('Email');
    expect(subscribed).toEqual(['a@x.com', 'b@x.com']);
  });

  it('skips already subscribed addresses', async () => {
    const { deps, subscribed } = setup({ 'a@x.com': 'active' });
    const res = await importSubscribersCsv(deps, 'Email\na@x.com');
    expect(res.data.skipped).toBe(1);
    expect(res.data.skippedRows[0].note).toBe('Already subscribed');
    expect(subscribed.length).toBe(0);
  });

  it('never re-adds an unsubscribed address', async () => {
    const { deps, subscribed } = setup({ 'a@x.com': 'unsubscribed' });
    const res = await importSubscribersCsv(deps, 'Email\na@x.com');
    expect(res.data.skipped).toBe(1);
    expect(res.data.skippedRows[0].note).toContain('Previously unsubscribed');
    expect(subscribed.length).toBe(0);
  });

  it('fails the second occurrence of the same email in one file', async () => {
    const { deps, subscribed } = setup();
    const res = await importSubscribersCsv(deps, 'Email\na@x.com\nA@x.com');
    expect(res.data.created).toBe(1);
    expect(res.data.failedCount).toBe(1);
    expect(subscribed.length).toBe(1);
  });

  it('requires the Email column', async () => {
    const { deps } = setup();
    await expect(importSubscribersCsv(deps, 'Mail\na@x.com')).rejects.toThrow('Email');
  });
});
