/* eslint-disable prettier/prettier */
import { ConflictException } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import { IdempotencyInterceptor } from './idempotency.interceptor';

function setup(existing: any, opts: { takeover?: any; createError?: any } = {}) {
  const model: any = {
    findOne: jest.fn().mockReturnValue({ lean: () => Promise.resolve(existing) }),
    create: jest.fn().mockImplementation(() => (opts.createError ? Promise.reject(opts.createError) : Promise.resolve({}))),
    findOneAndUpdate: jest.fn().mockResolvedValue(opts.takeover ?? null),
    updateOne: jest.fn().mockResolvedValue({}),
    deleteOne: jest.fn().mockResolvedValue({}),
  };
  const interceptor = new IdempotencyInterceptor({ repositories: { idempotencyRecordModel: model } } as any);
  const handler = jest.fn().mockReturnValue(of({ ok: true }));
  const ctx: any = { switchToHttp: () => ({ getRequest: () => ({ headers: { 'idempotency-key': 'k' }, user: { userId: 'u' }, method: 'POST', route: { path: '/x' }, url: '/x' }) }) };
  return { model, interceptor, handler, ctx };
}

describe('IdempotencyInterceptor', () => {
  it('replays the stored response for a completed key without running the handler', async () => {
    const { interceptor, handler, ctx } = setup({ status: 'completed', responseBody: { cached: true } });
    expect(await lastValueFrom(await interceptor.intercept(ctx, { handle: handler }))).toEqual({ cached: true });
    expect(handler).not.toHaveBeenCalled();
  });

  it('answers 409 while a young claim is still in flight', async () => {
    const { interceptor, handler, ctx } = setup({ status: 'in_progress' });
    await expect(lastValueFrom(interceptor.intercept(ctx, { handle: handler }))).rejects.toBeInstanceOf(ConflictException);
    expect(handler).not.toHaveBeenCalled();
  });

  it('takes over an abandoned (stale) in-progress claim so a retry is not locked out for 24h', async () => {
    const { model, interceptor, handler, ctx } = setup({ status: 'in_progress' }, { takeover: { key: 'k' } });
    expect(await lastValueFrom(interceptor.intercept(ctx, { handle: handler }))).toEqual({ ok: true });
    expect(handler).toHaveBeenCalledTimes(1);
    const filter = model.findOneAndUpdate.mock.calls[0][0];
    expect(filter.status).toBe('in_progress');
    expect(filter.updatedAt.$lt).toBeInstanceOf(Date);
  });

  it('treats a lost insert race as in-flight (409)', async () => {
    const { interceptor, handler, ctx } = setup(null, { createError: { code: 11000 } });
    await expect(lastValueFrom(interceptor.intercept(ctx, { handle: handler }))).rejects.toBeInstanceOf(ConflictException);
  });

  it('is a transparent no-op without the header (backward compatible)', async () => {
    const { interceptor, handler } = setup(null);
    const ctx: any = { switchToHttp: () => ({ getRequest: () => ({ headers: {} }) }) };
    expect(await lastValueFrom(interceptor.intercept(ctx, { handle: handler }))).toEqual({ ok: true });
  });
});
